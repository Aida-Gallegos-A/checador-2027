// Expediente en PDF para una inspección de la STPS o un procedimiento laboral.
// Reúne, para un trabajador y un periodo: convenio firmado, resúmenes semanales y su firma,
// cada registro con su evidencia (fotos verificadas contra su huella), correcciones con su historial
// y los hashes de cada evento para que un tercero pueda verificar la cadena.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { dirAlmacen } from './lib/rutas.js';
import { agregarEvento, verificarCadena } from './lib/cadena.js';
import { inicioDelDiaLocal, LUGARES_REMOTOS, lugarDe, lunesDe, sumarDias, UMBRAL_NOM037 } from './lib/jornada.js';
import { estadoFirmas, listarCorrecciones, semanasDeEmpleados } from './servicios.js';

const C = { marca: '#123D33', acento: '#15805C', texto: '#18211E', tenue: '#5D6964', borde: '#DFE5E1', fondo: '#F3F6F4', critico: '#B42318', alerta: '#B45309' };
const MARGEN = 50;
const canal = (c) => ({ whatsapp: 'WhatsApp', sms: 'SMS' }[c] ?? c ?? '-');
const MODALIDAD = { presencial: 'Presencial', campo: 'Campo', home_office: 'Home office', hibrido: 'Híbrido (oficina y a distancia, sin días fijos)' };
const TIPO = { entrada: 'Entrada', salida_comida: 'Salida a comer', regreso_comida: 'Regreso de comer', salida: 'Salida' };
const BANDERA = {
  sin_foto: 'sin foto', hora_dispositivo_no_cuadra: 'reloj del dispositivo desfasado', secuencia_irregular: 'fuera de secuencia',
  fuera_de_zona: 'lejos del sitio esperado', sin_conexion: 'enviado sin conexión',
};

export async function generarExpediente(db, empresa, { empleadoId, desde, hasta, generadoPor }) {
  const zona = empresa.zona_horaria;
  const { rows: [emp] } = await db.query(
    `SELECT id, numero, nombre, puesto, telefono, modalidad, tipo_jornada, activo, creado_en FROM empleados WHERE id = $1 AND empresa_id = $2`,
    [empleadoId, empresa.id],
  );
  if (!emp) return null;

  const ini = inicioDelDiaLocal(desde, zona);
  const fin = inicioDelDiaLocal(sumarDias(hasta, 1), zona);
  const fechaHora = (d) => new Date(d).toLocaleString('es-MX', { timeZone: zona, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const hora = (d) => new Date(d).toLocaleTimeString('es-MX', { timeZone: zona, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fecha = (d) => new Date(d).toLocaleDateString('es-MX', { timeZone: zona, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  const fechaCorta = (f) => new Date(`${f}T12:00:00Z`).toLocaleDateString('es-MX', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });

  // ---------- Datos ----------
  const cadena = await verificarCadena(db, empresa.id);

  const { rows: eventos } = await db.query(
    `SELECT id, clase, hora, hora_servidor, datos, prev_hash, hash FROM bitacora
      WHERE empresa_id = $1 AND empleado_id = $2 AND (
        (clase IN ('checada', 'correccion_aprobada') AND hora >= $3 AND hora < $4)
        OR (clase NOT IN ('checada', 'correccion_aprobada') AND hora_servidor >= $3 AND hora_servidor < $4))
      ORDER BY id`,
    [empresa.id, emp.id, ini, fin],
  );
  const checadas = eventos.filter((e) => e.clase === 'checada' || e.clase === 'correccion_aprobada').sort((a, b) => new Date(a.hora) - new Date(b.hora));
  const reemplazadaPor = new Map(eventos.filter((e) => e.clase === 'correccion_aprobada' && e.datos.reemplaza).map((e) => [e.datos.reemplaza, e.id]));

  // Convenio: siempre se incluye el más reciente, aunque se haya firmado antes del periodo.
  const { rows: convEventos } = await db.query(
    `SELECT id, clase, hora_servidor, datos, hash FROM bitacora
      WHERE empresa_id = $1 AND empleado_id = $2
        AND (clase IN ('convenio_enviado', 'convenio_firmado', 'convenio_rechazado') OR (clase = 'recordatorio' AND datos ? 'convenio_id'))
      ORDER BY id`,
    [empresa.id, emp.id],
  );
  const firmaConvenio = [...convEventos].reverse().find((e) => e.clase === 'convenio_firmado');
  const convenio = firmaConvenio
    ? convEventos.find((e) => e.id === firmaConvenio.datos.convenio_id)
    : [...convEventos].reverse().find((e) => e.clase === 'convenio_enviado');
  const respuestaConvenio = convenio && convEventos.find((e) => e.datos.convenio_id === convenio.id && e.clase !== 'recordatorio');
  const recordatoriosConvenio = convenio ? convEventos.filter((e) => e.clase === 'recordatorio' && e.datos.convenio_id === convenio.id) : [];

  const semanas = [];
  for (let l = lunesDe(desde); l <= hasta; l = sumarDias(l, 7)) {
    const [s] = await semanasDeEmpleados(db, empresa, [emp], l);
    const firma = (await estadoFirmas(db, empresa.id, l)).get(emp.id) ?? null;
    semanas.push({ ...s, firma });
  }
  const totales = semanas.reduce((t, s) => ({
    dias: t.dias + s.semana.dias, total: t.total + s.semana.total, ordinarias: t.ordinarias + s.semana.ordinarias,
    dobles: t.dobles + s.semana.extraDobles, triples: t.triples + s.semana.extraTriples,
  }), { dias: 0, total: 0, ordinarias: 0, dobles: 0, triples: 0 });
  const r2 = (n) => Math.round(n * 100) / 100;

  // Lugar de trabajo en el periodo (base para la NOM-037).
  const porLugar = {};
  const diasLugar = {};
  for (const s of semanas) {
    for (const [k, v] of Object.entries(s.semana.horasPorLugar ?? {})) porLugar[k] = (porLugar[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.semana.diasPorLugar ?? {})) diasLugar[k] = (diasLugar[k] ?? 0) + v;
  }
  const horasRemotas = LUGARES_REMOTOS.reduce((n, k) => n + (porLugar[k] ?? 0), 0);
  const pctRemoto = totales.total ? Math.round((horasRemotas / totales.total) * 100) : 0;
  const muestraLugar = ['home_office', 'hibrido'].includes(emp.modalidad) || horasRemotas > 0;
  const LUGAR = { oficina: 'centro de trabajo', casa: 'domicilio', otro: 'otro lugar', campo: 'campo', sin_dato: 'sin dato' };
  const DIA = { oficina: 'en el centro de trabajo', remoto: 'a distancia', mixto: 'mixtos', campo: 'en campo', sin_dato: 'sin dato' };
  const textoLugar = Object.entries(porLugar).filter(([, v]) => v > 0).map(([k, v]) => `${r2(v)} h ${LUGAR[k] ?? k}`).join(' · ');
  const textoDias = Object.entries(diasLugar)
    .map(([k, v]) => (k === 'mixto' ? `${v} ${v === 1 ? 'mixto' : 'mixtos'}` : `${v} ${DIA[k] ?? k}`)).join(' · ');

  const correcciones = (await listarCorrecciones(db, empresa.id))
    .filter((c) => c.empleado_id === emp.id
      && ((new Date(c.hora_propuesta) >= ini && new Date(c.hora_propuesta) < fin) || (new Date(c.solicitada_en) >= ini && new Date(c.solicitada_en) < fin)))
    .reverse();

  const dirFotos = path.join(dirAlmacen(), 'fotos');
  const fotos = checadas
    .filter((e) => e.datos.evidencia?.foto_archivo)
    .map((e) => {
      const ruta = path.join(dirFotos, path.basename(e.datos.evidencia.foto_archivo));
      if (!existsSync(ruta)) return { evento: e, estado: 'no_encontrada' };
      const bytes = readFileSync(ruta);
      const integra = createHash('sha256').update(bytes).digest('hex') === e.datos.evidencia.foto_sha256;
      return { evento: e, estado: integra ? 'integra' : 'alterada', bytes };
    });
  const estadoFoto = new Map(fotos.map((f) => [f.evento.id, f.estado]));

  // ---------- PDF ----------
  const generado = new Date();
  const doc = new PDFDocument({
    size: 'LETTER', margins: { top: MARGEN, bottom: MARGEN + 10, left: MARGEN, right: MARGEN }, bufferPages: true,
    info: { Title: `Expediente de jornada - ${emp.nombre}`, Author: empresa.nombre, Subject: `Registro de jornada ${desde} a ${hasta}`, Creator: 'Checador 2027' },
  });
  const partes = [];
  doc.on('data', (b) => partes.push(b));
  const terminado = new Promise((ok) => doc.on('end', ok));
  const ancho = doc.page.width - MARGEN * 2;

  const espacio = (alto) => { if (doc.y + alto > doc.page.height - MARGEN - 20) doc.addPage(); };
  const titulo = (num, texto) => {
    doc.addPage();
    doc.fillColor(C.acento).font('Helvetica-Bold').fontSize(9).text(`SECCIÓN ${num}`, { characterSpacing: 1 });
    doc.fillColor(C.marca).font('Helvetica-Bold').fontSize(18).text(texto).moveDown(0.6);
  };
  const subtitulo = (t) => { espacio(40); doc.moveDown(0.5).fillColor(C.marca).font('Helvetica-Bold').fontSize(12).text(t).moveDown(0.3); };
  const parrafo = (t, opc = {}) => { doc.fillColor(opc.color ?? C.texto).font(opc.negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(opc.tam ?? 9.5).text(t, { align: 'left', lineGap: 2 }); };
  const nota = (t, color = C.tenue) => { doc.fillColor(color).font('Helvetica-Oblique').fontSize(8.5).text(t, { lineGap: 1.5 }).moveDown(0.4); };

  /** Tabla con salto de página y encabezado repetido. cols: [{t, w, mono?}] (w en fracción del ancho). */
  function tabla(cols, filas, { tam = 8.5 } = {}) {
    const anchos = cols.map((c) => c.w * ancho);
    const pad = 4;
    const altoFila = (celdas, negrita) => Math.max(...celdas.map((v, i) => {
      doc.font(negrita ? 'Helvetica-Bold' : cols[i].mono ? 'Courier' : 'Helvetica').fontSize(tam);
      return doc.heightOfString(String(v ?? ''), { width: anchos[i] - pad * 2 });
    })) + pad * 2;
    const dibujar = (celdas, { encabezado = false, fondo = null, color = C.texto } = {}) => {
      const h = altoFila(celdas, encabezado);
      if (doc.y + h > doc.page.height - MARGEN - 20) { doc.addPage(); if (!encabezado) dibujar(cols.map((c) => c.t), { encabezado: true }); }
      const y = doc.y;
      if (encabezado) doc.rect(MARGEN, y, ancho, h).fill(C.marca);
      else if (fondo) doc.rect(MARGEN, y, ancho, h).fill(fondo);
      let x = MARGEN;
      celdas.forEach((v, i) => {
        doc.fillColor(encabezado ? '#FFFFFF' : (typeof color === 'function' ? color(i) : color))
          .font(encabezado ? 'Helvetica-Bold' : cols[i].mono ? 'Courier' : 'Helvetica').fontSize(tam)
          .text(String(v ?? ''), x + pad, y + pad, { width: anchos[i] - pad * 2 });
        x += anchos[i];
      });
      doc.moveTo(MARGEN, y + h).lineTo(MARGEN + ancho, y + h).lineWidth(0.5).strokeColor(C.borde).stroke();
      doc.x = MARGEN;
      doc.y = y + h;
    };
    dibujar(cols.map((c) => c.t), { encabezado: true });
    filas.forEach((f, i) => {
      const celdas = Array.isArray(f) ? f : f.celdas;
      dibujar(celdas, { fondo: f.fondo ?? (i % 2 ? C.fondo : null), color: f.color ?? C.texto });
    });
    doc.moveDown(0.6);
  }

  const claveValor = (pares) => {
    for (const [k, v] of pares) {
      espacio(16);
      const y = doc.y;
      doc.fillColor(C.tenue).font('Helvetica').fontSize(9).text(k, MARGEN, y, { width: 140 });
      doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(9.5).text(String(v ?? '-'), MARGEN + 150, y, { width: ancho - 150 });
      doc.x = MARGEN;
      doc.moveDown(0.25);
    }
  };

  // ---------- Portada ----------
  doc.rect(0, 0, doc.page.width, 150).fill(C.marca);
  doc.fillColor('#9FDCC2').font('Helvetica-Bold').fontSize(9).text('EXPEDIENTE DE REGISTRO DE JORNADA', MARGEN, 48, { characterSpacing: 1.2 });
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(24).text(emp.nombre, MARGEN, 66, { width: ancho });
  doc.font('Helvetica').fontSize(11).text(`Periodo: ${fechaCorta(desde)} al ${fechaCorta(hasta)}`, MARGEN, 100);
  doc.fontSize(8.5).fillColor('#CFE9DE').text('Art. 132, fracción XXXIV, de la Ley Federal del Trabajo', MARGEN, 118);
  doc.y = 175;
  doc.x = MARGEN;

  claveValor([
    ['Empresa (patrón)', empresa.nombre],
    ['RFC', empresa.rfc ?? 'No capturado'],
    ['Domicilio', empresa.domicilio ?? 'No capturado'],
    ['Trabajador', emp.nombre],
    ['Número de empleado', emp.numero],
    ['Puesto', emp.puesto ?? '-'],
    ['Modalidad', MODALIDAD[emp.modalidad]],
    ['Tipo de jornada', emp.tipo_jornada],
    ['Estado', emp.activo ? 'Activo' : 'Baja'],
    ['Generado', `${fechaHora(generado)} por ${generadoPor}`],
  ]);

  doc.moveDown(0.8);
  const yInt = doc.y;
  doc.rect(MARGEN, yInt, ancho, 78).fill(cadena.integra ? '#E3F1EA' : '#FDECEA');
  doc.fillColor(cadena.integra ? C.acento : C.critico).font('Helvetica-Bold').fontSize(11)
    .text(cadena.integra ? 'Bitácora íntegra: ningún registro fue alterado, borrado ni reordenado' : 'ATENCIÓN: la verificación de la bitácora encontró alteraciones', MARGEN + 12, yInt + 10, { width: ancho - 24 });
  doc.fillColor(C.texto).font('Helvetica').fontSize(8.5)
    .text(`Se verificaron ${cadena.total} eventos de la empresa el ${fechaHora(generado)}; cada evento contiene el hash SHA-256 del anterior; cualquier cambio directo en la base de datos rompe la cadena.`, MARGEN + 12, yInt + 28, { width: ancho - 24 })
    .font('Courier').fontSize(7).text(`Último hash de la cadena: ${cadena.ultimo_hash}`, MARGEN + 12, yInt + 56, { width: ancho - 24 });
  doc.x = MARGEN;
  doc.y = yInt + 92;
  if (!cadena.integra) cadena.problemas.slice(0, 10).forEach((p) => nota(`Evento ${p.id}: ${p.problema}`, C.critico));

  subtitulo('Resumen del periodo');
  const firmadas = semanas.filter((s) => s.firma?.estado === 'firmada').length;
  tabla(
    [{ t: 'Días trabajados', w: 0.16 }, { t: 'Horas totales', w: 0.16 }, { t: 'Ordinarias', w: 0.16 }, { t: 'Extra dobles', w: 0.16 }, { t: 'Extra triples', w: 0.16 }, { t: 'Semanas firmadas', w: 0.2 }],
    [[totales.dias, r2(totales.total), r2(totales.ordinarias), r2(totales.dobles), r2(totales.triples), `${firmadas} de ${semanas.length}`]],
    { tam: 10 },
  );
  claveValor([
    ['Convenio de registro', respuestaConvenio?.clase === 'convenio_firmado' ? `Firmado el ${fechaHora(respuestaConvenio.hora_servidor)}` : respuestaConvenio?.clase === 'convenio_rechazado' ? 'El trabajador manifestó no estar de acuerdo' : convenio ? 'Enviado, pendiente de firma' : 'No enviado'],
    ['Registros en el periodo', `${checadas.length} (${checadas.filter((c) => c.clase === 'correccion_aprobada').length} por corrección aprobada)`],
    ['Correcciones', `${correcciones.length} solicitadas`],
    ['Fotografías', fotos.length ? `${fotos.filter((f) => f.estado === 'integra').length} de ${fotos.length} verificadas contra su huella` : 'No aplica'],
    ...(muestraLugar ? [['Trabajo a distancia', `${pctRemoto}% del tiempo (${pctRemoto > UMBRAL_NOM037 ? 'le aplica la NOM-037' : 'no supera el umbral de la NOM-037'})`]] : []),
  ]);
  doc.moveDown(0.5);
  nota('Contenido: 1. Convenio y aviso de privacidad · 2. Resumen semanal y firmas · 3. Registro diario con evidencia · 4. Correcciones · '
    + `5. Constancias de envío y firma${muestraLugar ? ' · 6. Trabajo a distancia (NOM-037)' : ''} · Anexo A. Textos firmados · Anexo B. Verificación de eventos.`);

  // ---------- 1. Convenio ----------
  titulo(1, 'Convenio de registro electrónico y aviso de privacidad');
  if (!convenio) {
    parrafo('No se ha enviado el convenio de registro electrónico a este trabajador.', { color: C.critico, negrita: true });
  } else {
    claveValor([
      ['Versión de los documentos', convenio.datos.version],
      ['Enviado', `${fechaHora(convenio.hora_servidor)} por ${canal(convenio.datos.canal)} al ${convenio.datos.telefono ?? '-'} (evento ${convenio.id})`],
      ['Recordatorios', recordatoriosConvenio.length ? recordatoriosConvenio.map((r) => fechaHora(r.hora_servidor)).join('; ') : 'Ninguno'],
      ['Respuesta', respuestaConvenio
        ? `${respuestaConvenio.clase === 'convenio_firmado' ? 'FIRMADO' : 'NO ACEPTADO'} el ${fechaHora(respuestaConvenio.hora_servidor)} (evento ${respuestaConvenio.id})`
        : 'Pendiente'],
      ...(respuestaConvenio?.clase === 'convenio_firmado' ? [['Método de firma', `Código de 6 dígitos enviado por WhatsApp; IP ${respuestaConvenio.datos.ip ?? '-'}`]] : []),
      ...(respuestaConvenio?.clase === 'convenio_rechazado' ? [['Motivo expresado', respuestaConvenio.datos.motivo]] : []),
      ['Hash de los documentos', convenio.datos.hash_documentos],
    ]);
    doc.moveDown(0.5);
    tabla(
      [{ t: 'Documento', w: 0.4 }, { t: 'Versión', w: 0.15 }, { t: 'Huella SHA-256 del texto', w: 0.45, mono: true }],
      convenio.datos.documentos.map((d) => [d.titulo, d.version, d.hash]),
      { tam: 8 },
    );
    nota('El texto íntegro que recibió y firmó el trabajador está en el Anexo A. Su huella coincide con la registrada en la bitácora al momento del envío.');
  }

  // ---------- 2. Semanas ----------
  titulo(2, 'Resumen semanal y confirmación del trabajador');
  parrafo(`Topes aplicados: jornada máxima semanal y horas extra por semana según el año (reforma LFT). Ordinario diario: ${emp.tipo_jornada === 'nocturna' ? '7' : emp.tipo_jornada === 'mixta' ? '7.5' : '8'} h.`);
  doc.moveDown(0.4);
  const ESTADO_F = { firmada: 'Firmada', pendiente: 'Pendiente', objetada: 'Objetada' };
  tabla(
    [{ t: 'Semana', w: 0.2 }, { t: 'Días', w: 0.07 }, { t: 'Total', w: 0.09 }, { t: 'Ordin.', w: 0.09 }, { t: 'Dobles', w: 0.09 }, { t: 'Triples', w: 0.09 }, { t: 'Tope', w: 0.08 }, { t: 'Confirmación del trabajador', w: 0.29 }],
    semanas.map((s) => ({
      celdas: [
        `${fechaCorta(s.lunes)} al ${fechaCorta(s.domingo)}`, s.semana.dias, s.semana.total, s.semana.ordinarias, s.semana.extraDobles, s.semana.extraTriples,
        `${s.semana.regla.topeSemanal} h`,
        s.firma ? `${ESTADO_F[s.firma.estado]}${s.firma.respondido_en ? ` ${fechaHora(s.firma.respondido_en)}` : ''}${s.firma.recordatorios ? ` · ${s.firma.recordatorios} recordatorio(s)` : ''}${s.firma.objecion ? `\nObjeción: "${s.firma.objecion}"` : ''}` : 'No enviado',
      ],
      color: (i) => (i === 5 && s.semana.extraTriples > 0 ? C.critico : i === 7 && s.firma?.estado === 'objetada' ? C.alerta : C.texto),
    })),
    { tam: 8 },
  );
  if (semanas.some((s) => s.semana.incompletas)) nota('Hay jornadas sin salida registrada; no se cuentan horas después del último registro hasta que se apruebe una corrección.', C.alerta);

  // ---------- 3. Registro diario ----------
  titulo(3, 'Registro diario con evidencia');
  parrafo('Hora asignada por el servidor del sistema (no por el dispositivo). Los registros reemplazados por una corrección se conservan y se señalan.');
  doc.moveDown(0.4);
  const evidencia = (e) => {
    const ev = e.datos.evidencia ?? {};
    const partes2 = [];
    if (e.clase === 'correccion_aprobada') partes2.push(`Corrección #${e.datos.correccion_id}: pidió ${e.datos.solicitado_por}, aprobó ${e.datos.decidido_por}`);
    if (ev.foto_sha256) partes2.push(`Foto ${ev.foto_sha256.slice(0, 12)}... (${{ integra: 'verificada', alterada: 'NO COINCIDE', no_encontrada: 'archivo no localizado' }[estadoFoto.get(e.id)] ?? ''})`);
    if (ev.gps) partes2.push(`GPS ${ev.gps.lat}, ${ev.gps.lng} (+/- ${ev.gps.precision_m ?? '?'} m)`);
    if (ev.ip) partes2.push(`IP ${ev.ip}${ev.dispositivo ? ` · ${ev.dispositivo}` : ''}`);
    if (e.datos.hora_dispositivo) partes2.push(`Hora del dispositivo ${hora(e.datos.hora_dispositivo)}`);
    if ((e.datos.banderas ?? []).length) partes2.push(`Revisar: ${e.datos.banderas.map((b) => BANDERA[b] ?? b).join(', ')}`);
    if (reemplazadaPor.has(e.id)) partes2.push(`REEMPLAZADO por el evento ${reemplazadaPor.get(e.id)}`);
    return partes2.join('\n') || '-';
  };
  const LUGAR_CORTO = { oficina: 'Oficina', casa: 'Casa', otro: 'Otro lugar', campo: 'Campo', sin_dato: '' };
  const ORIGEN = { kiosco: 'Kiosco', app: 'App', web: 'Web', demo: 'Demo' };
  tabla(
    [{ t: 'Fecha', w: 0.17 }, { t: 'Hora', w: 0.13 }, { t: 'Registro', w: 0.13 }, { t: muestraLugar ? 'Origen / lugar' : 'Origen', w: 0.11 }, { t: 'Evidencia', w: 0.38 }, { t: 'Evento', w: 0.08 }],
    checadas.map((e) => ({
      celdas: [
        fecha(e.hora), hora(e.hora), TIPO[e.datos.tipo] ?? e.datos.tipo,
        (e.clase === 'correccion_aprobada' ? 'Corrección' : ORIGEN[e.datos.origen] ?? e.datos.origen)
          + (muestraLugar ? `\n${LUGAR_CORTO[lugarDe(e)] ?? ''}` : ''),
        evidencia(e), e.id,
      ],
      color: reemplazadaPor.has(e.id) ? C.tenue : (e.datos.banderas ?? []).length ? C.alerta : C.texto,
    })),
    { tam: 7.8 },
  );
  if (checadas.length === 0) parrafo('Sin registros en el periodo.', { color: C.tenue });

  if (fotos.some((f) => f.bytes)) {
    subtitulo('Fotografías tomadas al registrar');
    nota('Cada fotografía se guarda con su huella SHA-256 en la bitácora al momento del registro. "Verificada" significa que el archivo actual es idéntico al original.');
    const porFila = 4;
    const w = (ancho - (porFila - 1) * 10) / porFila;
    const h = w * 0.75;
    let col = 0;
    for (const f of fotos.filter((x) => x.bytes)) {
      if (col === 0) espacio(h + 34);
      const x = MARGEN + col * (w + 10);
      const y = doc.y;
      try { doc.image(f.bytes, x, y, { fit: [w, h], align: 'center', valign: 'center' }); } catch { doc.rect(x, y, w, h).fill(C.fondo); }
      doc.rect(x, y, w, h).lineWidth(0.5).strokeColor(C.borde).stroke();
      doc.fillColor(f.estado === 'integra' ? C.texto : C.critico).font('Helvetica').fontSize(7)
        .text(`${fecha(f.evento.hora)} ${hora(f.evento.hora)}\n${TIPO[f.evento.datos.tipo]} · ${f.estado === 'integra' ? 'verificada' : 'NO COINCIDE'} · ev. ${f.evento.id}`, x, y + h + 3, { width: w });
      col += 1;
      if (col === porFila) { col = 0; doc.x = MARGEN; doc.y = y + h + 30; } else { doc.y = y; }
    }
    if (col !== 0) { doc.x = MARGEN; doc.y += h + 30; }
  }

  // ---------- 4. Correcciones ----------
  titulo(4, 'Correcciones');
  parrafo('Ningún registro se borra ni se edita. Una corrección se agrega encima con quién la pidió, quién la decidió, cuándo y por qué.');
  doc.moveDown(0.4);
  if (correcciones.length === 0) parrafo('No hubo correcciones en el periodo.', { color: C.tenue });
  else {
    tabla(
      [{ t: 'Solicitud', w: 0.27 }, { t: 'Registro original', w: 0.2 }, { t: 'Corrección', w: 0.2 }, { t: 'Decisión', w: 0.33 }],
      correcciones.map((c) => ({
        celdas: [
          `#${c.id} · ${fechaHora(c.solicitada_en)}\nPidió: ${c.solicitado_por}\nMotivo: "${c.motivo}"`,
          c.original ? `${TIPO[c.original.tipo]}\n${fecha(c.original.hora)} ${hora(c.original.hora)}\n(evento ${c.original.id})` : 'No existía (registro faltante)',
          `${TIPO[c.tipo]}\n${fecha(c.hora_propuesta)} ${hora(c.hora_propuesta)}`,
          c.decision ? `${c.estado === 'aprobada' ? 'APROBADA' : 'RECHAZADA'} por ${c.decision.por}\n${fechaHora(c.decision.en)}${c.decision.comentario ? `\n"${c.decision.comentario}"` : ''}\n(evento ${c.decision.evento})` : 'Pendiente de decisión',
        ],
        color: (i) => (i === 3 && c.estado === 'rechazada' ? C.critico : C.texto),
      })),
      { tam: 7.8 },
    );
  }

  // ---------- 5. Constancias ----------
  titulo(5, 'Constancias de envío, recordatorios y respuestas');
  const DESCR = {
    resumen_enviado: (e) => `Resumen semana ${fechaCorta(e.datos.semana)} enviado por ${canal(e.datos.canal)}: ${e.datos.resumen?.ordinarias} h ord., ${e.datos.resumen?.extra_dobles} dobles, ${e.datos.resumen?.extra_triples} triples`,
    recordatorio: (e) => (e.datos.convenio_id ? `Recordatorio ${e.datos.numero} del convenio` : `Recordatorio ${e.datos.numero} del resumen semanal (evento ${e.datos.resumen_id})`),
    firma: (e) => `Confirmó su semana del ${fechaCorta(e.datos.semana)} con código (IP ${e.datos.ip ?? '-'})`,
    objecion: (e) => `Objetó su semana del ${fechaCorta(e.datos.semana)}: "${e.datos.motivo}"`,
    convenio_enviado: (e) => `Convenio versión ${e.datos.version} enviado al ${e.datos.telefono ?? '-'}`,
    convenio_firmado: (e) => `Firmó el convenio (IP ${e.datos.ip ?? '-'})`,
    convenio_rechazado: (e) => `No aceptó el convenio: "${e.datos.motivo}"`,
    correccion_solicitada: (e) => `Solicitud de corrección #${e.id} por ${e.datos.solicitado_por}`,
    correccion_rechazada: (e) => `Corrección #${e.datos.correccion_id} rechazada por ${e.datos.decidido_por}`,
    nota: (e) => ({ alta_empleado: 'Alta en el sistema', cambio_empleado: 'Cambio de datos', baja_empleado: 'Baja', reactivacion_empleado: 'Reactivación', cambio_pin: 'Cambio de PIN', expediente_generado: `Expediente generado (${e.datos.desde} a ${e.datos.hasta}) por ${e.datos.generado_por}` }[e.datos.asunto] ?? e.datos.asunto),
  };
  const constancias = [...new Map([...eventos, ...convEventos].map((e) => [e.id, e])).values()]
    .filter((e) => DESCR[e.clase] && e.clase !== 'checada' && e.clase !== 'correccion_aprobada')
    .sort((a, b) => a.id - b.id);
  if (constancias.length === 0) parrafo('Sin constancias en el periodo.', { color: C.tenue });
  else {
    tabla(
      [{ t: 'Fecha y hora (servidor)', w: 0.24 }, { t: 'Constancia', w: 0.64 }, { t: 'Evento', w: 0.12 }],
      constancias.map((e) => [fechaHora(e.hora_servidor), DESCR[e.clase](e), e.id]),
      { tam: 8 },
    );
  }

  // ---------- 6. NOM-037 ----------
  if (muestraLugar) {
    titulo(6, 'Trabajo a distancia (NOM-037-STPS-2023)');
    parrafo(emp.modalidad === 'hibrido'
      ? 'Modalidad híbrida sin días fijos: en el centro de trabajo registra en el kiosco con foto; fuera de él, desde su dispositivo vinculado con Iniciar, Pausa y Terminar, declarando si está en su domicilio o en otro lugar. Se guarda la dirección IP y el tipo de dispositivo; no se registra la ubicación exacta del domicilio ni se monitorea la pantalla.'
      : 'El registro de este trabajador se realiza desde la web o el celular con las acciones Iniciar, Pausa y Terminar. Se guarda la dirección IP y el tipo de dispositivo; no se registra la ubicación exacta del domicilio ni se monitorea la pantalla.');
    doc.moveDown(0.4);
    claveValor([
      ['Tiempo fuera del centro', `${pctRemoto}% del tiempo laborado en el periodo (${r2(horasRemotas)} de ${r2(totales.total)} h)`],
      ['Distribución', textoLugar || '-'],
      ['Días', textoDias || '-'],
      ['NOM-037', pctRemoto > UMBRAL_NOM037
        ? `APLICA: supera el ${UMBRAL_NOM037}% de trabajo a distancia (art. 330-A LFT)`
        : `No aplica en este periodo: no supera el ${UMBRAL_NOM037}% de trabajo a distancia`],
    ]);
    doc.moveDown(0.4);
    nota('Pendiente en el sistema: padrón de teletrabajadores, inventario de equipo con firma, autoverificación del lugar de trabajo y cuestionario de riesgos psicosociales. Mientras tanto, integrar esa documentación por separado.', C.alerta);
  }

  // ---------- Anexo A ----------
  if (convenio) {
    doc.addPage();
    doc.fillColor(C.acento).font('Helvetica-Bold').fontSize(9).text('ANEXO A', { characterSpacing: 1 });
    doc.fillColor(C.marca).font('Helvetica-Bold').fontSize(18).text('Textos enviados al trabajador').moveDown(0.3);
    nota(`Texto exacto guardado en la bitácora (evento ${convenio.id}) al momento del envío.`);
    for (const d of convenio.datos.documentos) {
      subtitulo(d.titulo);
      doc.fillColor(C.tenue).font('Courier').fontSize(7).text(`SHA-256: ${d.hash}`).moveDown(0.3);
      doc.fillColor(C.texto).font('Helvetica').fontSize(8.5).text(d.texto, { lineGap: 1.5, align: 'justify' });
    }
  }

  // ---------- Anexo B ----------
  doc.addPage();
  doc.fillColor(C.acento).font('Helvetica-Bold').fontSize(9).text('ANEXO B', { characterSpacing: 1 });
  doc.fillColor(C.marca).font('Helvetica-Bold').fontSize(18).text('Verificación de eventos').moveDown(0.3);
  parrafo('Cada evento se identifica con su número y su hash SHA-256, calculado sobre su contenido y el hash del evento anterior de la empresa. '
    + 'Un perito puede recalcular la cadena completa a partir de la base de datos: si algún evento hubiera sido modificado, eliminado o reordenado, '
    + 'su hash o el del siguiente dejaría de coincidir.');
  doc.moveDown(0.4);
  const todos = [...new Map([...eventos, ...convEventos].map((e) => [e.id, e])).values()].sort((a, b) => a.id - b.id);
  tabla(
    [{ t: 'Evento', w: 0.08 }, { t: 'Tipo', w: 0.17 }, { t: 'Hora del servidor', w: 0.21 }, { t: 'Hash SHA-256', w: 0.54, mono: true }],
    todos.map((e) => [e.id, e.clase.replaceAll('_', ' '), fechaHora(e.hora_servidor), e.hash]),
    { tam: 6.5 },
  );

  // ---------- Pie de página ----------
  const rango = doc.bufferedPageRange();
  for (let i = rango.start; i < rango.start + rango.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - MARGEN + 12;
    doc.page.margins.bottom = 0;
    doc.fillColor(C.tenue).font('Helvetica').fontSize(7)
      .text(`${empresa.nombre} · Expediente de ${emp.nombre} · ${fechaCorta(desde)} al ${fechaCorta(hasta)}`, MARGEN, y, { width: ancho * 0.8, lineBreak: false })
      .text(`Página ${i + 1} de ${rango.count}`, MARGEN, y, { width: ancho, align: 'right', lineBreak: false });
  }

  doc.end();
  await terminado;
  const buffer = Buffer.concat(partes);
  const huella = createHash('sha256').update(buffer).digest('hex');

  // Constancia de que este PDF exacto se generó (su huella permite comprobar después que no se modificó).
  await db.transaction((tx) => agregarEvento(tx, {
    empresa_id: empresa.id, empleado_id: emp.id, clase: 'nota',
    datos: { asunto: 'expediente_generado', desde, hasta, generado_por: generadoPor, pdf_sha256: huella, paginas: rango.count, eventos_incluidos: todos.length },
  }));

  const slug = emp.nombre.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  return { buffer, huella, nombreArchivo: `expediente-${emp.numero}-${slug}-${desde}-a-${hasta}.pdf` };
}
