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

test('importación: vista previa sin guardar, errores por fila, alta y actualización', async () => {
  const filas = [
    { fila: 2, numero: '010', nombre: '  Laura   Méndez ', modalidad: 'Campo', jornada: 'Nocturna', telefono: '55 1234 5678' },
    { fila: 3, numero: '011', nombre: 'Carlos Ortiz', modalidad: 'oficina', telefono: '' },
    { fila: 4, numero: '012', nombre: 'Sofía Herrera', modalidad: 'Home Office', pin: '77' },
    { fila: 5, numero: '010', nombre: 'Repetido', modalidad: 'Campo' },
    { fila: 6, numero: '', nombre: 'Sin número', modalidad: 'marte' },
    { fila: 7, numero: '1', nombre: 'Juan Pérez', modalidad: 'presencial', puesto: 'Supervisor' }, // ya existe
    { fila: 8, numero: '013', nombre: 'Tel malo', modalidad: 'campo', telefono: '123' },
  ];
  const previa = await api('POST', '/rh/empleados/importar', RH, { filas });
  assert.equal(previa.status, 200);
  assert.deepEqual(previa.body.resumen, { total: 7, crear: 3, actualizar: 1, sin_cambios: 0, errores: 3 });
  const porFila = Object.fromEntries(previa.body.filas.map((f) => [f.fila, f]));
  assert.equal(porFila[2].nombre, 'Laura Méndez');
  assert.equal(porFila[2].telefono, '+525512345678');
  assert.equal(porFila[2].tipo_jornada, 'nocturna');
  assert.equal(porFila[3].modalidad, 'presencial');
  assert.ok(porFila[3].avisos.some((a) => /Sin teléfono/.test(a)));
  assert.match(porFila[5].errores[0], /repetido.*fila 2/i);
  assert.equal(porFila[6].errores.length, 2);
  assert.deepEqual(porFila[7].cambios, { puesto: { antes: null, despues: 'Supervisor' } });
  assert.match(porFila[8].errores[0], /Teléfono/);

  const antes = (await db.query(`SELECT count(*)::int AS n FROM empleados`)).rows[0].n;
  assert.equal(antes, 2, 'la vista previa no guarda nada');

  const r = await api('POST', '/rh/empleados/importar', RH, { filas, confirmar: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.creados.length, 3);
  assert.equal(r.body.creados.find((c) => c.numero === '012').pin, '0077', 'Excel quita ceros: se rellena');
  assert.equal(new Set(r.body.creados.map((c) => c.pin)).size, 3);

  const laura = r.body.creados.find((c) => c.numero === '010');
  const id = await api('POST', '/kiosco/identificar', KIOSCO, { pin: laura.pin });
  assert.equal(id.body.empleado.nombre, 'Laura Méndez');

  const { rows: [juan] } = await db.query(`SELECT puesto FROM empleados WHERE numero = '1'`);
  assert.equal(juan.puesto, 'Supervisor');

  const otraVez = await api('POST', '/rh/empleados/importar', RH, { filas: filas.slice(0, 3) });
  assert.equal(otraVez.body.resumen.sin_cambios, 3, 'subir el mismo archivo otra vez no duplica');
});

test('convenio: se envía al dar de alta, se lee y se firma con código', async () => {
  const alta = await api('POST', '/rh/empleados', RH, { numero: '20', nombre: 'Rosa Campos', modalidad: 'campo', telefono: '5511112222' });
  assert.equal(alta.status, 201);
  const { convenio_id, codigo_demo } = alta.body.convenio;
  assert.match(codigo_demo, /^\d{6}$/);

  const sinTel = await api('POST', '/rh/empleados', RH, { numero: '21', nombre: 'Sin Tel', modalidad: 'presencial' });
  assert.equal(sinTel.body.convenio, null);

  let estado = (await api('GET', '/rh/convenios', RH)).body;
  assert.equal(estado.convenios.find((c) => c.empleado.id === alta.body.id).estado, 'pendiente');
  assert.deepEqual(estado.empresa_incompleta, ['rfc', 'domicilio', 'correo_privacidad']);

  const JSONH = { 'content-type': 'application/json' };
  assert.equal((await api('POST', `/convenios/${convenio_id}/ver`, JSONH, { codigo: codigo_demo === '123456' ? '654321' : '123456' })).status, 403);
  const ver = await api('POST', `/convenios/${convenio_id}/ver`, JSONH, { codigo: codigo_demo });
  assert.equal(ver.status, 200);
  assert.equal(ver.body.documentos.length, 3);
  assert.match(ver.body.documentos[0].texto, /Rosa Campos/);
  assert.match(ver.body.documentos[0].texto, /GPS ÚNICAMENTE en el momento/, 'el texto se adapta a la modalidad de campo');

  assert.equal((await api('POST', `/convenios/${convenio_id}/firmar`, JSONH, { codigo: codigo_demo })).status, 400, 'hay que marcar que acepta');
  const firma = await api('POST', `/convenios/${convenio_id}/firmar`, JSONH, { codigo: codigo_demo, acepto: true });
  assert.equal(firma.status, 201);
  assert.equal((await api('POST', `/convenios/${convenio_id}/firmar`, JSONH, { codigo: codigo_demo, acepto: true })).status, 409);

  estado = (await api('GET', '/rh/convenios', RH)).body;
  assert.equal(estado.convenios.find((c) => c.empleado.id === alta.body.id).estado, 'firmado');

  const reenvio = await api('POST', '/rh/convenios/enviar', RH, { empleado_ids: [alta.body.id, sinTel.body.id] });
  assert.deepEqual(reenvio.body.omitidos.map((o) => o.motivo).sort(), ['Sin teléfono', 'Ya firmó']);

  // A Juan (sin convenio) se le envía con "enviar a pendientes"; un recordatorio cambia el código.
  await api('PATCH', '/rh/empleados/1', RH, { telefono: '5500000001' });
  const masivo = await api('POST', '/rh/convenios/enviar', RH, {});
  const juan = masivo.body.enviados.find((e) => e.empleado_id === 1);
  assert.ok(juan);
  const rec = await api('POST', `/rh/convenios/${juan.convenio_id}/recordar`, RH);
  assert.equal(rec.status, 200);
  if (rec.body.codigo_demo !== juan.codigo_demo) {
    assert.equal((await api('POST', `/convenios/${juan.convenio_id}/ver`, JSONH, { codigo: juan.codigo_demo })).status, 403, 'el código anterior ya no sirve');
  }
  const rechazo = await api('POST', `/convenios/${juan.convenio_id}/rechazar`, JSONH, { codigo: rec.body.codigo_demo, motivo: 'Quiero revisarlo con mi abogado' });
  assert.equal(rechazo.status, 201);
});

test('expediente PDF: se genera, trae su huella y queda constancia en la bitácora', async () => {
  const hoy = new Date().toISOString().slice(0, 10);
  const r = await fetch(`${base}/rh/expediente.pdf?empleado_id=1&desde=2026-01-01&hasta=${hoy}&generado_por=Inspector%20demo`, { headers: RH });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/pdf/);
  const pdf = Buffer.from(await r.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 3000);

  const huella = r.headers.get('x-expediente-sha256');
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(pdf).digest('hex'), huella);
  const { rows: [nota] } = await db.query(`SELECT datos FROM bitacora WHERE clase = 'nota' AND datos->>'asunto' = 'expediente_generado' ORDER BY id DESC LIMIT 1`);
  assert.equal(nota.datos.pdf_sha256, huella);
  assert.equal(nota.datos.generado_por, 'Inspector demo');

  assert.equal((await api('GET', '/rh/expediente.pdf?empleado_id=1&desde=2026-02-01&hasta=2026-01-01', RH)).status, 400);
  assert.equal((await api('GET', `/rh/expediente.pdf?empleado_id=999&desde=2026-01-01&hasta=${hoy}`, RH)).status, 404);
});

test('Mi checador (híbrido): vincular dispositivo por WhatsApp y registrar desde casa', async () => {
  const JSONH = { 'content-type': 'application/json' };
  const alta = await api('POST', '/rh/empleados', RH, { numero: '30', nombre: 'Luis Navarro', modalidad: 'hibrido', telefono: '55 3333 4444', enviar_convenio: false });
  assert.equal(alta.status, 201);
  assert.equal(alta.body.modalidad, 'hibrido');

  // Número no registrado: misma respuesta, sin código (no revela quién trabaja ahí).
  const nadie = await api('POST', '/yo/activar/solicitar', JSONH, { telefono: '5599999999' });
  assert.equal(nadie.status, 200);
  assert.equal(nadie.body.codigo_demo, undefined);

  const sol = await api('POST', '/yo/activar/solicitar', JSONH, { telefono: '5533334444' });
  assert.match(sol.body.codigo_demo, /^\d{6}$/);
  const malo = await api('POST', '/yo/activar/confirmar', JSONH, { telefono: '5533334444', codigo: sol.body.codigo_demo === '000000' ? '111111' : '000000' });
  assert.equal(malo.status, 403);
  const ok = await api('POST', '/yo/activar/confirmar', JSONH, { telefono: '5533334444', codigo: sol.body.codigo_demo });
  assert.equal(ok.status, 201);
  assert.equal((await api('POST', '/yo/activar/confirmar', JSONH, { telefono: '5533334444', codigo: sol.body.codigo_demo })).status, 403, 'el código es de un solo uso');

  const YO = { 'x-dispositivo-token': ok.body.token, 'content-type': 'application/json' };
  assert.equal((await api('GET', '/yo', JSONH)).status, 401);
  let yo = await api('GET', '/yo', YO);
  assert.equal(yo.body.empleado.nombre, 'Luis Navarro');
  assert.equal(yo.body.puede_remoto, true);
  assert.equal(yo.body.estado, 'fuera');

  assert.equal((await api('POST', '/yo/checar', YO, { tipo: 'entrada' })).status, 400, 'al iniciar debe decir dónde está');
  const entrada = await api('POST', '/yo/checar', YO, { tipo: 'entrada', lugar: 'casa', hora_dispositivo: new Date().toISOString() });
  assert.equal(entrada.status, 201);
  assert.equal(entrada.body.lugar, 'casa');
  yo = await api('GET', '/yo', YO);
  assert.equal(yo.body.estado, 'trabajando');
  assert.equal(yo.body.lugar_actual, 'casa');
  assert.deepEqual(yo.body.permitidos, ['salida_comida', 'salida']);

  // Termina el día en la oficina, en el kiosco: el mismo día queda mixto.
  await api('POST', '/rh/empleados/' + alta.body.id + '/pin', RH, { pin: '2468' });
  const k = await api('POST', '/kiosco/checar', KIOSCO, { pin: '2468', tipo: 'salida', foto: FOTO });
  assert.deepEqual(k.body.banderas, []);
  const { rows } = await db.query(`SELECT datos->>'lugar' AS lugar, datos->'evidencia'->>'ip' AS ip FROM bitacora WHERE empleado_id = $1 AND clase = 'checada' ORDER BY id`, [alta.body.id]);
  assert.deepEqual(rows.map((r) => r.lugar), ['casa', 'oficina']);
  assert.ok(rows[0].ip, 'desde casa se guarda la IP');

  // Un empleado presencial no puede registrar remoto.
  await api('PATCH', `/rh/empleados/${alta.body.id}`, RH, { modalidad: 'presencial' });
  assert.equal((await api('POST', '/yo/checar', YO, { tipo: 'entrada', lugar: 'casa' })).status, 403);

  // Desvincular: el token deja de servir.
  assert.equal((await api('POST', '/yo/salir', YO)).status, 200);
  assert.equal((await api('GET', '/yo', YO)).status, 401);
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
