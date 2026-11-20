import { crearDb } from './db.js';
import { crearApp } from './app.js';

const db = await crearDb();
const puerto = Number(process.env.PORT ?? 3001);

crearApp(db).listen(puerto, () => {
  console.log(`Checador 2027 · API en http://localhost:${puerto}`);
  console.log(process.env.DATABASE_URL ? 'Base de datos: PostgreSQL' : 'Base de datos: PGlite (desarrollo)');
});
