// Motor de jornada: convierte checadas en jornadas y semanas, con el tope legal de cada año.
// Las reglas son datos (no código) para poder ajustarlas cuando la STPS publique sus lineamientos.

/** Tope semanal y máximo de horas extra por semana según la reforma a la LFT. */
export const REGLAS_POR_ANIO = {
  2026: { topeSemanal: 48, extraMaxSemanal: 9 },
  2027: { topeSemanal: 46, extraMaxSemanal: 9 },
  2028: { topeSemanal: 44, extraMaxSemanal: 10 },
  2029: { topeSemanal: 42, extraMaxSemanal: 11 },
  2030: { topeSemanal: 40, extraMaxSemanal: 12 },
};

/** Jornada diaria máxima (horas) por tipo, art. 61 LFT. */
export const JORNADA_DIARIA = { diurna: 8, nocturna: 7, mixta: 7.5 };

export function reglaDelAnio(anio) {
  const anios = Object.keys(REGLAS_POR_ANIO).map(Number);
  const a = Math.min(Math.max(anio, Math.min(...anios)), Math.max(...anios));
  return { anio, ...REGLAS_POR_ANIO[a] };
}

// ---------- Fechas (siempre en la zona horaria de la empresa) ----------

/** 'YYYY-MM-DD' de un instante en la zona horaria dada. */
export function fechaLocal(instante, zona = 'America/Mexico_City') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(instante));
}

export function sumarDias(fecha, dias) {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Lunes de la semana a la que pertenece una fecha 'YYYY-MM-DD'. */
export function lunesDe(fecha) {
  const dia = new Date(`${fecha}T00:00:00Z`).getUTCDay(); // 0 = domingo
  return sumarDias(fecha, dia === 0 ? -6 : 1 - dia);
}

/**
 * Instante UTC en que empieza una fecha local. Sirve para consultar rangos en la base.
 * Se resuelve probando el desfase de la zona en ese día (México ya no tiene horario de verano,
 * pero así funciona para cualquier zona).
 */
export function inicioDelDiaLocal(fecha, zona = 'America/Mexico_City') {
  const guess = new Date(`${fecha}T00:00:00Z`);
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(guess);
  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  const comoLocal = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess.getTime() - (comoLocal - guess.getTime()));
}

const horas = (min) => Math.round((min / 60) * 100) / 100;

// ---------- Checadas efectivas ----------

/**
 * A partir de eventos de bitácora (`checada` y `correccion_aprobada`) obtiene las checadas que cuentan.
 * Una corrección con `reemplaza` sustituye a esa checada; sin `reemplaza`, agrega una que faltaba.
 * Los originales nunca se borran de la bitácora: solo dejan de contar para el cálculo.
 */
export function checadasEfectivas(eventos) {
  const reemplazadas = new Set(
    eventos.filter((e) => e.clase === 'correccion_aprobada' && e.datos.reemplaza).map((e) => e.datos.reemplaza),
  );
  return eventos
    .filter((e) => e.clase === 'checada' || e.clase === 'correccion_aprobada')
    .filter((e) => !reemplazadas.has(e.id))
    .map((e) => ({
      id: e.id,
      tipo: e.datos.tipo,
      hora: new Date(e.hora),
      origen: e.clase === 'correccion_aprobada' ? 'correccion' : e.datos.origen,
      banderas: e.datos.banderas ?? [],
      corregida: e.clase === 'correccion_aprobada',
    }))
    .sort((a, b) => a.hora - b.hora);
}

// ---------- Jornadas ----------

/**
 * Agrupa checadas ordenadas en jornadas. La jornada pertenece al día local de su entrada
 * (un turno nocturno que cruza la medianoche cuenta para el día en que empezó).
 * Una jornada sin salida queda `incompleta`: nunca se cierra sola con una hora inventada.
 */
export function calcularJornadas(checadas, zona = 'America/Mexico_City') {
  const jornadas = [];
  const sueltas = [];
  let actual = null;

  const cerrar = (incidencia) => {
    if (incidencia) actual.incidencias.push(incidencia);
    jornadas.push(finalizar(actual));
    actual = null;
  };

  for (const c of checadas) {
    const t = c.hora.getTime();
    switch (c.tipo) {
      case 'entrada':
        if (actual) cerrar('entrada_sin_salida');
        actual = {
          fecha: fechaLocal(c.hora, zona), entrada: c.hora, salida: null,
          msTrabajados: 0, msComida: 0, inicioTramo: t, inicioComida: null,
          incidencias: [], checadas: [c.id],
        };
        break;
      case 'salida_comida':
        if (!actual || actual.inicioComida !== null) { sueltas.push({ checada: c.id, incidencia: 'salida_comida_sin_jornada' }); break; }
        actual.checadas.push(c.id);
        actual.msTrabajados += t - actual.inicioTramo;
        actual.inicioTramo = null;
        actual.inicioComida = t;
        break;
      case 'regreso_comida':
        if (!actual || actual.inicioComida === null) { sueltas.push({ checada: c.id, incidencia: 'regreso_comida_sin_salida' }); break; }
        actual.checadas.push(c.id);
        actual.msComida += t - actual.inicioComida;
        actual.inicioComida = null;
        actual.inicioTramo = t;
        break;
      case 'salida':
        if (!actual) { sueltas.push({ checada: c.id, incidencia: 'salida_sin_entrada' }); break; }
        actual.checadas.push(c.id);
        if (actual.inicioComida !== null) {
          actual.msComida += t - actual.inicioComida;
          actual.incidencias.push('salio_sin_regresar_de_comida');
        } else {
          actual.msTrabajados += t - actual.inicioTramo;
        }
        actual.salida = c.hora;
        actual.inicioTramo = null;
        actual.inicioComida = null;
        cerrar();
        break;
      default:
        sueltas.push({ checada: c.id, incidencia: 'tipo_desconocido' });
    }
  }
  if (actual) {
    actual.incidencias.push('sin_salida');
    jornadas.push(finalizar(actual));
  }
  return { jornadas, sueltas };
}

function finalizar(j) {
  const incompleta = j.salida === null;
  return {
    fecha: j.fecha,
    entrada: j.entrada,
    salida: j.salida,
    // Si está incompleta solo cuentan los tramos cerrados; el resto lo resuelve una corrección.
    minutosTrabajados: Math.round(j.msTrabajados / 60000),
    minutosComida: Math.round(j.msComida / 60000),
    incompleta,
    incidencias: j.incidencias,
    checadas: j.checadas,
  };
}

// ---------- Semana ----------

/**
 * Separa horas ordinarias, extra dobles y extra triples.
 * - Ordinario diario: hasta la jornada máxima del tipo (8 h diurna, 7 h nocturna, 7.5 h mixta).
 * - Ordinario semanal: lo anterior, con tope en el máximo semanal del año.
 * - Todo lo demás es extra: dobles hasta el máximo semanal de extra del año; lo que pase, triples.
 * La regla del año se toma del lunes de la semana.
 */
export function calcularSemana(jornadas, { anio, tipoJornada = 'diurna' }) {
  const regla = reglaDelAnio(anio);
  const diariaMin = (JORNADA_DIARIA[tipoJornada] ?? 8) * 60;

  let totalMin = 0;
  let ordinariasDiariasMin = 0;
  for (const j of jornadas) {
    totalMin += j.minutosTrabajados;
    ordinariasDiariasMin += Math.min(j.minutosTrabajados, diariaMin);
  }
  const ordinariasMin = Math.min(ordinariasDiariasMin, regla.topeSemanal * 60);
  const extraMin = totalMin - ordinariasMin;
  const doblesMin = Math.min(extraMin, regla.extraMaxSemanal * 60);
  const triplesMin = extraMin - doblesMin;

  return {
    regla,
    dias: jornadas.length,
    total: horas(totalMin),
    ordinarias: horas(ordinariasMin),
    extraDobles: horas(doblesMin),
    extraTriples: horas(triplesMin),
    incompletas: jornadas.filter((j) => j.incompleta).length,
  };
}

/** Alertas para actuar antes de incumplir. */
export function alertasSemana(semana, nombre = 'El trabajador') {
  const { regla } = semana;
  const extra = semana.extraDobles + semana.extraTriples;
  const alertas = [];
  if (semana.extraTriples > 0) {
    alertas.push({ nivel: 'critica', codigo: 'extra_triple', mensaje: `${nombre} rebasó ${regla.extraMaxSemanal} h extra: ${semana.extraTriples} h se pagan triples` });
  } else if (extra >= regla.extraMaxSemanal - 1 && extra > 0) {
    alertas.push({ nivel: 'alta', codigo: 'extra_cerca_maximo', mensaje: `${nombre} ya trae ${extra} h extra de ${regla.extraMaxSemanal} permitidas` });
  }
  if (semana.total >= regla.topeSemanal - 2 && semana.total <= regla.topeSemanal) {
    alertas.push({ nivel: 'media', codigo: 'cerca_tope', mensaje: `${nombre} lleva ${semana.total} de ${regla.topeSemanal} h esta semana` });
  }
  if (semana.incompletas > 0) {
    alertas.push({ nivel: 'media', codigo: 'salida_faltante', mensaje: `${nombre} tiene ${semana.incompletas} jornada(s) sin salida registrada` });
  }
  return alertas;
}
