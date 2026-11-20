// Bitácora encadenada: cada evento guarda el hash del anterior.
// Si alguien altera, borra o reordena un evento directamente en la base, la verificación lo detecta.
import { createHash } from 'node:crypto';

export const HASH_GENESIS = '0'.repeat(64);

/** JSON con llaves ordenadas, para que el hash no dependa del orden en que Postgres guarda el jsonb. */
export function jsonCanonico(valor) {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor);
  if (valor instanceof Date) return JSON.stringify(valor.toISOString());
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(',')}]`;
  const llaves = Object.keys(valor).filter((k) => valor[k] !== undefined).sort();
  return `{${llaves.map((k) => `${JSON.stringify(k)}:${jsonCanonico(valor[k])}`).join(',')}}`;
}

export function sha256(texto) {
  return createHash('sha256').update(texto).digest('hex');
}

const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();

/** Hash de un evento. Incluye el id, así que reordenar eventos también rompe la cadena. */
export function hashEvento(e) {
  return sha256(
    jsonCanonico({
      id: e.id,
      empresa_id: e.empresa_id,
      empleado_id: e.empleado_id ?? null,
      clase: e.clase,
      hora: iso(e.hora),
      hora_servidor: iso(e.hora_servidor),
      datos: e.datos ?? {},
      prev_hash: e.prev_hash,
    }),
  );
}

/**
 * Agrega un evento a la bitácora dentro de una transacción.
 * @param {import('../db.js').Consulta} tx
 * @param {{ empresa_id: number, empleado_id?: number|null, clase: string, hora?: Date, datos?: object }} evento
 */
export async function agregarEvento(tx, { empresa_id, empleado_id = null, clase, hora, datos = {} }) {
  // Bloquea la cabeza de la cadena de esta empresa (la crea si es el primer evento).
  await tx.query(
    `INSERT INTO cadena_cabeza (empresa_id, ultimo_hash) VALUES ($1, $2) ON CONFLICT (empresa_id) DO NOTHING`,
    [empresa_id, HASH_GENESIS],
  );
  const { rows: [cabeza] } = await tx.query(
    `SELECT ultimo_hash FROM cadena_cabeza WHERE empresa_id = $1 FOR UPDATE`,
    [empresa_id],
  );
  const { rows: [{ id }] } = await tx.query(`SELECT nextval('bitacora_id_seq')::int AS id`);

  const hora_servidor = new Date();
  const evento = {
    id,
    empresa_id,
    empleado_id,
    clase,
    hora: hora ?? hora_servidor,
    hora_servidor,
    datos,
    prev_hash: cabeza.ultimo_hash,
  };
  evento.hash = hashEvento(evento);

  await tx.query(
    `INSERT INTO bitacora (id, empresa_id, empleado_id, clase, hora, hora_servidor, datos, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, empresa_id, empleado_id, clase, evento.hora, hora_servidor, JSON.stringify(datos), evento.prev_hash, evento.hash],
  );
  await tx.query(
    `UPDATE cadena_cabeza SET ultimo_hash = $2, ultimo_id = $3, total = total + 1 WHERE empresa_id = $1`,
    [empresa_id, evento.hash, id],
  );
  return evento;
}

/**
 * Recorre toda la cadena de una empresa y reporta el primer problema encontrado.
 * @returns {Promise<{ integra: boolean, total: number, ultimo_hash: string, problemas: Array<{ id: number, problema: string }> }>}
 */
export async function verificarCadena(db, empresa_id) {
  const { rows } = await db.query(
    `SELECT id, empresa_id, empleado_id, clase, hora, hora_servidor, datos, prev_hash, hash
       FROM bitacora WHERE empresa_id = $1 ORDER BY id`,
    [empresa_id],
  );
  const { rows: [cabeza] } = await db.query(
    `SELECT ultimo_hash, ultimo_id, total FROM cadena_cabeza WHERE empresa_id = $1`,
    [empresa_id],
  );

  const problemas = [];
  let previo = HASH_GENESIS;
  for (const e of rows) {
    if (e.prev_hash !== previo) {
      problemas.push({ id: e.id, problema: 'El hash previo no coincide: falta o se alteró un evento anterior' });
    }
    if (hashEvento(e) !== e.hash) {
      problemas.push({ id: e.id, problema: 'El contenido del evento fue alterado' });
    }
    previo = e.hash;
  }

  const ultimo_hash = rows.at(-1)?.hash ?? HASH_GENESIS;
  if (cabeza && (cabeza.ultimo_hash !== ultimo_hash || cabeza.total !== rows.length)) {
    problemas.push({ id: cabeza.ultimo_id, problema: 'Faltan eventos al final de la cadena' });
  }

  return { integra: problemas.length === 0, total: rows.length, ultimo_hash, problemas };
}
