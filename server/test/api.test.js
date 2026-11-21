// Prueba de punta a punta contra una base PGlite en memoria.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crearDb } from '../src/db.js';
import { crearApp } from '../src/app.js';
import { verificarCadena } from '../src/lib/cadena.js';
import { hashToken, indicePin } from '../src/lib/seguridad.js';

let db, server, base, storage;
const RH = { authorization: 'Bearer rh-prueba', 'content-type': 'application/json' };
const KIOSCO = { 'x-kiosco-token': 'kiosco-prueba', 'content-type': 'application/json' };
const FOTO = 'data:image/jpeg;base64,' + Buffer.from('foto-de-prueba').toString('base64');

const api = async (metodo, ruta, headers, body) => {
  const r = await fetch(base + ruta, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined });
  const tipo = r.headers.get('content-type') ?? '';
  return { status: r.status, body: tipo.includes('json') ? await r.json() : await r.text() };
};

before(async () => {
  storage = await mkdtemp(path.join(tmpdir(), 'checador-'));
  Object.assign(process.env, { RH_TOKEN: 'rh-prueba', APP_SECRET: 'prueba', STORAGE_DIR: storage, MODO_DEMO: 'true', EMPRESA_ID: '1' });
  delete process.env.SIMULAR_ANIO;
  db = await crearDb({ url: '', dir: 'memory' });
  await db.query(`INSERT INTO empresas (nombre) VALUES ('Prueba')`);
  await db.query(`INSERT INTO centros (empresa_id, nombre, token_kiosco_hash) VALUES (1, 'Entrada', $1)`, [hashToken('kiosco-prueba')]);
  await db.query(
    `INSERT INTO empleados (empresa_id, numero, nombre, modalidad, telefono, pin_indice) VALUES (1, '1', 'Juan Pérez', 'presencial', '+52', $1)`,
    [indicePin(1, '1234')],
  );
  server = crearApp(db).listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  server?.close();
  await db?.close();
  await rm(storage, { recursive: true, force: true });
});

test('kiosco: PIN → nombre → checada con foto y hora del servidor', async () => {
  const sinToken = await api('POST', '/kiosco/identificar', { 'content-type': 'application/json' }, { pin: '1234' });
  assert.equal(sinToken.status, 401);

  const malo = await api('POST', '/kiosco/identificar', KIOSCO, { pin: '9999' });
  assert.equal(malo.status, 404);

  const id = await api('POST', '/kiosco/identificar', KIOSCO, { pin: '1234' });
  assert.equal(id.status, 200);
  assert.equal(id.body.empleado.nombre, 'Juan Pérez');
  assert.deepEqual(id.body.permitidos, ['entrada']);

  const antes = Date.now();
  const r = await api('POST', '/kiosco/checar', KIOSCO, {
    pin: '1234', tipo: 'entrada', foto: FOTO, hora_dispositivo: new Date(Date.now() - 3600_000).toISOString(),
  });
  assert.equal(r.status, 201);
  assert.ok(new Date(r.body.hora).getTime() >= antes - 1000, 'la hora es la del servidor, no la del dispositivo');
  assert.deepEqual(r.body.banderas, ['hora_dispositivo_no_cuadra']);

  const dosEntradas = await api('POST', '/kiosco/checar', KIOSCO, { pin: '1234', tipo: 'entrada', foto: FOTO });
  assert.deepEqual(dosEntradas.body.banderas, ['secuencia_irregular']);
});

test('la bitácora no se puede editar ni borrar', async () => {
  await assert.rejects(db.query(`UPDATE bitacora SET datos = '{}' WHERE id = 1`), /no se puede modificar/);
  await assert.rejects(db.query(`DELETE FROM bitacora WHERE id = 1`), /no se puede modificar/);
});

test('corrección: se solicita, se aprueba una vez y queda en la cadena', async () => {
  const sol = await api('POST', '/rh/correcciones', RH, {
    empleado_id: 1, tipo: 'salida', hora: new Date(Date.now() - 60_000).toISOString(),
    motivo: 'Olvidé checar', solicitado_por: 'Juan Pérez',
  });
  assert.equal(sol.status, 201);
  const pend = await api('GET', '/rh/correcciones?estado=pendiente', RH);
  assert.equal(pend.body.length, 1);

  const ok = await api('POST', `/rh/correcciones/${sol.body.id}/decidir`, RH, { aprobar: true, decidido_por: 'Supervisora' });
  assert.equal(ok.status, 200);
  const otra = await api('POST', `/rh/correcciones/${sol.body.id}/decidir`, RH, { aprobar: false, decidido_por: 'Otro' });
  assert.equal(otra.status, 409);

  const futura = await api('POST', '/rh/correcciones', RH, {
    empleado_id: 1, tipo: 'salida', hora: new Date(Date.now() + 3600_000).toISOString(), motivo: 'x', solicitado_por: 'y',
  });
  assert.equal(futura.status, 400);
});

test('firma semanal: código incorrecto se rechaza, el correcto firma una sola vez', async () => {
  const env = await api('POST', '/rh/firmas/enviar', RH, {});
  assert.equal(env.status, 200);
  const [{ resumen_id, codigo_demo }] = env.body.enviados;

  const mal = await api('POST', `/firmas/${resumen_id}/confirmar`, { 'content-type': 'application/json' }, { codigo: '000000' === codigo_demo ? '111111' : '000000' });
  assert.equal(mal.status, 403);

  const bien = await api('POST', `/firmas/${resumen_id}/confirmar`, { 'content-type': 'application/json' }, { codigo: codigo_demo });
  assert.equal(bien.status, 201);
  const otraVez = await api('POST', `/firmas/${resumen_id}/confirmar`, { 'content-type': 'application/json' }, { codigo: codigo_demo });
  assert.equal(otraVez.status, 409);

  const firmas = await api('GET', '/rh/firmas', RH);
  assert.equal(firmas.body.firmas[0].estado, 'firmada');
});

test('resumen de RH y nómina responden', async () => {
  const r = await api('GET', '/rh/resumen', RH);
  assert.equal(r.status, 200);
  assert.equal(r.body.empleados.length, 1);
  assert.equal(r.body.indicadores.semanas_firmadas, 1);
  const csv = await api('GET', '/rh/nomina.csv', RH);
  assert.match(csv.body, /horas_ordinarias/);
});

test('empleados: alta con PIN generado, cambio de PIN, edición y baja', async () => {
  const alta = await api('POST', '/rh/empleados', RH, { numero: '2', nombre: 'Luisa Díaz', modalidad: 'campo', telefono: '55 1234 5678' });
  assert.equal(alta.status, 201);
  assert.match(alta.body.pin, /^\d{4}$/);

  const dup = await api('POST', '/rh/empleados', RH, { numero: '2', nombre: 'Otra', modalidad: 'presencial' });
  assert.equal(dup.status, 409);
  const pinUsado = await api('POST', '/rh/empleados', RH, { numero: '3', nombre: 'Otra', modalidad: 'presencial', pin: '1234' });
  assert.equal(pinUsado.status, 409);
  const mala = await api('POST', '/rh/empleados', RH, { numero: '4', nombre: 'X', modalidad: 'oficina' });
  assert.equal(mala.status, 400);

  const id = (await api('POST', '/kiosco/identificar', KIOSCO, { pin: alta.body.pin })).body.empleado.id;
  assert.equal(id, alta.body.id);

  const nuevo = await api('POST', `/rh/empleados/${id}/pin`, RH, {});
  assert.notEqual(nuevo.body.pin, alta.body.pin);
  assert.equal((await api('POST', '/kiosco/identificar', KIOSCO, { pin: alta.body.pin })).status, 404);

  const edit = await api('PATCH', `/rh/empleados/${id}`, RH, { puesto: 'Técnica', tipo_jornada: 'nocturna' });
  assert.equal(edit.body.tipo_jornada, 'nocturna');

  const baja = await api('PATCH', `/rh/empleados/${id}`, RH, { activo: false, motivo: 'Renuncia' });
  assert.equal(baja.body.activo, false);
  assert.equal((await api('POST', '/kiosco/identificar', KIOSCO, { pin: nuevo.body.pin })).status, 404, 'una baja ya no puede checar');

  const { rows } = await db.query(`SELECT datos->>'asunto' AS asunto FROM bitacora WHERE empleado_id = $1 AND clase = 'nota' ORDER BY id`, [id]);
  assert.deepEqual(rows.map((r) => r.asunto), ['alta_empleado', 'cambio_pin', 'cambio_empleado', 'baja_empleado']);
});

test('la cadena está íntegra y detecta una alteración directa en la base', async () => {
  const v = await api('GET', '/rh/cadena/verificar', RH);
  assert.equal(v.body.integra, true);
  assert.ok(v.body.total >= 6);

  // Simula a alguien con acceso directo a la base que desactiva el trigger y cambia una hora.
  await db.exec(`ALTER TABLE bitacora DISABLE TRIGGER trg_bitacora_inmutable`);
  await db.query(`UPDATE bitacora SET hora = hora - interval '1 hour' WHERE id = 1`);
  await db.exec(`ALTER TABLE bitacora ENABLE TRIGGER trg_bitacora_inmutable`);

  const alterada = await verificarCadena(db, 1);
  assert.equal(alterada.integra, false);
  assert.equal(alterada.problemas[0].id, 1);
});
