// Convenio de registro electrónico + aviso de privacidad + política, enviados por WhatsApp y firmados con código.
// Esta firma acredita que el sistema de registro fue "acordado" entre trabajador y patrón.
import { agregarEvento, jsonCanonico, sha256 } from './lib/cadena.js';
import { enviarWhatsApp } from './lib/notificador.js';
import { generarCodigo, generarSal, hashCodigo } from './lib/seguridad.js';
import { documentosPara, VERSION_DOCUMENTOS } from './documentos/convenio.js';

const VIGENCIA_CODIGO_MS = 15 * 24 * 3600 * 1000;
export const urlApp = () => (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');

/** Crea el evento con el texto exacto de los documentos y manda el enlace con el código. */
export async function enviarConvenio(db, empresa, empleado, { enviadoPor = 'RH' } = {}) {
  const documentos = documentosPara(empresa, empleado).map((d) => ({ ...d, hash: sha256(d.texto) }));
  const hashDocumentos = sha256(jsonCanonico(documentos.map(({ clave, version, hash }) => ({ clave, version, hash }))));
  const codigo = generarCodigo();
  const sal = generarSal();
  const evento = await db.transaction((tx) => agregarEvento(tx, {
    empresa_id: empresa.id, empleado_id: empleado.id, clase: 'convenio_enviado',
    datos: {
      version: VERSION_DOCUMENTOS, documentos, hash_documentos: hashDocumentos,
      telefono: empleado.telefono ?? null, codigo_sal: sal, codigo_hash: hashCodigo(sal, codigo),
      canal: 'whatsapp', enviado_por: enviadoPor,
    },
  }));
  await enviarWhatsApp(
    empleado.telefono,
    `Hola ${empleado.nombre.split(' ')[0]}, ${empresa.nombre} te envía el convenio de registro de jornada, el aviso de privacidad `
      + `y la política de jornada. Léelos en ${urlApp()}/#/convenio/${evento.id} y fírmalos con el código ${codigo}.`,
  );
  return { convenio_id: evento.id, codigo };
}

/** Estado del último convenio enviado a cada empleado. */
export async function estadoConvenios(db, empresaId) {
  const { rows } = await db.query(
    `SELECT id, empleado_id, clase, hora_servidor, datos FROM bitacora
      WHERE empresa_id = $1 AND (clase IN ('convenio_enviado', 'convenio_firmado', 'convenio_rechazado')
            OR (clase = 'recordatorio' AND datos ? 'convenio_id'))
      ORDER BY id`,
    [empresaId],
  );
  const estado = new Map();
  for (const e of rows) {
    if (e.clase === 'convenio_enviado') {
      estado.set(e.empleado_id, {
        convenio_id: e.id, version: e.datos.version, estado: 'pendiente', enviado_en: e.hora_servidor,
        recordatorios: 0, respondido_en: null, motivo: null, hash_documentos: e.datos.hash_documentos,
        envios: (estado.get(e.empleado_id)?.envios ?? 0) + 1,
      });
      continue;
    }
    const actual = estado.get(e.empleado_id);
    if (!actual || actual.convenio_id !== e.datos.convenio_id) continue; // respuesta a un envío anterior
    if (e.clase === 'recordatorio') actual.recordatorios += 1;
    else {
      actual.estado = e.clase === 'convenio_firmado' ? 'firmado' : 'rechazado';
      actual.respondido_en = e.hora_servidor;
      actual.motivo = e.datos.motivo ?? null;
    }
  }
  // Si alguna vez firmó y luego se le reenvió (p. ej. nueva versión), conserva la firma anterior como dato.
  for (const e of rows.filter((r) => r.clase === 'convenio_firmado')) {
    const actual = estado.get(e.empleado_id);
    if (actual && actual.estado !== 'firmado') actual.firmado_antes = { convenio_id: e.datos.convenio_id, en: e.hora_servidor };
  }
  return estado;
}

/** Convenio vigente para firmar, con el hash del último código enviado. */
export async function convenioParaFirmar(db, convenioId) {
  const { rows: [conv] } = await db.query(
    `SELECT id, empresa_id, empleado_id, hora_servidor, datos FROM bitacora WHERE id = $1 AND clase = 'convenio_enviado'`,
    [convenioId],
  );
  if (!conv) return null;
  const { rows: posteriores } = await db.query(
    `SELECT id, clase, hora_servidor, datos FROM bitacora
      WHERE empresa_id = $1 AND empleado_id = $2 AND id > $3 AND (
        clase IN ('convenio_enviado', 'convenio_firmado', 'convenio_rechazado')
        OR (clase = 'recordatorio' AND (datos->>'convenio_id')::int = $3))
      ORDER BY id`,
    [conv.empresa_id, conv.empleado_id, conv.id],
  );
  const ultimoCodigo = [conv, ...posteriores.filter((p) => p.clase === 'recordatorio')].at(-1);
  return {
    ...conv,
    reemplazado: posteriores.some((p) => p.clase === 'convenio_enviado'),
    respondido: posteriores.find((p) => p.datos.convenio_id === conv.id && p.clase !== 'recordatorio') ?? null,
    codigo_sal: ultimoCodigo.datos.codigo_sal,
    codigo_hash: ultimoCodigo.datos.codigo_hash,
    codigo_expira: new Date(new Date(ultimoCodigo.hora_servidor).getTime() + VIGENCIA_CODIGO_MS),
  };
}

export async function recordarConvenio(db, empresa, convenioId) {
  const conv = await convenioParaFirmar(db, convenioId);
  if (!conv || conv.empresa_id !== empresa.id) return { status: 404, error: 'Convenio no encontrado' };
  if (conv.reemplazado || conv.respondido) return { status: 409, error: 'Este convenio ya no está pendiente' };
  const { rows: [emp] } = await db.query(`SELECT nombre, telefono FROM empleados WHERE id = $1`, [conv.empleado_id]);
  const { rows: [{ n }] } = await db.query(
    `SELECT count(*)::int AS n FROM bitacora WHERE clase = 'recordatorio' AND (datos->>'convenio_id')::int = $1`, [convenioId],
  );
  const codigo = generarCodigo();
  const sal = generarSal();
  await db.transaction((tx) => agregarEvento(tx, {
    empresa_id: empresa.id, empleado_id: conv.empleado_id, clase: 'recordatorio',
    datos: { convenio_id: convenioId, numero: n + 1, codigo_sal: sal, codigo_hash: hashCodigo(sal, codigo), canal: 'whatsapp' },
  }));
  await enviarWhatsApp(emp.telefono, `Recordatorio: firma tu convenio de registro de jornada en ${urlApp()}/#/convenio/${convenioId} con el código ${codigo}.`);
  return { status: 200, numero: n + 1, codigo };
}
