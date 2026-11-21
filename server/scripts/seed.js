// Datos de demostración. Uso: npm run seed            (solo si la base está vacía)
//                              npm run seed -- --reset (borra la base local de PGlite y la vuelve a crear)
import { rm } from 'node:fs/promises';
import { dirBase } from '../src/lib/rutas.js';
import { crearDb } from '../src/db.js';
import { sembrarDemo } from '../src/demo.js';

if (process.argv.includes('--reset') && !process.env.DATABASE_URL) {
  const dir = dirBase();
  await rm(dir, { recursive: true, force: true });
  await rm(`${dir}.lock`, { force: true });
  console.log(`Base local borrada: ${dir}`);
}

const db = await crearDb();
const { rows: [existe] } = await db.query('SELECT id FROM empresas LIMIT 1');
if (existe) {
  console.log('La base ya tiene datos. Usa "npm run seed -- --reset" para empezar de cero.');
} else {
  await sembrarDemo(db);
}
await db.close();
