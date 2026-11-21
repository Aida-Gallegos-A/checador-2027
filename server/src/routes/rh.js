// Panel de RH: resumen con alertas, correcciones, firmas semanales, integridad y nómina.
import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { agregarEvento, jsonCanonico, sha256, verificarCadena } from '../lib/cadena.js';
import { fechaLocal, sumarDias } from '../lib/jornada.js';
import { enviarWhatsApp } from '../lib/notificador.js';
import { generarCodigo, generarSal, hashCodigo, igualSeguro, indicePin } from '../lib/seguridad.js';
import {
  armarResumen, empleadosActivos, estadoFirmas, listarCorrecciones, obtenerEmpresa,
  semanaActual, semanasDeEmpleados, TIPOS_CHECADA,
} from '../servicios.js';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const fmtFecha = (f) => new Date(`${f}T12:00:00Z`).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export function rutasRh(db) {
  const r = Router();

  // MVP: un token de RH por instalación. Se reemplaza por usuarios con login y roles.
  r.use(async (req, res, next) => {
    const esperado = process.env.RH_TOKEN ?? 'rh-demo';
    const dado = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!dado || !igualSeguro(dado, esperado)) return res.status(401).json({ error: 'No autorizado' });
    req.empresa = await obtenerEmpresa(db, Number(process.env.EMPRESA_ID ?? 1));
    if (!req.empresa) return res.status(500).json({ error: 'No hay empresa configurada. Corre npm run seed.' });
    next();
  });

  const lunesDeReq = (req) => {
    const s = req.query.semana;
    return semanaActual(req.empresa, typeof s === 'string' && FECHA.test(s) ? s : undefined);
  };

  // ---------- Resumen ----------
  r.get('/resumen', async (req, res) => {
    const lunes = lunesDeReq(req);
    const hoy = fechaLocal(new Date(), req.empresa.zona_horaria);
    const empleados = await empleadosActivos(db, req.empresa.id);
    const semanas = await semanasDeEmpleados(db, req.empresa, empleados, lunes);
    const firmas = await estadoFirmas(db, req.empresa.id, lunes);
    const pendientes = await listarCorrecciones(db, req.empresa.id, 'pendiente');

    const filas = semanas.map((s) => ({
      empleado: s.empleado,
      semana: s.semana,
      alertas: s.alertas,
      banderas: s.banderas,
      dentro_ahora: s.jornadas.some((j) => j.fecha === hoy && j.incompleta),
      vino_hoy: s.jornadas.some((j) => j.fecha === hoy),
      firma: firmas.get(s.empleado.id) ?? { estado: 'sin_enviar' },
    }));

    const alertas = [
      ...filas.flatMap((f) => f.alertas.map((a) => ({ ...a, empleado_id: f.empleado.id }))),
      ...filas.flatMap((f) => f.banderas.map((b) => ({
        nivel: 'media',
        codigo: b.bandera,
        empleado_id: f.empleado.id,
        evento: b.evento,
        mensaje: `${f.empleado.nombre}: ${TEXTO_BANDERA[b.bandera] ?? b.bandera}`,
      }))),
    ];

    res.json({
      empresa: req.empresa.nombre,
      semana: { lunes, domingo: sumarDias(lunes, 6), regla: semanas[0]?.semana.regla ?? null },
      hoy,
      indicadores: {
        empleados: filas.length,
        presentes: filas.filter((f) => f.dentro_ahora).length,
        vinieron_hoy: filas.filter((f) => f.vino_hoy).length,
        salidas_faltantes: semanas.reduce((n, s) => n + s.jornadas.filter((j) => j.incompleta && j.fecha < hoy).length, 0),
        horas_extra: Math.round(filas.reduce((n, f) => n + f.semana.extraDobles + f.semana.extraTriples, 0) * 100) / 100,
        semanas_firmadas: filas.filter((f) => f.firma.estado === 'firmada').length,
        correcciones_pendientes: pendientes.length,
      },
      alertas,
      empleados: filas,
    });
  });

  // ---------- Empleados ----------
  const COLUMNAS_EMP = 'id, numero, nombre, puesto, telefono, modalidad, tipo_jornada, activo, pin_indice IS NOT NULL AS tiene_pin, creado_en';
  const esDuplicado = (e) => e.code === '23505' || /unique|duplicate/i.test(String(e.message));

  r.get('/empleados', async (req, res) => {
    const { rows } = await db.query(
      `SELECT ${COLUMNAS_EMP} FROM empleados WHERE empresa_id = $1 ORDER BY activo DESC, nombre`,
      [req.empresa.id],
    );
    res.json(rows);
  });

  // Alta. Si no se da PIN, se genera uno de 4 dígitos que no use nadie más; se devuelve una sola vez.
  r.post('/empleados', async (req, res) => {
    const b = req.body ?? {};
    const error = validarEmpleado(b, { alta: true });
    if (error) return res.status(400).json({ error });
    const pin = b.pin ? String(b.pin) : await pinLibre(db, req.empresa.id);
    try {
      const emp = await db.transaction(async (tx) => {
        const { rows: [e] } = await tx.query(
          `INSERT INTO empleados (empresa_id, numero, nombre, puesto, telefono, modalidad, tipo_jornada, pin_indice)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNAS_EMP}`,
          [req.empresa.id, String(b.numero).trim(), b.nombre.trim(), limpio(b.puesto), normalizarTelefono(b.telefono),
            b.modalidad, b.tipo_jornada ?? 'diurna', indicePin(req.empresa.id, pin)],
        );
        await agregarEvento(tx, {
          empresa_id: req.empresa.id, empleado_id: e.id, clase: 'nota',
          datos: { asunto: 'alta_empleado', numero: e.numero, nombre: e.nombre, modalidad: e.modalidad, tipo_jornada: e.tipo_jornada, registrado_por: limpio(b.registrado_por) ?? 'RH' },
        });
        return e;
      });
      res.status(201).json({ ...emp, pin });
    } catch (e) {
      if (esDuplicado(e)) return res.status(409).json({ error: 'Ya existe un empleado con ese número de empleado o ese PIN' });
      throw e;
    }
  });

  // Cambios y baja/reactivación. El número de empleado no cambia. Cada cambio queda en la bitácora.
  r.patch('/empleados/:id', async (req, res) => {
    const b = req.body ?? {};
    const error = validarEmpleado(b, { alta: false });
    if (error) return res.status(400).json({ error });
    const resultado = await db.transaction(async (tx) => {
      const { rows: [antes] } = await tx.query(
        `SELECT ${COLUMNAS_EMP} FROM empleados WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
        [Number(req.params.id), req.empresa.id],
      );
      if (!antes) return null;
      const nuevo = {
        nombre: b.nombre !== undefined ? b.nombre.trim() : antes.nombre,
        puesto: b.puesto !== undefined ? limpio(b.puesto) : antes.puesto,
        telefono: b.telefono !== undefined ? normalizarTelefono(b.telefono) : antes.telefono,
        modalidad: b.modalidad ?? antes.modalidad,
        tipo_jornada: b.tipo_jornada ?? antes.tipo_jornada,
        activo: typeof b.activo === 'boolean' ? b.activo : antes.activo,
      };
      const cambios = Object.fromEntries(
        Object.entries(nuevo).filter(([k, v]) => v !== antes[k]).map(([k, v]) => [k, { antes: antes[k], despues: v }]),
      );
      if (Object.keys(cambios).length === 0) return antes;
      const { rows: [despues] } = await tx.query(
        `UPDATE empleados SET nombre = $3, puesto = $4, telefono = $5, modalidad = $6, tipo_jornada = $7, activo = $8
          WHERE id = $1 AND empresa_id = $2 RETURNING ${COLUMNAS_EMP}`,
        [antes.id, req.empresa.id, nuevo.nombre, nuevo.puesto, nuevo.telefono, nuevo.modalidad, nuevo.tipo_jornada, nuevo.activo],
      );
      const asunto = cambios.activo ? (nuevo.activo ? 'reactivacion_empleado' : 'baja_empleado') : 'cambio_empleado';
      await agregarEvento(tx, {
        empresa_id: req.empresa.id, empleado_id: antes.id, clase: 'nota',
        datos: { asunto, cambios, motivo: limpio(b.motivo), registrado_por: limpio(b.registrado_por) ?? 'RH' },
      });
      return despues;
    });
    if (!resultado) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(resultado);
  });

  // Importación masiva (Excel/CSV leído en el navegador). Dos pasos:
  //   confirmar=false → valida todo y devuelve vista previa por fila (no guarda nada)
  //   confirmar=true  → guarda las filas válidas en una sola transacción y devuelve los PINs generados
  // Si el número de empleado ya existe, se actualizan sus datos (nunca su PIN).
  r.post('/empleados/importar', async (req, res) => {
    const filas = req.body?.filas;
    if (!Array.isArray(filas) || filas.length === 0) return res.status(400).json({ error: 'El archivo no tiene filas' });
    if (filas.length > 3000) return res.status(400).json({ error: 'Máximo 3,000 empleados por archivo' });
    const confirmar = req.body.confirmar === true;
    const registradoPor = limpio(req.body.registrado_por) ?? 'RH';

    const { rows: existentes } = await db.query(
      `SELECT id, numero, nombre, puesto, telefono, modalidad, tipo_jornada, activo, pin_indice FROM empleados WHERE empresa_id = $1`,
      [req.empresa.id],
    );
    const porNumero = new Map(existentes.map((e) => [e.numero, e]));
    const pinesUsados = new Set(existentes.map((e) => e.pin_indice).filter(Boolean));
    const numerosVistos = new Map();

    const analisis = filas.map((f, i) => {
      const fila = Number(f?.fila) || i + 2;
      const errores = [];
      const avisos = [];
      const d = normalizarFila(f ?? {}, errores);

      if (d.numero) {
        if (numerosVistos.has(d.numero)) errores.push(`Número repetido en el archivo (también en la fila ${numerosVistos.get(d.numero)})`);
        else numerosVistos.set(d.numero, fila);
      }
      const existente = d.numero ? porNumero.get(d.numero) : null;
      if (existente && !existente.activo) errores.push('Este número está dado de baja; reactívalo desde la lista de empleados');

      let accion = 'crear';
      let cambios = null;
      if (existente) {
        if (d.pin) avisos.push('Ya existe: el PIN del archivo se ignora (usa "Nuevo PIN")');
        cambios = {};
        for (const k of ['nombre', 'puesto', 'telefono', 'modalidad', 'tipo_jornada']) {
          // Celda vacía en el archivo = no tocar el dato actual.
          if (d[k] !== null && d[k] !== existente[k]) cambios[k] = { antes: existente[k], despues: d[k] };
        }
        accion = Object.keys(cambios).length ? 'actualizar' : 'sin_cambios';
      } else if (d.pin && errores.length === 0) {
        const idx = indicePin(req.empresa.id, d.pin);
        if (pinesUsados.has(idx)) errores.push('Ese PIN ya lo usa otra persona');
        else pinesUsados.add(idx);
      }
      if (!existente && !d.telefono) avisos.push('Sin teléfono: no podrá firmar por WhatsApp');

      return { fila, ...d, accion: errores.length ? 'error' : accion, errores, avisos, cambios, existente };
    });

    const resumen = {
      total: analisis.length,
      crear: analisis.filter((a) => a.accion === 'crear').length,
      actualizar: analisis.filter((a) => a.accion === 'actualizar').length,
      sin_cambios: analisis.filter((a) => a.accion === 'sin_cambios').length,
      errores: analisis.filter((a) => a.accion === 'error').length,
    };
    const publico = (a) => ({
      fila: a.fila, numero: a.numero, nombre: a.nombre, puesto: a.puesto, telefono: a.telefono,
      modalidad: a.modalidad, tipo_jornada: a.tipo_jornada, accion: a.accion, errores: a.errores, avisos: a.avisos, cambios: a.cambios,
    });
    if (!confirmar) return res.json({ resumen, filas: analisis.map(publico) });

    const creados = await db.transaction(async (tx) => {
      const nuevos = [];
      for (const a of analisis) {
        if (a.accion === 'crear') {
          const pin = a.pin ?? pinAleatorio(req.empresa.id, pinesUsados);
          const { rows: [e] } = await tx.query(
            `INSERT INTO empleados (empresa_id, numero, nombre, puesto, telefono, modalidad, tipo_jornada, pin_indice)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, numero, nombre`,
            [req.empresa.id, a.numero, a.nombre, a.puesto, a.telefono, a.modalidad, a.tipo_jornada ?? 'diurna', indicePin(req.empresa.id, pin)],
          );
          await agregarEvento(tx, {
            empresa_id: req.empresa.id, empleado_id: e.id, clase: 'nota',
            datos: { asunto: 'alta_empleado', origen: 'importacion_excel', fila: a.fila, numero: e.numero, nombre: e.nombre, modalidad: a.modalidad, tipo_jornada: a.tipo_jornada ?? 'diurna', registrado_por: registradoPor },
          });
          nuevos.push({ fila: a.fila, numero: e.numero, nombre: e.nombre, pin });
        } else if (a.accion === 'actualizar') {
          const v = (k) => (a.cambios[k] ? a.cambios[k].despues : a.existente[k]);
          await tx.query(
            `UPDATE empleados SET nombre = $2, puesto = $3, telefono = $4, modalidad = $5, tipo_jornada = $6 WHERE id = $1`,
            [a.existente.id, v('nombre'), v('puesto'), v('telefono'), v('modalidad'), v('tipo_jornada')],
          );
          await agregarEvento(tx, {
            empresa_id: req.empresa.id, empleado_id: a.existente.id, clase: 'nota',
            datos: { asunto: 'cambio_empleado', origen: 'importacion_excel', fila: a.fila, cambios: a.cambios, registrado_por: registradoPor },
          });
        }
      }
      return nuevos;
    });
    res.json({ resumen, creados });
  });

  // Nuevo PIN (olvido o sospecha de que alguien más lo usa). El PIN nunca se guarda en claro.
  r.post('/empleados/:id/pin', async (req, res) => {
    const b = req.body ?? {};
    if (b.pin && !/^\d{4}$/.test(String(b.pin))) return res.status(400).json({ error: 'El PIN debe tener 4 dígitos' });
    const pin = b.pin ? String(b.pin) : await pinLibre(db, req.empresa.id);
    try {
      const ok = await db.transaction(async (tx) => {
        const { rows: [e] } = await tx.query(
          `UPDATE empleados SET pin_indice = $3 WHERE id = $1 AND empresa_id = $2 RETURNING id`,
          [Number(req.params.id), req.empresa.id, indicePin(req.empresa.id, pin)],
        );
        if (!e) return false;
        await agregarEvento(tx, {
          empresa_id: req.empresa.id, empleado_id: e.id, clase: 'nota',
          datos: { asunto: 'cambio_pin', registrado_por: limpio(b.registrado_por) ?? 'RH' },
        });
        return true;
      });
      if (!ok) return res.status(404).json({ error: 'Empleado no encontrado' });
      res.json({ pin });
    } catch (e) {
      if (esDuplicado(e)) return res.status(409).json({ error: 'Ese PIN ya lo usa otra persona' });
      throw e;
    }
  });

  // Detalle de la semana de un empleado: jornadas calculadas y todos los eventos (incluidos originales corregidos).
  r.get('/empleados/:id/semana', async (req, res) => {
    const lunes = lunesDeReq(req);
    const { rows: [emp] } = await db.query(
      `SELECT id, numero, nombre, puesto, modalidad, tipo_jornada FROM empleados WHERE id = $1 AND empresa_id = $2`,
      [Number(req.params.id), req.empresa.id],
    );
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });
    const [s] = await semanasDeEmpleados(db, req.empresa, [emp], lunes);
    const { rows: eventos } = await db.query(
      `SELECT id, clase, hora, hora_servidor, datos, hash FROM bitacora
        WHERE empresa_id = $1 AND empleado_id = $2 AND hora_servidor >= $3::date - 1 AND hora_servidor < $3::date + 9
        ORDER BY id`,
      [req.empresa.id, emp.id, lunes],
    );
    res.json({ ...s, eventos });
  });

  // ---------- Correcciones ----------
  r.get('/correcciones', async (req, res) => {
    const estado = ['pendiente', 'aprobada', 'rechazada'].includes(req.query.estado) ? req.query.estado : undefined;
    res.json(await listarCorrecciones(db, req.empresa.id, estado));
  });

  // Solicitar: agregar una checada que faltó o reemplazar una existente. El original nunca se toca.
  r.post('/correcciones', async (req, res) => {
    const { empleado_id, reemplaza = null, tipo, hora, motivo, solicitado_por } = req.body ?? {};
    const horaProp = new Date(hora);
    if (!TIPOS_CHECADA.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    if (Number.isNaN(+horaProp)) return res.status(400).json({ error: 'Hora inválida' });
    if (horaProp > new Date()) return res.status(400).json({ error: 'No se pueden registrar horas futuras' });
    if (!motivo?.trim() || !solicitado_por?.trim()) return res.status(400).json({ error: 'motivo y solicitado_por son obligatorios' });

    const { rows: [emp] } = await db.query(`SELECT id FROM empleados WHERE id = $1 AND empresa_id = $2`, [Number(empleado_id), req.empresa.id]);
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });
    if (reemplaza) {
      const { rows: [orig] } = await db.query(
        `SELECT id FROM bitacora WHERE id = $1 AND empresa_id = $2 AND empleado_id = $3 AND clase IN ('checada', 'correccion_aprobada')`,
        [Number(reemplaza), req.empresa.id, emp.id],
      );
      if (!orig) return res.status(400).json({ error: 'La checada a reemplazar no existe o no es de este empleado' });
    }

    const evento = await db.transaction((tx) => agregarEvento(tx, {
      empresa_id: req.empresa.id, empleado_id: emp.id, clase: 'correccion_solicitada', hora: horaProp,
      datos: { tipo, reemplaza: reemplaza ? Number(reemplaza) : null, motivo: motivo.trim(), solicitado_por: solicitado_por.trim() },
    }));
    res.status(201).json({ id: evento.id, estado: 'pendiente' });
  });

  r.post('/correcciones/:id/decidir', async (req, res) => {
    const { aprobar, decidido_por, comentario = null } = req.body ?? {};
    if (typeof aprobar !== 'boolean' || !decidido_por?.trim()) {
      return res.status(400).json({ error: 'aprobar (true/false) y decidido_por son obligatorios' });
    }
    const id = Number(req.params.id);
    const resultado = await db.transaction(async (tx) => {
      // Bloquea la cadena primero para que dos personas no decidan la misma corrección a la vez.
      await tx.query(`SELECT 1 FROM cadena_cabeza WHERE empresa_id = $1 FOR UPDATE`, [req.empresa.id]);
      const { rows: [sol] } = await tx.query(
        `SELECT id, empleado_id, hora, datos FROM bitacora WHERE id = $1 AND empresa_id = $2 AND clase = 'correccion_solicitada'`,
        [id, req.empresa.id],
      );
      if (!sol) return { status: 404, body: { error: 'Corrección no encontrada' } };
      const { rows: [ya] } = await tx.query(
        `SELECT id FROM bitacora WHERE empresa_id = $1 AND clase IN ('correccion_aprobada', 'correccion_rechazada')
            AND (datos->>'correccion_id')::int = $2`,
        [req.empresa.id, id],
      );
      if (ya) return { status: 409, body: { error: 'Esta corrección ya fue decidida' } };

      const evento = await agregarEvento(tx, {
        empresa_id: req.empresa.id,
        empleado_id: sol.empleado_id,
        clase: aprobar ? 'correccion_aprobada' : 'correccion_rechazada',
        hora: aprobar ? new Date(sol.hora) : undefined,
        datos: {
          correccion_id: id,
          tipo: sol.datos.tipo,
          reemplaza: sol.datos.reemplaza,
          motivo: sol.datos.motivo,
          solicitado_por: sol.datos.solicitado_por,
          decidido_por: decidido_por.trim(),
          comentario,
          banderas: [],
        },
      });
      return { status: 200, body: { id, estado: aprobar ? 'aprobada' : 'rechazada', evento: evento.id } };
    });
    res.status(resultado.status).json(resultado.body);
  });

  // ---------- Firmas semanales ----------
  r.get('/firmas', async (req, res) => {
    const lunes = lunesDeReq(req);
    const empleados = await empleadosActivos(db, req.empresa.id);
    const firmas = await estadoFirmas(db, req.empresa.id, lunes);
    res.json({
      semana: lunes,
      firmas: empleados.map((e) => ({ empleado: e, ...(firmas.get(e.id) ?? { estado: 'sin_enviar' }) })),
    });
  });

  // Envía (o reenvía tras una objeción) el resumen de la semana a cada trabajador.
  r.post('/firmas/enviar', async (req, res) => {
    const lunes = lunesDeReq({ query: { semana: req.body?.semana } , empresa: req.empresa });
    const soloEmpleado = req.body?.empleado_id ? Number(req.body.empleado_id) : null;
    const empleados = (await empleadosActivos(db, req.empresa.id)).filter((e) => !soloEmpleado || e.id === soloEmpleado);
    const firmas = await estadoFirmas(db, req.empresa.id, lunes);
    const semanas = await semanasDeEmpleados(db, req.empresa, empleados, lunes);

    const enviados = [];
    for (const s of semanas) {
      const previa = firmas.get(s.empleado.id);
      if (previa?.estado === 'firmada') continue;
      if (previa?.estado === 'pendiente' && !soloEmpleado) continue; // ya tiene uno vigente: usar "recordar"

      const resumen = armarResumen(s);
      const codigo = generarCodigo();
      const sal = generarSal();
      const evento = await db.transaction((tx) => agregarEvento(tx, {
        empresa_id: req.empresa.id, empleado_id: s.empleado.id, clase: 'resumen_enviado',
        datos: {
          semana: lunes, resumen, hash_resumen: sha256(jsonCanonico(resumen)),
          codigo_sal: sal, codigo_hash: hashCodigo(sal, codigo), canal: 'whatsapp',
        },
      }));
      const mensaje = `Semana del ${fmtFecha(lunes)} al ${fmtFecha(s.domingo)}: ${resumen.ordinarias} h ordinarias, `
        + `${resumen.extra_dobles} h extra dobles${resumen.extra_triples ? `, ${resumen.extra_triples} h extra triples` : ''}. `
        + `Para confirmar responde con tu código ${codigo}. Si algo no cuadra, responde OBJETAR.`;
      await enviarWhatsApp(s.empleado.telefono, mensaje);
      enviados.push({
        empleado_id: s.empleado.id, empleado: s.empleado.nombre, resumen_id: evento.id, resumen,
        ...(process.env.MODO_DEMO === 'true' ? { codigo_demo: codigo } : {}),
      });
    }
    res.json({ semana: lunes, enviados });
  });

  r.post('/firmas/:resumenId/recordar', async (req, res) => {
    const resumenId = Number(req.params.resumenId);
    const { rows: [resumen] } = await db.query(
      `SELECT b.id, b.empleado_id, b.datos, e.telefono FROM bitacora b JOIN empleados e ON e.id = b.empleado_id
        WHERE b.id = $1 AND b.empresa_id = $2 AND b.clase = 'resumen_enviado'`,
      [resumenId, req.empresa.id],
    );
    if (!resumen) return res.status(404).json({ error: 'Resumen no encontrado' });
    const firmas = await estadoFirmas(db, req.empresa.id, resumen.datos.semana);
    const estado = firmas.get(resumen.empleado_id);
    if (estado?.resumen_id !== resumenId || estado.estado !== 'pendiente') {
      return res.status(409).json({ error: 'Este resumen ya no está pendiente' });
    }
    const codigo = generarCodigo();
    const sal = generarSal();
    const evento = await db.transaction((tx) => agregarEvento(tx, {
      empresa_id: req.empresa.id, empleado_id: resumen.empleado_id, clase: 'recordatorio',
      datos: { resumen_id: resumenId, numero: estado.recordatorios + 1, codigo_sal: sal, codigo_hash: hashCodigo(sal, codigo), canal: 'whatsapp' },
    }));
    await enviarWhatsApp(resumen.telefono, `Recordatorio: confirma tus horas de la semana con el código ${codigo}.`);
    res.json({
      recordatorio: evento.id, numero: estado.recordatorios + 1,
      ...(process.env.MODO_DEMO === 'true' ? { codigo_demo: codigo } : {}),
    });
  });

  // ---------- Integridad y nómina ----------
  r.get('/cadena/verificar', async (req, res) => {
    res.json({ empresa: req.empresa.nombre, verificado_en: new Date(), ...(await verificarCadena(db, req.empresa.id)) });
  });

  r.get('/nomina.csv', async (req, res) => {
    const lunes = lunesDeReq(req);
    const empleados = await empleadosActivos(db, req.empresa.id);
    const semanas = await semanasDeEmpleados(db, req.empresa, empleados, lunes);
    const firmas = await estadoFirmas(db, req.empresa.id, lunes);
    const celda = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const lineas = [
      ['numero', 'nombre', 'modalidad', 'semana', 'dias', 'horas_ordinarias', 'extra_dobles', 'extra_triples', 'jornadas_incompletas', 'firma'],
      ...semanas.map((s) => [
        s.empleado.numero, s.empleado.nombre, s.empleado.modalidad, lunes, s.semana.dias, s.semana.ordinarias,
        s.semana.extraDobles, s.semana.extraTriples, s.semana.incompletas, firmas.get(s.empleado.id)?.estado ?? 'sin_enviar',
      ]),
    ];
    res.type('text/csv; charset=utf-8')
      .attachment(`nomina-${lunes}.csv`)
      .send('﻿' + lineas.map((l) => l.map(celda).join(',')).join('\r\n'));
  });

  return r;
}

const MODALIDADES = ['presencial', 'campo', 'home_office'];
const JORNADAS = ['diurna', 'nocturna', 'mixta'];
const limpio = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function validarEmpleado(b, { alta }) {
  if (alta) {
    if (!limpio(String(b.numero ?? ''))) return 'El número de empleado es obligatorio';
    if (!limpio(b.nombre)) return 'El nombre es obligatorio';
    if (!b.modalidad) return 'La modalidad es obligatoria';
  } else if (b.nombre !== undefined && !limpio(b.nombre)) {
    return 'El nombre no puede quedar vacío';
  }
  if (b.modalidad !== undefined && !MODALIDADES.includes(b.modalidad)) return 'Modalidad inválida';
  if (b.tipo_jornada !== undefined && !JORNADAS.includes(b.tipo_jornada)) return 'Tipo de jornada inválido';
  if (b.pin && !/^\d{4}$/.test(String(b.pin))) return 'El PIN debe tener 4 dígitos';
  if (b.telefono && normalizarTelefono(b.telefono) === undefined) return 'Teléfono inválido (10 dígitos, con o sin +52)';
  return null;
}

const PINES_OBVIOS = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '2580', '1212']);

/** PIN de 4 dígitos que nadie más usa en la empresa (evita los obvios). */
async function pinLibre(db, empresaId) {
  const { rows } = await db.query(`SELECT pin_indice FROM empleados WHERE empresa_id = $1 AND pin_indice IS NOT NULL`, [empresaId]);
  return pinAleatorio(empresaId, new Set(rows.map((r) => r.pin_indice)));
}

/** Igual, contra un conjunto en memoria (lo actualiza). Útil para importaciones grandes. */
function pinAleatorio(empresaId, usados) {
  if (usados.size > 8000) throw new Error('Quedan pocos PINs de 4 dígitos libres; usa gafete con QR o PIN más largo');
  for (let i = 0; i < 1000; i++) {
    const pin = String(randomInt(0, 10_000)).padStart(4, '0');
    if (PINES_OBVIOS.has(pin)) continue;
    const idx = indicePin(empresaId, pin);
    if (!usados.has(idx)) { usados.add(idx); return pin; }
  }
  throw new Error('No se encontró un PIN libre');
}

const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Teléfono a formato +52XXXXXXXXXX. Devuelve null si viene vacío, o undefined si no es válido. */
export function normalizarTelefono(valor) {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  if (!digitos) return null;
  if (digitos.length === 10) return `+52${digitos}`;
  if (digitos.length === 12 && digitos.startsWith('52')) return `+${digitos}`;
  if (digitos.length === 13 && digitos.startsWith('521')) return `+52${digitos.slice(3)}`;
  return undefined;
}

const MAPA_MODALIDAD = {
  presencial: 'presencial', oficina: 'presencial', planta: 'presencial', tienda: 'presencial', sucursal: 'presencial',
  campo: 'campo', ruta: 'campo', foraneo: 'campo', guardia: 'campo', chofer: 'campo', tecnico: 'campo',
  'home office': 'home_office', home_office: 'home_office', homeoffice: 'home_office', remoto: 'home_office',
  teletrabajo: 'home_office', 'en casa': 'home_office', casa: 'home_office', hibrido: 'home_office',
};
const MAPA_JORNADA = { diurna: 'diurna', dia: 'diurna', nocturna: 'nocturna', noche: 'nocturna', mixta: 'mixta' };

/** Limpia y valida una fila del archivo. Los campos vacíos opcionales quedan en null. */
export function normalizarFila(f, errores) {
  const texto = (v) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());
  const numero = texto(f.numero);
  const nombre = texto(f.nombre);
  if (!numero) errores.push('Falta el número de empleado');
  if (!nombre) errores.push('Falta el nombre');

  let modalidad = null;
  if (texto(f.modalidad)) {
    modalidad = MAPA_MODALIDAD[sinAcentos(f.modalidad)] ?? null;
    if (!modalidad) errores.push(`Modalidad "${texto(f.modalidad)}" no reconocida (usa presencial, campo o home office)`);
  } else {
    errores.push('Falta la modalidad');
  }

  let tipo_jornada = null;
  if (texto(f.jornada)) {
    tipo_jornada = MAPA_JORNADA[sinAcentos(f.jornada)] ?? null;
    if (!tipo_jornada) errores.push(`Jornada "${texto(f.jornada)}" no reconocida (usa diurna, nocturna o mixta)`);
  }

  const telefono = normalizarTelefono(f.telefono);
  if (telefono === undefined) errores.push(`Teléfono "${texto(f.telefono)}" inválido (10 dígitos)`);

  let pin = texto(f.pin) || null;
  if (pin && /^\d{1,3}$/.test(pin)) pin = pin.padStart(4, '0'); // Excel quita los ceros a la izquierda
  if (pin && !/^\d{4}$/.test(pin)) { errores.push('El PIN debe tener 4 dígitos'); pin = null; }

  return { numero, nombre, puesto: texto(f.puesto) || null, telefono: telefono ?? null, modalidad, tipo_jornada, pin };
}

const TEXTO_BANDERA = {
  sin_foto: 'checada sin foto',
  hora_dispositivo_no_cuadra: 'la hora del dispositivo no cuadra con la del servidor',
  secuencia_irregular: 'checada fuera de secuencia (p. ej. dos entradas seguidas)',
  fuera_de_zona: 'checó lejos del sitio esperado',
  sin_conexion: 'registro enviado sin conexión',
};
