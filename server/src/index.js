import { crearDb } from './db.js';
import { crearApp } from './app.js';

const db = await crearDb();
const puerto = Number(process.env.PORT ?? 3001);

// Servidor nuevo y vacío: si así se configuró, se cargan los datos de demostración una sola vez.
if (process.env.SEMBRAR_DEMO === 'true') {
  const { rows: [existe] } = await db.query('SELECT id FROM empresas LIMIT 1');
  if (!existe) {
    const { sembrarDemo } = await import('./demo.js');
    await sembrarDemo(db);
  }
}

const servidor = crearApp(db).listen(puerto, () => {
  console.log(`Checador 2027 · API en http://localhost:${puerto}`);
  console.log(process.env.DATABASE_URL ? 'Base de datos: PostgreSQL' : 'Base de datos: PGlite');
});

// Cierre ordenado: termina las peticiones en curso y cierra la base (evita bloqueos al reiniciar).
let cerrando = false;
async function cerrar(senal) {
  if (cerrando) return;
  cerrando = true;
  console.log(`Cerrando (${senal})…`);
  servidor.close();
  servidor.closeAllConnections?.();
  try { await db.close(); } catch (e) { console.error(e); }
  process.exit(0);
}
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => cerrar(s));
