// Acceso a datos con la misma interfaz para PostgreSQL real (producción) y PGlite (desarrollo).
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
  const db = url ? await conPostgres(url) : await conPglite(dir ?? './data/pglite');
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

async function conPglite(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  let pg;
  if (dir === 'memory') {
    pg = new PGlite();
  } else {
    await mkdir(path.resolve(dir), { recursive: true });
    pg = new PGlite(path.resolve(dir));
  }
  await pg.waitReady;
  return {
    query: (sql, params) => pg.query(sql, params),
    exec: (sql) => pg.exec(sql),
    transaction: (fn) => pg.transaction((tx) => fn({ query: (s, p) => tx.query(s, p) })),
    close: () => pg.close(),
  };
}
