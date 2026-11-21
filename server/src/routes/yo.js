// "Mi checador": el trabajador registra desde su celular o computadora (home office e híbridos).
// El dispositivo se vincula una vez con un código por WhatsApp; después se identifica con un token
// que solo se guarda como hash. Se registra IP y dispositivo, nunca la ubicación del domicilio.
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { agregarEvento, sha256 } from '../lib/cadena.js';
import { fechaLocal, JORNADA_DIARIA, lugarDe, lunesDe } from '../lib/jornada.js';
import { enviarWhatsApp } from '../lib/notificador.js';
import { generarCodigo, generarSal, hashCodigo, igualSeguro } from '../lib/seguridad.js';
import { normalizarTelefono } from './rh.js';
import {
  obtenerEmpresa, secuenciaValida, semanasDeEmpleados, TIPOS_CHECADA, tiposPermitidos, ultimaChecada,
} from '../servicios.js';

const MODALIDADES_REMOTAS = ['home_office', 'hibrido'];
const LUGARES = ['casa', 'otro'];
const VIDA_CODIGO_MS = 10 * 60 * 1000;
const INTENTOS_MAX = 5;
const DESFASE_MAX_MS = 5 * 60 * 1000;
const hashToken = (t) => sha256(`dispositivo:${t}`);

/** Límite simple en memoria: n intentos por llave en una ventana. */
function limitador(n, ventanaMs) {
  const marcas = new Map();
  return (llave) => {
    const ahora = Date.now();
    const recientes = (marcas.get(llave) ?? []).filter((t) => ahora - t < ventanaMs);
    if (recientes.length >= n) return false;
    marcas.set(llave, [...recientes, ahora]);
    return true;
  };
}

export function rutasYo(db) {
  const r = Router();
  const porIp = limitador(10, 15 * 60 * 1000);
  const porTelefono = limitador(3, 15 * 60 * 1000);

  // ---------- Vincular dispositivo ----------
  // Siempre responde igual, exista o no el número, para no revelar quién trabaja en la empresa.
  r.post('/activar/solicitar', async (req, res) => {
    const telefono = normalizarTelefono(req.body?.telefono);
    if (!telefono) return res.status(400).json({ error: 'Escribe tu celular a 10 dígitos' });
    if (!porIp(req.ip) || !porTelefono(telefono)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });

    const respuesta = { ok: true, mensaje: 'Si tu número está registrado, te llegará un código por WhatsApp.' };
    const { rows: [emp] } = await db.query(
      `SELECT id, nombre, telefono FROM empleados WHERE telefono = $1 AND activo ORDER BY id LIMIT 1`, [telefono],
    );
    if (!emp) return res.json(respuesta);

    const codigo = generarCodigo();
    const sal = generarSal();
    await db.query(`UPDATE activaciones SET usado_en = now() WHERE empleado_id = $1 AND usado_en IS NULL`, [emp.id]);
    await db.query(
      `INSERT INTO activaciones (empleado_id, codigo_sal, codigo_hash, expira) VALUES ($1, $2, $3, $4)`,
      [emp.id, sal, hashCodigo(sal, codigo), new Date(Date.now() + VIDA_CODIGO_MS)],
    );
    await enviarWhatsApp(emp.telefono, `Tu código para activar Mi checador es ${codigo}. Vence en 10 minutos. Si no lo pediste, ignora este mensaje.`);
    res.json(process.env.MODO_DEMO === 'true' ? { ...respuesta, codigo_demo: codigo } : respuesta);
  });

  r.post('/activar/confirmar', async (req, res) => {
    const telefono = normalizarTelefono(req.body?.telefono);
    const codigo = String(req.body?.codigo ?? '');
    if (!telefono || !/^\d{6}$/.test(codigo)) return res.status(400).json({ error: 'Celular o código inválido' });
    if (!porIp(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });

    const { rows: [act] } = await db.query(
      `SELECT a.id, a.codigo_sal, a.codigo_hash, a.intentos, e.id AS empleado_id, e.empresa_id, e.nombre
         FROM activaciones a JOIN empleados e ON e.id = a.empleado_id
        WHERE e.telefono = $1 AND e.activo AND a.usado_en IS NULL AND a.expira > now()
        ORDER BY a.id DESC LIMIT 1`,
      [telefono],
    );
    if (!act || act.intentos >= INTENTOS_MAX) return res.status(403).json({ error: 'Código incorrecto o vencido. Pide uno nuevo.' });
    if (!igualSeguro(hashCodigo(act.codigo_sal, codigo), act.codigo_hash)) {
      await db.query(`UPDATE activaciones SET intentos = intentos + 1 WHERE id = $1`, [act.id]);
      return res.status(403).json({ error: 'Código incorrecto o vencido. Pide uno nuevo.' });
    }

    const token = randomBytes(32).toString('base64url');
    const descripcion = describirDispositivo(req.get('user-agent'));
    const dispositivo = await db.transaction(async (tx) => {
      await tx.query(`UPDATE activaciones SET usado_en = now() WHERE id = $1`, [act.id]);
      const { rows: [d] } = await tx.query(
        `INSERT INTO dispositivos (empresa_id, empleado_id, token_hash, descripcion) VALUES ($1, $2, $3, $4) RETURNING id`,
        [act.empresa_id, act.empleado_id, hashToken(token), descripcion],
      );
      await agregarEvento(tx, {
        empresa_id: act.empresa_id, empleado_id: act.empleado_id, clase: 'nota',
        datos: { asunto: 'dispositivo_vinculado', dispositivo_id: d.id, descripcion, ip: req.ip, metodo: 'codigo_whatsapp' },
      });
      return d;
    });
    res.status(201).json({ token, dispositivo_id: dispositivo.id, nombre: act.nombre });
  });

  // ---------- A partir de aquí, con dispositivo vinculado ----------
  r.use(async (req, res, next) => {
    const token = req.get('x-dispositivo-token');
    if (!token) return res.status(401).json({ error: 'Activa Mi checador con tu celular' });
    const { rows: [d] } = await db.query(
      `SELECT d.id AS dispositivo_id, d.descripcion, e.id, e.empresa_id, e.numero, e.nombre, e.modalidad, e.tipo_jornada, e.telefono
         FROM dispositivos d JOIN empleados e ON e.id = d.empleado_id
        WHERE d.token_hash = $1 AND d.revocado_en IS NULL AND e.activo`,
      [hashToken(token)],
    );
    if (!d) return res.status(401).json({ error: 'Este dispositivo ya no está vinculado. Actívalo de nuevo.' });
    await db.query(`UPDATE dispositivos SET ultimo_uso = now() WHERE id = $1`, [d.dispositivo_id]);
    req.trabajador = d;
    req.empresa = await obtenerEmpresa(db, d.empresa_id);
    next();
  });

  r.get('/', async (req, res) => {
    const t = req.trabajador;
    const ahora = new Date();
    const hoy = fechaLocal(ahora, req.empresa.zona_horaria);
    const [s] = await semanasDeEmpleados(db, req.empresa, [t], lunesDe(hoy));
    const ultima = await ultimaChecada(db, t.empresa_id, t.id);
    const tipoUltimo = ultima?.datos.tipo;
    const enTramo = tipoUltimo === 'entrada' || tipoUltimo === 'regreso_comida';
    const jornadaHoy = [...s.jornadas].reverse().find((j) => j.incompleta || j.fecha === hoy) ?? null;
    const enCurso = jornadaHoy?.incompleta ?? false;

    res.json({
      empleado: { nombre: t.nombre, numero: t.numero, modalidad: t.modalidad, tipo_jornada: t.tipo_jornada },
      empresa: req.empresa.nombre,
      dispositivo: t.descripcion,
      puede_remoto: MODALIDADES_REMOTAS.includes(t.modalidad),
      hora_servidor: ahora,
      estado: !enCurso ? 'fuera' : enTramo ? 'trabajando' : 'en_pausa',
      lugar_actual: enTramo ? lugarDe(ultima) : null,
      ultima: ultima ? { tipo: tipoUltimo, hora: ultima.hora, lugar: lugarDe(ultima), origen: ultima.datos.origen ?? null } : null,
      permitidos: tiposPermitidos(tipoUltimo),
      hoy: {
        // Minutos de tramos cerrados; si está trabajando, el cliente suma desde `ultima.hora`.
        minutos_cerrados: jornadaHoy?.minutosTrabajados ?? 0,
        inicio: jornadaHoy?.entrada ?? null,
        jornada_diaria_min: (JORNADA_DIARIA[t.tipo_jornada] ?? 8) * 60,
      },
      semana: {
        lunes: s.lunes, total: s.semana.total, tope: s.semana.regla.topeSemanal,
        extra: Math.round((s.semana.extraDobles + s.semana.extraTriples) * 100) / 100,
        porcentaje_remoto: s.semana.porcentajeRemoto, dias_por_lugar: s.semana.diasPorLugar,
      },
    });
  });

  r.post('/checar', async (req, res) => {
    const t = req.trabajador;
    if (!MODALIDADES_REMOTAS.includes(t.modalidad)) {
      return res.status(403).json({ error: 'Tu registro es en el kiosco de tu centro de trabajo. Si hoy trabajas desde casa, pide a RH que te cambie a modalidad híbrida.' });
    }
    const { tipo, hora_dispositivo } = req.body ?? {};
    if (!TIPOS_CHECADA.includes(tipo)) return res.status(400).json({ error: 'Tipo de registro inválido' });

    const evento = await db.transaction(async (tx) => {
      const ultima = await ultimaChecada(tx, t.empresa_id, t.id);
      const abreTramo = tipo === 'entrada' || tipo === 'regreso_comida';
      // Al abrir un tramo el trabajador dice dónde está; al cerrarlo se toma el lugar del tramo abierto.
      const lugar = abreTramo ? req.body?.lugar : (ultima ? lugarDe(ultima) : 'casa');
      if (abreTramo && !LUGARES.includes(lugar)) return { error: 'Indica si trabajas desde casa o desde otro lugar' };

      const banderas = [];
      if (!secuenciaValida(ultima?.datos.tipo, tipo)) banderas.push('secuencia_irregular');
      const disp = hora_dispositivo ? new Date(hora_dispositivo) : null;
      const dispValida = disp && !Number.isNaN(+disp);
      if (dispValida && Math.abs(Date.now() - disp) > DESFASE_MAX_MS) banderas.push('hora_dispositivo_no_cuadra');

      return agregarEvento(tx, {
        empresa_id: t.empresa_id, empleado_id: t.id, clase: 'checada',
        datos: {
          tipo, origen: 'web', lugar,
          hora_dispositivo: dispValida ? disp.toISOString() : null,
          evidencia: { ip: req.ip, dispositivo: t.descripcion, dispositivo_id: t.dispositivo_id },
          banderas,
        },
      });
    });
    if (evento.error) return res.status(400).json({ error: evento.error });
    res.status(201).json({ id: evento.id, tipo, hora: evento.hora, lugar: evento.datos.lugar, banderas: evento.datos.banderas });
  });

  // El trabajador desvincula su dispositivo (p. ej. computadora prestada).
  r.post('/salir', async (req, res) => {
    const t = req.trabajador;
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE dispositivos SET revocado_en = now() WHERE id = $1`, [t.dispositivo_id]);
      await agregarEvento(tx, {
        empresa_id: t.empresa_id, empleado_id: t.id, clase: 'nota',
        datos: { asunto: 'dispositivo_desvinculado', dispositivo_id: t.dispositivo_id, por: 'trabajador', ip: req.ip },
      });
    });
    res.json({ ok: true });
  });

  return r;
}

function describirDispositivo(ua = '') {
  const so = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone/iPad' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Dispositivo';
  const nav = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'navegador';
  return `${so} · ${nav}`;
}
