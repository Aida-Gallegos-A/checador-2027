// Datos de demostración. Uso: npm run seed            (solo si la base está vacía)
//                              npm run seed -- --reset (borra la base local de PGlite y la vuelve a crear)
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { crearDb } from '../src/db.js';
import { agregarEvento, jsonCanonico, sha256 } from '../src/lib/cadena.js';
import { fechaLocal, inicioDelDiaLocal, lunesDe, sumarDias } from '../src/lib/jornada.js';
import { generarSal, hashCodigo, hashToken, indicePin } from '../src/lib/seguridad.js';
import { armarResumen, empleadosActivos, obtenerEmpresa, semanasDeEmpleados } from '../src/servicios.js';
import { enviarConvenio } from '../src/convenios.js';

const ZONA = 'America/Mexico_City';
const TOKEN_KIOSCO = 'kiosco-demo';

if (process.argv.includes('--reset') && !process.env.DATABASE_URL) {
  const dir = path.resolve(process.env.PGLITE_DIR ?? './data/pglite');
  await rm(dir, { recursive: true, force: true });
  console.log(`Base local borrada: ${dir}`);
}

const db = await crearDb();
const { rows: [existe] } = await db.query(`SELECT id FROM empresas LIMIT 1`);
if (existe) {
  console.log('La base ya tiene datos. Usa "npm run seed -- --reset" para empezar de cero.');
  await db.close();
  process.exit(0);
}

const { rows: [empresa] } = await db.query(
  `INSERT INTO empresas (nombre, zona_horaria, rfc, domicilio, correo_privacidad)
   VALUES ('Seguridad y Logística Demo, S.A. de C.V.', $1, 'SLD200101AB1',
           'Av. Insurgentes Sur 1000, Col. Del Valle, Benito Juárez, 03100, Ciudad de México', 'privacidad@demo.mx')
   RETURNING *`,
  [ZONA],
);
const E = empresa.id;
await db.query(
  `INSERT INTO centros (empresa_id, nombre, token_kiosco_hash) VALUES ($1, 'Oficina central', $2)`,
  [E, hashToken(TOKEN_KIOSCO)],
);

const personas = [
  { numero: '001', nombre: 'Juan Pérez', puesto: 'Almacenista', modalidad: 'presencial', pin: '1234', telefono: '+525500000001' },
  { numero: '002', nombre: 'Ana López', puesto: 'Recepcionista', modalidad: 'presencial', pin: '5678', telefono: '+525500000002' },
  { numero: '003', nombre: 'Pedro Ramírez', puesto: 'Guardia (12x12)', modalidad: 'campo', pin: '4321', telefono: '+525500000003' },
  { numero: '004', nombre: 'María Torres', puesto: 'Analista', modalidad: 'home_office', pin: '8765', telefono: '+525500000004' },
];
const emp = {};
for (const p of personas) {
  const { rows: [r] } = await db.query(
    `INSERT INTO empleados (empresa_id, numero, nombre, puesto, telefono, modalidad, pin_indice)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [E, p.numero, p.nombre, p.puesto, p.telefono, p.modalidad, indicePin(E, p.pin)],
  );
  emp[p.pin] = r.id;
  await db.transaction((tx) => agregarEvento(tx, {
    empresa_id: E, empleado_id: r.id, clase: 'nota',
    datos: { asunto: 'alta_empleado', numero: p.numero, nombre: p.nombre, modalidad: p.modalidad, tipo_jornada: 'diurna', registrado_por: 'Demo' },
  }));
  // Convenio enviado por WhatsApp; Juan, Ana y Pedro ya lo firmaron, María está pendiente.
  const { convenio_id } = await enviarConvenio(db, empresa, { id: r.id, ...p, tipo_jornada: 'diurna' }, { enviadoPor: 'Demo' });
  if (p.pin !== '8765') {
    const { rows: [conv] } = await db.query(`SELECT datos FROM bitacora WHERE id = $1`, [convenio_id]);
    await db.transaction((tx) => agregarEvento(tx, {
      empresa_id: E, empleado_id: r.id, clase: 'convenio_firmado',
      datos: {
        convenio_id, version: conv.datos.version, hash_documentos: conv.datos.hash_documentos,
        documentos: conv.datos.documentos.map(({ clave, hash }) => ({ clave, hash })),
        metodo: 'codigo_whatsapp', telefono: p.telefono, ip: '187.190.0.1', agente: 'demo',
      },
    }));
  }
}

/** Instante local: fecha 'YYYY-MM-DD' + 'HH:MM'. */
const en = (fecha, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(inicioDelDiaLocal(fecha, ZONA).getTime() + (h * 60 + m) * 60000);
};

const ids = {};
async function checar(pin, fecha, tipo, hhmm, extra = {}) {
  const ev = await db.transaction((tx) => agregarEvento(tx, {
    empresa_id: E, empleado_id: emp[pin], clase: 'checada', hora: en(fecha, hhmm),
    datos: { tipo, origen: extra.origen ?? 'demo', evidencia: extra.evidencia ?? {}, banderas: extra.banderas ?? [] },
  }));
  ids[`${pin}:${fecha}:${tipo}`] = ev.id;
  return ev;
}

const hoy = fechaLocal(new Date(), ZONA);
const lunesActual = lunesDe(hoy);
const lunesPasado = sumarDias(lunesActual, -7);

// Días a generar: toda la semana pasada y la actual hasta ayer.
const dias = [];
for (let d = lunesPasado; d < hoy; d = sumarDias(d, 1)) dias.push(d);

for (const fecha of dias) {
  const dow = new Date(`${fecha}T12:00:00Z`).getUTCDay(); // 0 domingo … 6 sábado
  const semanaPasada = fecha < lunesActual;

  // Juan: lunes a sábado, 8 a 17 con comida → 48 h, rebasa el tope de 46 h de 2027.
  if (dow >= 1 && dow <= 6) {
    await checar('1234', fecha, 'entrada', dow === 2 ? '08:12' : '07:58');
    await checar('1234', fecha, 'salida_comida', '13:00');
    await checar('1234', fecha, 'regreso_comida', '14:00');
    await checar('1234', fecha, 'salida', '17:02');
  }

  // Ana: lunes a viernes, 9 a 18 con comida. El miércoles de esta semana olvidó checar salida.
  if (dow >= 1 && dow <= 5) {
    await checar('5678', fecha, 'entrada', '08:55');
    await checar('5678', fecha, 'salida_comida', '14:00');
    await checar('5678', fecha, 'regreso_comida', '15:00');
    if (!(dow === 3 && !semanaPasada)) await checar('5678', fecha, 'salida', '18:03');
  }

  // Pedro: guardia 12x12, cuatro turnos por semana (lun, mar, jue, vie). Paga extra doble y triple.
  if ([1, 2, 4, 5].includes(dow)) {
    const gps = { lat: 19.4326, lng: -99.1332, precision_m: 12 };
    await checar('4321', fecha, 'entrada', '07:00', { origen: 'app', evidencia: { gps } });
    const lejos = dow === 4 && semanaPasada;
    await checar('4321', fecha, 'salida', '19:05', {
      origen: 'app',
      evidencia: { gps: lejos ? { lat: 19.36, lng: -99.18, precision_m: 30 } : gps },
      banderas: lejos ? ['fuera_de_zona'] : [],
    });
  }

  // María: home office, lunes a viernes, 9 a 17 con pausa.
  if (dow >= 1 && dow <= 5) {
    const evidencia = { ip: '201.141.0.10', dispositivo: 'Navegador web' };
    await checar('8765', fecha, 'entrada', '09:00', { origen: 'web', evidencia });
    await checar('8765', fecha, 'salida_comida', '14:00', { origen: 'web', evidencia });
    await checar('8765', fecha, 'regreso_comida', '14:45', { origen: 'web', evidencia });
    await checar('8765', fecha, 'salida', '17:45', { origen: 'web', evidencia });
  }
}

// Corrección pendiente: Ana pide registrar la salida que olvidó el miércoles.
const miercoles = sumarDias(lunesActual, 2);
if (miercoles < hoy) {
  await db.transaction((tx) => agregarEvento(tx, {
    empresa_id: E, empleado_id: emp['5678'], clase: 'correccion_solicitada', hora: en(miercoles, '18:00'),
    datos: { tipo: 'salida', reemplaza: null, motivo: 'Olvidé checar al salir, me fui a las 6 pm', solicitado_por: 'Ana López' },
  }));
}
// Corrección pendiente: Juan dice que el martes pasado llegó a las 8:00, no a las 8:12.
const martesPasado = sumarDias(lunesPasado, 1);
await db.transaction((tx) => agregarEvento(tx, {
  empresa_id: E, empleado_id: emp['1234'], clase: 'correccion_solicitada', hora: en(martesPasado, '08:00'),
  datos: { tipo: 'entrada', reemplaza: ids[`1234:${martesPasado}:entrada`], motivo: 'La tablet no reconoció mi PIN a la primera; llegué a las 8:00', solicitado_por: 'Juan Pérez' },
}));

// Firmas de la semana pasada: Juan firma, María objeta, Ana y Pedro pendientes.
const empresaRow = await obtenerEmpresa(db, E);
const semanas = await semanasDeEmpleados(db, empresaRow, await empleadosActivos(db, E), lunesPasado);
async function enviarResumen(pin) {
  const resumen = armarResumen(semanas.find((s) => s.empleado.id === emp[pin]));
  const sal = generarSal();
  return db.transaction((tx) => agregarEvento(tx, {
    empresa_id: E, empleado_id: emp[pin], clase: 'resumen_enviado',
    datos: { semana: lunesPasado, resumen, hash_resumen: sha256(jsonCanonico(resumen)), codigo_sal: sal, codigo_hash: hashCodigo(sal, '000000'), canal: 'whatsapp' },
  }));
}
const rJuan = await enviarResumen('1234');
await enviarResumen('5678');
const rPedro = await enviarResumen('4321');
const rMaria = await enviarResumen('8765');

await db.transaction((tx) => agregarEvento(tx, {
  empresa_id: E, empleado_id: emp['1234'], clase: 'firma',
  datos: { resumen_id: rJuan.id, semana: lunesPasado, hash_resumen: rJuan.datos.hash_resumen, metodo: 'codigo_whatsapp', demo: true },
}));
await db.transaction((tx) => agregarEvento(tx, {
  empresa_id: E, empleado_id: emp['8765'], clase: 'objecion',
  datos: { resumen_id: rMaria.id, semana: lunesPasado, hash_resumen: rMaria.datos.hash_resumen, motivo: 'El jueves mi jefe me llamó a las 7:30 pm por un reporte urgente; fue casi una hora más.', demo: true },
}));
await db.transaction((tx) => agregarEvento(tx, {
  empresa_id: E, empleado_id: emp['4321'], clase: 'recordatorio',
  datos: { resumen_id: rPedro.id, numero: 1, codigo_sal: 'demo', codigo_hash: hashCodigo('demo', '000000'), canal: 'whatsapp' },
}));

const { rows: [{ total }] } = await db.query(`SELECT count(*)::int AS total FROM bitacora`);
console.log(`Listo: empresa demo, 4 empleados, ${total} eventos en la bitácora.`);
console.log(`Kiosco: token "${TOKEN_KIOSCO}" · PINs 1234 Juan, 5678 Ana, 4321 Pedro, 8765 María`);
console.log(`Panel de RH: token "${process.env.RH_TOKEN ?? 'rh-demo'}"`);
await db.close();
