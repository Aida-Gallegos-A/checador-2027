// Kiosco presencial: tablet en la entrada con PIN y foto automática.
import { Router } from 'express';
import { agregarEvento } from '../lib/cadena.js';
import { guardarFoto } from '../lib/almacen.js';
import { hashToken, indicePin } from '../lib/seguridad.js';
import { secuenciaValida, TIPOS_CHECADA, tiposPermitidos, ultimaChecada } from '../servicios.js';

const DESFASE_MAX_MS = 5 * 60 * 1000;
const INTENTOS_MAX = 10;
const VENTANA_MS = 5 * 60 * 1000;

export function rutasKiosco(db) {
  const r = Router();
  const fallos = new Map(); // centro → marcas de tiempo de PINs incorrectos

  // El kiosco se identifica con su token (se configura una vez en la tablet).
  r.use(async (req, res, next) => {
    const token = req.get('x-kiosco-token');
    if (!token) return res.status(401).json({ error: 'Falta el token del kiosco' });
    const { rows: [centro] } = await db.query(
      `SELECT c.id, c.nombre, c.empresa_id, e.nombre AS empresa FROM centros c JOIN empresas e ON e.id = c.empresa_id
        WHERE c.token_kiosco_hash = $1`,
      [hashToken(token)],
    );
    if (!centro) return res.status(401).json({ error: 'Kiosco no reconocido' });
    req.centro = centro;
    next();
  });

  async function buscarPorPin(req, res) {
    const ahora = Date.now();
    const recientes = (fallos.get(req.centro.id) ?? []).filter((t) => ahora - t < VENTANA_MS);
    if (recientes.length >= INTENTOS_MAX) {
      res.status(429).json({ error: 'Demasiados PIN incorrectos. Espera unos minutos.' });
      return null;
    }
    const pin = String(req.body?.pin ?? '');
    const { rows: [emp] } = /^\d{4,8}$/.test(pin)
      ? await db.query(
        `SELECT id, nombre, modalidad FROM empleados WHERE empresa_id = $1 AND pin_indice = $2 AND activo`,
        [req.centro.empresa_id, indicePin(req.centro.empresa_id, pin)],
      )
      : { rows: [] };
    if (!emp) {
      fallos.set(req.centro.id, [...recientes, ahora]);
      res.status(404).json({ error: 'PIN no encontrado' });
      return null;
    }
    return emp;
  }

  r.get('/info', (req, res) => {
    res.json({ centro: req.centro.nombre, empresa: req.centro.empresa, hora_servidor: new Date() });
  });

  // Paso 1: el PIN devuelve el nombre (para que el trabajador confirme "soy yo") y qué puede checar.
  r.post('/identificar', async (req, res) => {
    const emp = await buscarPorPin(req, res);
    if (!emp) return;
    const ultima = await ultimaChecada(db, req.centro.empresa_id, emp.id);
    res.json({
      empleado: { id: emp.id, nombre: emp.nombre },
      ultima: ultima ? { tipo: ultima.datos.tipo, hora: ultima.hora } : null,
      permitidos: tiposPermitidos(ultima?.datos.tipo),
    });
  });

  // Paso 2: registrar la checada con la foto. La hora siempre es la del servidor.
  r.post('/checar', async (req, res) => {
    const { tipo, foto, hora_dispositivo } = req.body ?? {};
    if (!TIPOS_CHECADA.includes(tipo)) return res.status(400).json({ error: 'Tipo de registro inválido' });
    const emp = await buscarPorPin(req, res);
    if (!emp) return;

    const evidencia = (await guardarFoto(foto)) ?? {};
    const banderas = [];
    if (!evidencia.foto_sha256) banderas.push('sin_foto');

    const dispositivo = hora_dispositivo ? new Date(hora_dispositivo) : null;
    if (dispositivo && !Number.isNaN(+dispositivo) && Math.abs(Date.now() - dispositivo) > DESFASE_MAX_MS) {
      banderas.push('hora_dispositivo_no_cuadra');
    }

    const evento = await db.transaction(async (tx) => {
      const ultima = await ultimaChecada(tx, req.centro.empresa_id, emp.id);
      // No se bloquea: se registra y se marca para revisión. Bloquear haría perder evidencia.
      if (!secuenciaValida(ultima?.datos.tipo, tipo)) banderas.push('secuencia_irregular');
      return agregarEvento(tx, {
        empresa_id: req.centro.empresa_id,
        empleado_id: emp.id,
        clase: 'checada',
        datos: {
          tipo,
          origen: 'kiosco',
          centro_id: req.centro.id,
          hora_dispositivo: dispositivo && !Number.isNaN(+dispositivo) ? dispositivo.toISOString() : null,
          evidencia,
          banderas,
        },
      });
    });

    res.status(201).json({
      id: evento.id,
      tipo,
      hora: evento.hora,
      empleado: { id: emp.id, nombre: emp.nombre },
      banderas,
      hash: evento.hash,
    });
  });

  return r;
}
