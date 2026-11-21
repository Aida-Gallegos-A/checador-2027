// Cliente del API. Los tokens viven en localStorage (MVP; se reemplaza por login).

const leer = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

export const tokens = {
  kiosco: () => leer('checador.kiosco', import.meta.env.VITE_KIOSCO_TOKEN ?? 'kiosco-demo'),
  rh: () => leer('checador.rh', ''),
  setRh: (t) => guardar('checador.rh', t),
};

export class ErrorApi extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }
}

async function pedir(metodo, ruta, { body, headers = {} } = {}) {
  const r = await fetch(`/api${ruta}`, {
    method: metodo,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const datos = (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : await r.blob();
  if (!r.ok) throw new ErrorApi(r.status, datos?.error ?? `Error ${r.status}`);
  return datos;
}

export const kiosco = {
  info: () => pedir('GET', '/kiosco/info', { headers: { 'x-kiosco-token': tokens.kiosco() } }),
  identificar: (pin) => pedir('POST', '/kiosco/identificar', { body: { pin }, headers: { 'x-kiosco-token': tokens.kiosco() } }),
  checar: (datos) => pedir('POST', '/kiosco/checar', { body: datos, headers: { 'x-kiosco-token': tokens.kiosco() } }),
};

const rhHeaders = () => ({ authorization: `Bearer ${tokens.rh()}` });
export const rh = {
  resumen: (semana) => pedir('GET', `/rh/resumen${semana ? `?semana=${semana}` : ''}`, { headers: rhHeaders() }),
  empleados: () => pedir('GET', '/rh/empleados', { headers: rhHeaders() }),
  altaEmpleado: (body) => pedir('POST', '/rh/empleados', { body, headers: rhHeaders() }),
  editarEmpleado: (id, body) => pedir('PATCH', `/rh/empleados/${id}`, { body, headers: rhHeaders() }),
  importarEmpleados: (body) => pedir('POST', '/rh/empleados/importar', { body, headers: rhHeaders() }),
  nuevoPin: (id, body = {}) => pedir('POST', `/rh/empleados/${id}/pin`, { body, headers: rhHeaders() }),
  semanaEmpleado: (id, semana) => pedir('GET', `/rh/empleados/${id}/semana?semana=${semana}`, { headers: rhHeaders() }),
  correcciones: () => pedir('GET', '/rh/correcciones', { headers: rhHeaders() }),
  solicitarCorreccion: (body) => pedir('POST', '/rh/correcciones', { body, headers: rhHeaders() }),
  decidir: (id, body) => pedir('POST', `/rh/correcciones/${id}/decidir`, { body, headers: rhHeaders() }),
  firmas: (semana) => pedir('GET', `/rh/firmas?semana=${semana}`, { headers: rhHeaders() }),
  enviarFirmas: (body) => pedir('POST', '/rh/firmas/enviar', { body, headers: rhHeaders() }),
  recordar: (id) => pedir('POST', `/rh/firmas/${id}/recordar`, { headers: rhHeaders() }),
  verificar: () => pedir('GET', '/rh/cadena/verificar', { headers: rhHeaders() }),
  empresa: () => pedir('GET', '/rh/empresa', { headers: rhHeaders() }),
  guardarEmpresa: (body) => pedir('PATCH', '/rh/empresa', { body, headers: rhHeaders() }),
  convenios: () => pedir('GET', '/rh/convenios', { headers: rhHeaders() }),
  enviarConvenios: (body = {}) => pedir('POST', '/rh/convenios/enviar', { body, headers: rhHeaders() }),
  recordarConvenio: (id) => pedir('POST', `/rh/convenios/${id}/recordar`, { headers: rhHeaders() }),
  /** Descarga el expediente PDF y devuelve su huella SHA-256. */
  async expediente({ empleado_id, desde, hasta, generado_por }) {
    const q = new URLSearchParams({ empleado_id, desde, hasta, generado_por: generado_por || 'RH' });
    const r = await fetch(`/api/rh/expediente.pdf?${q}`, { headers: rhHeaders() });
    if (!r.ok) throw new ErrorApi(r.status, (await r.json().catch(() => null))?.error ?? `Error ${r.status}`);
    const nombre = /filename="?([^";]+)"?/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'expediente.pdf';
    const url = URL.createObjectURL(await r.blob());
    Object.assign(document.createElement('a'), { href: url, download: nombre }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return { nombre, huella: r.headers.get('x-expediente-sha256') };
  },
  nomina: (semana) => pedir('GET', `/rh/nomina.csv?semana=${semana}`, { headers: rhHeaders() }),
};

export const convenios = {
  ver: (id, codigo) => pedir('POST', `/convenios/${id}/ver`, { body: { codigo } }),
  firmar: (id, codigo) => pedir('POST', `/convenios/${id}/firmar`, { body: { codigo, acepto: true } }),
  rechazar: (id, codigo, motivo) => pedir('POST', `/convenios/${id}/rechazar`, { body: { codigo, motivo } }),
};

export const firmas = {
  ver: (id, codigo) => pedir('POST', `/firmas/${id}/ver`, { body: { codigo } }),
  confirmar: (id, codigo) => pedir('POST', `/firmas/${id}/confirmar`, { body: { codigo } }),
  objetar: (id, codigo, motivo) => pedir('POST', `/firmas/${id}/objetar`, { body: { codigo, motivo } }),
};

// ---------- Formato ----------
const ZONA = 'America/Mexico_City';
export const hora = (d) => new Date(d).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit', timeZone: ZONA });
export const fechaCorta = (f) => new Date(`${f}T12:00:00Z`).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export const fechaHora = (d) => new Date(d).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: ZONA });
export const sumarDias = (f, n) => { const d = new Date(`${f}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const h = (n) => `${Number(n).toLocaleString('es-MX', { maximumFractionDigits: 2 })} h`;

export const TIPOS = {
  entrada: 'Entrada',
  salida_comida: 'Salida a comer',
  regreso_comida: 'Regreso de comer',
  salida: 'Salida',
};
export const MODALIDADES = { presencial: 'Presencial', campo: 'Campo', home_office: 'Home office' };
