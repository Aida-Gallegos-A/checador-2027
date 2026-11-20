// Panel de RH: resumen con alertas, correcciones, firmas semanales, integridad y nómina.
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
  r.get('/empleados', async (req, res) => {
    res.json(await empleadosActivos(db, req.empresa.id));
  });

  r.post('/empleados', async (req, res) => {
    const { numero, nombre, puesto = null, telefono = null, modalidad, tipo_jornada = 'diurna', pin } = req.body ?? {};
    if (!numero || !nombre || !modalidad) return res.status(400).json({ error: 'numero, nombre y modalidad son obligatorios' });
    if (pin && !/^\d{4,8}$/.test(String(pin))) return res.status(400).json({ error: 'El PIN debe tener de 4 a 8 dígitos' });
    try {
      const emp = await db.transaction(async (tx) => {
        const { rows: [e] } = await tx.query(
          `INSERT INTO empleados (empresa_id, numero, nombre, puesto, telefono, modalidad, tipo_jornada, pin_indice)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, numero, nombre, puesto, telefono, modalidad, tipo_jornada`,
          [req.empresa.id, String(numero), nombre, puesto, telefono, modalidad, tipo_jornada,
            pin ? indicePin(req.empresa.id, String(pin)) : null],
        );
        await agregarEvento(tx, {
          empresa_id: req.empresa.id, empleado_id: e.id, clase: 'nota',
          datos: { asunto: 'alta_empleado', modalidad, tipo_jornada, registrado_por: req.body.registrado_por ?? 'RH' },
        });
        return e;
      });
      res.status(201).json(emp);
    } catch (e) {
      if (String(e.message).includes('unique') || e.code === '23505') {
        return res.status(409).json({ error: 'Ya existe un empleado con ese número o ese PIN' });
      }
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

const TEXTO_BANDERA = {
  sin_foto: 'checada sin foto',
  hora_dispositivo_no_cuadra: 'la hora del dispositivo no cuadra con la del servidor',
  secuencia_irregular: 'checada fuera de secuencia (p. ej. dos entradas seguidas)',
  fuera_de_zona: 'checó lejos del sitio esperado',
  sin_conexion: 'registro enviado sin conexión',
};
