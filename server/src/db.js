// Acceso a datos con la misma interfaz para PostgreSQL real (producción) y PGlite (desarrollo).
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rutaDatos } from './lib/rutas.js';

const SCHEMA = fileURLToPath(new URL('./schema.sql', import.meta.url));

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Consulta
 * @typedef {Consulta & {
 *   exec: (sql: string) => Promise<unknown>,
 *   transaction: <T>(fn: (tx: Consulta) => Promise<T>) => Promise<T>,
 *   close: () => Promise<void>
 * }} Db
 */

/** @returns {Promise<Db>} */
export async function crearDb({ url = process.env.DATABASE_URL, dir = process.env.PGLITE_DIR } = {}) {
  const db = url ? await conPostgres(url) : await conPglite(dir === 'memory' ? 'memory' : rutaDatos(dir, './data/pglite'));
  await db.exec(await readFile(SCHEMA, 'utf8'));
  return db;
}

async function conPostgres(url) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url });
  return {
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await fn({ query: (s, p) => client.query(s, p) });
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/**
 * PGlite corre dentro del proceso: solo un proceso puede abrir la carpeta a la vez.
 * Guardamos nuestro PID en `<carpeta>.lock`. Si otro proceso vivo la tiene, no arrancamos.
 * Si el dueño anterior ya murió (en Windows `node --watch` mata el proceso sin cerrar la base),
 * su postmaster.pid quedó huérfano y PGlite no arrancaría: entonces sí es seguro quitarlo.
 */
async function tomarBloqueo(ruta) {
  const candado = `${ruta}.lock`;
  if (existsSync(candado)) {
    const dueno = Number((await readFile(candado, 'utf8')).trim());
    if (dueno && dueno !== process.pid && procesoVivo(dueno)) {
      throw new Error(`La base local ya está abierta por otro servidor (proceso ${dueno}). Ciérralo antes de iniciar éste (si ya no existe, borra ${candado}).`);
    }
  }
  const pid = path.join(ruta, 'postmaster.pid');
  if (existsSync(pid)) {
    await rm(pid, { force: true });
    console.warn('PGlite: se quitó el bloqueo de un cierre anterior.');
  }
  await writeFile(candado, String(process.pid));
  const soltar = () => { try { rmSync(candado, { force: true }); } catch { /* ya no existe */ } };
  process.once('exit', soltar);
}

function procesoVivo(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function conPglite(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  let pg;
  if (dir === 'memory') {
    pg = new PGlite();
  } else {
    const ruta = dir;
    await mkdir(ruta, { recursive: true });
    await tomarBloqueo(ruta);
    pg = new PGlite(ruta);
  }
  await pg.waitReady;
  return {
    query: (sql, params) => pg.query(sql, params),
    exec: (sql) => pg.exec(sql),
    transaction: (fn) => pg.transaction((tx) => fn({ query: (s, p) => tx.query(s, p) })),
    close: () => pg.close(),
  };
}
