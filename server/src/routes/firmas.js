// Firma semanal del trabajador: confirma u objeta su resumen con el código que le llegó por WhatsApp.
// Esta firma es lo que acredita que el registro fue "acordado" (prueba plena en la reforma).
import { Router } from 'express';
import { agregarEvento } from '../lib/cadena.js';
import { hashCodigo, igualSeguro } from '../lib/seguridad.js';
import { resumenParaFirmar } from '../servicios.js';

const INTENTOS_MAX = 5;

export function rutasFirmas(db) {
  const r = Router();
  const fallos = new Map(); // resumen → intentos fallidos

  async function validar(req, res) {
    const resumenId = Number(req.params.resumenId);
    const codigo = String(req.body?.codigo ?? '');
    const resumen = Number.isInteger(resumenId) ? await resumenParaFirmar(db, resumenId) : null;
    if (!resumen) { res.status(404).json({ error: 'Resumen no encontrado' }); return null; }
    if (resumen.reemplazado) { res.status(409).json({ error: 'Este resumen fue reemplazado por uno más reciente' }); return null; }
    if (resumen.respondido) { res.status(409).json({ error: 'Esta semana ya fue respondida' }); return null; }
    if (new Date() > resumen.codigo_expira) { res.status(410).json({ error: 'El código expiró; pide a RH que lo reenvíe' }); return null; }

    const llave = `${resumenId}:${resumen.codigo_hash}`;
    if ((fallos.get(llave) ?? 0) >= INTENTOS_MAX) {
      res.status(429).json({ error: 'Demasiados intentos. Pide a RH que reenvíe el código.' });
      return null;
    }
    if (!/^\d{6}$/.test(codigo) || !igualSeguro(hashCodigo(resumen.codigo_sal, codigo), resumen.codigo_hash)) {
      fallos.set(llave, (fallos.get(llave) ?? 0) + 1);
      res.status(403).json({ error: 'Código incorrecto' });
      return null;
    }
    return resumen;
  }

  // Ver el resumen (requiere el código, para no exponer horas de otros).
  r.post('/:resumenId/ver', async (req, res) => {
    const resumen = await validar(req, res);
    if (!resumen) return;
    res.json({ resumen_id: resumen.id, resumen: resumen.datos.resumen });
  });

  r.post('/:resumenId/confirmar', async (req, res) => {
    const resumen = await validar(req, res);
    if (!resumen) return;
    const evento = await db.transaction((tx) => agregarEvento(tx, {
      empresa_id: resumen.empresa_id, empleado_id: resumen.empleado_id, clase: 'firma',
      datos: {
        resumen_id: resumen.id,
        semana: resumen.datos.semana,
        hash_resumen: resumen.datos.hash_resumen, // lo que firmó, exactamente
        metodo: 'codigo_whatsapp',
        ip: req.ip,
        agente: req.get('user-agent') ?? null,
      },
    }));
    res.status(201).json({ estado: 'firmada', evento: evento.id, hora: evento.hora });
  });

  r.post('/:resumenId/objetar', async (req, res) => {
    const motivo = String(req.body?.motivo ?? '').trim();
    if (!motivo) return res.status(400).json({ error: 'Escribe qué no cuadra' });
    const resumen = await validar(req, res);
    if (!resumen) return;
    const evento = await db.transaction((tx) => agregarEvento(tx, {
      empresa_id: resumen.empresa_id, empleado_id: resumen.empleado_id, clase: 'objecion',
      datos: {
        resumen_id: resumen.id,
        semana: resumen.datos.semana,
        hash_resumen: resumen.datos.hash_resumen,
        motivo: motivo.slice(0, 2000),
        ip: req.ip,
      },
    }));
    res.status(201).json({ estado: 'objetada', evento: evento.id });
  });

  return r;
}
