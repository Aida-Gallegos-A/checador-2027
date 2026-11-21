// Consultas de negocio sobre la bitácora. Todo estado (correcciones, firmas) se deriva de eventos.
import {
  alertasSemana, calcularJornadas, calcularSemana, checadasEfectivas,
  fechaLocal, inicioDelDiaLocal, LUGARES_REMOTOS, lunesDe, sumarDias, UMBRAL_NOM037,
} from './lib/jornada.js';

export const TIPOS_CHECADA = ['entrada', 'salida_comida', 'regreso_comida', 'salida'];

/** Qué checadas tienen sentido después de la última. */
const SIGUIENTES = {
  null: ['entrada'],
  entrada: ['salida_comida', 'salida'],
  salida_comida: ['regreso_comida', 'salida'],
  regreso_comida: ['salida_comida', 'salida'],
  salida: ['entrada'],
};

export async function obtenerEmpresa(db, empresaId) {
  const { rows: [empresa] } = await db.query(`SELECT * FROM empresas WHERE id = $1`, [empresaId]);
  return empresa ?? null;
}

export function semanaActual(empresa, fecha) {
  return lunesDe(fecha ?? fechaLocal(new Date(), empresa.zona_horaria));
}

/**
 * Checadas y correcciones aprobadas de la empresa en un rango de fechas locales.
 * Se pide un día de margen a cada lado para no partir turnos nocturnos.
 */
async function eventosDeJornada(db, empresa, desde, hasta, empleadoId = null) {
  const ini = inicioDelDiaLocal(sumarDias(desde, -1), empresa.zona_horaria);
  const fin = inicioDelDiaLocal(sumarDias(hasta, 2), empresa.zona_horaria);
  const { rows } = await db.query(
    `SELECT id, empleado_id, clase, hora, hora_servidor, datos
       FROM bitacora
      WHERE empresa_id = $1 AND clase IN ('checada', 'correccion_aprobada')
        AND hora >= $2 AND hora < $3
        AND ($4::int IS NULL OR empleado_id = $4)
      ORDER BY hora, id`,
    [empresa.id, ini, fin, empleadoId],
  );
  return rows;
}

/** Calcula la semana (lunes a domingo) de cada empleado indicado. */
export async function semanasDeEmpleados(db, empresa, empleados, lunes) {
  const domingo = sumarDias(lunes, 6);
  const eventos = await eventosDeJornada(db, empresa, lunes, domingo, empleados.length === 1 ? empleados[0].id : null);
  // SIMULAR_ANIO permite enseñar en una demo cómo se verá la semana con el tope de otro año.
  const anio = Number(process.env.SIMULAR_ANIO) || Number(lunes.slice(0, 4));

  return empleados.map((emp) => {
    const propios = eventos.filter((e) => e.empleado_id === emp.id);
    const checadas = checadasEfectivas(propios);
    const { jornadas: todas, sueltas } = calcularJornadas(checadas, empresa.zona_horaria);
    const jornadas = todas.filter((j) => j.fecha >= lunes && j.fecha <= domingo);
    const semana = calcularSemana(jornadas, { anio, tipoJornada: emp.tipo_jornada });
    const banderas = propios
      .filter((e) => fechaLocal(e.hora, empresa.zona_horaria) >= lunes && fechaLocal(e.hora, empresa.zona_horaria) <= domingo)
      .flatMap((e) => (e.datos.banderas ?? []).map((b) => ({ bandera: b, evento: e.id, hora: e.hora })));
    return { empleado: emp, lunes, domingo, jornadas, sueltas, semana, alertas: alertasSemana(semana, emp.nombre), banderas };
  });
}

/**
 * Porcentaje de trabajo fuera del centro de trabajo en las 4 semanas que terminan en `lunes`
 * (solo para quien tiene modalidad remota o registró tiempo remoto). Base para la NOM-037.
 */
export async function remotoUltimasSemanas(db, empresa, empleados, lunes, semanas = 4) {
  const acumulado = new Map();
  for (let i = semanas - 1; i >= 0; i--) {
    const l = sumarDias(lunes, -7 * i);
    for (const s of await semanasDeEmpleados(db, empresa, empleados, l)) {
      const a = acumulado.get(s.empleado.id) ?? { total: 0, porLugar: {}, dias: {} };
      a.total += s.semana.total;
      for (const [k, v] of Object.entries(s.semana.horasPorLugar)) a.porLugar[k] = (a.porLugar[k] ?? 0) + v;
      for (const [k, v] of Object.entries(s.semana.diasPorLugar)) a.dias[k] = (a.dias[k] ?? 0) + v;
      acumulado.set(s.empleado.id, a);
    }
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  const resultado = new Map();
  for (const emp of empleados) {
    const a = acumulado.get(emp.id);
    const remoto = LUGARES_REMOTOS.reduce((n, k) => n + (a?.porLugar[k] ?? 0), 0);
    if (!a || (remoto === 0 && !['home_office', 'hibrido'].includes(emp.modalidad))) continue;
    const porcentaje = a.total ? Math.round((remoto / a.total) * 100) : 0;
    resultado.set(emp.id, {
      semanas, desde: sumarDias(lunes, -7 * (semanas - 1)), hasta: sumarDias(lunes, 6),
      horas_totales: r2(a.total), horas_remotas: r2(remoto), porcentaje,
      horas_por_lugar: Object.fromEntries(Object.entries(a.porLugar).map(([k, v]) => [k, r2(v)])),
      dias: a.dias, aplica_nom037: porcentaje > UMBRAL_NOM037,
    });
  }
  return resultado;
}

export async function empleadosActivos(db, empresaId) {
  const { rows } = await db.query(
    `SELECT id, numero, nombre, puesto, telefono, modalidad, tipo_jornada, activo
       FROM empleados WHERE empresa_id = $1 AND activo ORDER BY nombre`,
    [empresaId],
  );
  return rows;
}

/** Última checada efectiva (en 36 h) para validar la secuencia. */
export async function ultimaChecada(db, empresaId, empleadoId) {
  const { rows } = await db.query(
    `SELECT id, clase, hora, datos FROM bitacora
      WHERE empresa_id = $1 AND empleado_id = $2 AND clase IN ('checada', 'correccion_aprobada')
        AND hora > now() - interval '36 hours'
      ORDER BY hora DESC, id DESC LIMIT 1`,
    [empresaId, empleadoId],
  );
  return rows[0] ?? null;
}

export function secuenciaValida(ultimoTipo, tipo) {
  return (SIGUIENTES[ultimoTipo ?? null] ?? ['entrada']).includes(tipo);
}

export function tiposPermitidos(ultimoTipo) {
  return SIGUIENTES[ultimoTipo ?? null] ?? ['entrada'];
}

// ---------- Correcciones ----------

export async function listarCorrecciones(db, empresaId, estado) {
  const { rows } = await db.query(
    `SELECT s.id, s.empleado_id, e.nombre AS empleado, s.hora AS hora_propuesta, s.hora_servidor AS solicitada_en,
            s.datos, o.hora AS hora_original, o.datos->>'tipo' AS tipo_original,
            d.id AS decision_id, d.clase AS decision, d.hora_servidor AS decidida_en, d.datos AS datos_decision
       FROM bitacora s
       JOIN empleados e ON e.id = s.empleado_id
       LEFT JOIN bitacora o ON o.id = (s.datos->>'reemplaza')::int
       LEFT JOIN bitacora d ON d.empresa_id = s.empresa_id
             AND d.clase IN ('correccion_aprobada', 'correccion_rechazada')
             AND (d.datos->>'correccion_id')::int = s.id
      WHERE s.empresa_id = $1 AND s.clase = 'correccion_solicitada'
      ORDER BY s.id DESC`,
    [empresaId],
  );
  const lista = rows.map((r) => ({
    id: r.id,
    empleado_id: r.empleado_id,
    empleado: r.empleado,
    tipo: r.datos.tipo,
    hora_propuesta: r.hora_propuesta,
    motivo: r.datos.motivo,
    solicitado_por: r.datos.solicitado_por,
    solicitada_en: r.solicitada_en,
    original: r.datos.reemplaza ? { id: r.datos.reemplaza, tipo: r.tipo_original, hora: r.hora_original } : null,
    estado: r.decision === 'correccion_aprobada' ? 'aprobada' : r.decision === 'correccion_rechazada' ? 'rechazada' : 'pendiente',
    decision: r.decision_id
      ? { evento: r.decision_id, por: r.datos_decision.decidido_por, en: r.decidida_en, comentario: r.datos_decision.comentario ?? null }
      : null,
  }));
  return estado ? lista.filter((c) => c.estado === estado) : lista;
}

// ---------- Firmas semanales ----------

/** Lo que el trabajador firma: un resumen corto y estable de su semana. */
export function armarResumen(s) {
  return {
    semana: s.lunes,
    domingo: s.domingo,
    dias: s.semana.dias,
    total: s.semana.total,
    ordinarias: s.semana.ordinarias,
    extra_dobles: s.semana.extraDobles,
    extra_triples: s.semana.extraTriples,
    jornadas_incompletas: s.semana.incompletas,
    tope_semanal: s.semana.regla.topeSemanal,
  };
}

/** Estado de firma de la semana por empleado (se toma el último resumen enviado). */
export async function estadoFirmas(db, empresaId, lunes) {
  const { rows: resumenes } = await db.query(
    `SELECT id, empleado_id, hora_servidor, datos FROM bitacora
      WHERE empresa_id = $1 AND clase = 'resumen_enviado' AND datos->>'semana' = $2
      ORDER BY id`,
    [empresaId, lunes],
  );
  if (resumenes.length === 0) return new Map();
  const ids = resumenes.map((r) => r.id);
  const { rows: respuestas } = await db.query(
    `SELECT id, clase, hora_servidor, datos, (datos->>'resumen_id')::int AS resumen_id FROM bitacora
      WHERE empresa_id = $1 AND clase IN ('firma', 'objecion', 'recordatorio')
        AND (datos->>'resumen_id')::int = ANY($2::int[])
      ORDER BY id`,
    [empresaId, ids],
  );

  const porEmpleado = new Map();
  for (const r of resumenes) porEmpleado.set(r.empleado_id, r); // queda el último
  const estado = new Map();
  for (const [empleadoId, r] of porEmpleado) {
    const propias = respuestas.filter((x) => x.resumen_id === r.id);
    const firma = propias.find((x) => x.clase === 'firma');
    const objecion = propias.find((x) => x.clase === 'objecion');
    estado.set(empleadoId, {
      resumen_id: r.id,
      enviado_en: r.hora_servidor,
      resumen: r.datos.resumen,
      estado: firma ? 'firmada' : objecion ? 'objetada' : 'pendiente',
      recordatorios: propias.filter((x) => x.clase === 'recordatorio').length,
      respondido_en: (firma ?? objecion)?.hora_servidor ?? null,
      objecion: objecion?.datos.motivo ?? null,
      reenvios: resumenes.filter((x) => x.empleado_id === empleadoId).length - 1,
    });
  }
  return estado;
}

/** El resumen vigente y el hash del último código enviado para él. */
export async function resumenParaFirmar(db, resumenId) {
  const { rows: [resumen] } = await db.query(
    `SELECT id, empresa_id, empleado_id, hora_servidor, datos FROM bitacora WHERE id = $1 AND clase = 'resumen_enviado'`,
    [resumenId],
  );
  if (!resumen) return null;
  const { rows: posteriores } = await db.query(
    `SELECT id, clase, hora_servidor, datos FROM bitacora
      WHERE empresa_id = $1 AND (
        (clase IN ('firma', 'objecion', 'recordatorio') AND (datos->>'resumen_id')::int = $2)
        OR (clase = 'resumen_enviado' AND empleado_id = $3 AND datos->>'semana' = $4 AND id > $2))
      ORDER BY id`,
    [resumen.empresa_id, resumen.id, resumen.empleado_id, resumen.datos.semana],
  );
  const ultimoCodigo = [resumen, ...posteriores.filter((p) => p.clase === 'recordatorio')].at(-1);
  return {
    ...resumen,
    reemplazado: posteriores.some((p) => p.clase === 'resumen_enviado'),
    respondido: posteriores.find((p) => p.clase === 'firma' || p.clase === 'objecion') ?? null,
    codigo_sal: ultimoCodigo.datos.codigo_sal,
    codigo_hash: ultimoCodigo.datos.codigo_hash,
    codigo_expira: new Date(new Date(ultimoCodigo.hora_servidor).getTime() + 7 * 24 * 3600 * 1000),
  };
}
