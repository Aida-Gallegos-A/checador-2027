// Firma semanal del trabajador: confirma u objeta su resumen con el código que le llegó por WhatsApp.
// Esta firma es lo que acredita que el registro fue "acordado" (prueba plena en la reforma).
import { Router } from 'express';
import { agregarEvento } from '../lib/cadena.js';
import { crearValidador } from '../lib/codigos.js';
import { resumenParaFirmar } from '../servicios.js';

export function rutasFirmas(db) {
  const r = Router();
  const validar = crearValidador();

  async function cargar(req, res) {
    const id = Number(req.params.resumenId);
    const resumen = Number.isInteger(id) ? await resumenParaFirmar(db, id) : null;
    return validar(res, resumen, req.body?.codigo) ? resumen : null;
  }

  // Ver el resumen (requiere el código, para no exponer horas de otros).
  r.post('/:resumenId/ver', async (req, res) => {
    const resumen = await cargar(req, res);
    if (!resumen) return;
    res.json({ resumen_id: resumen.id, resumen: resumen.datos.resumen });
  });

  r.post('/:resumenId/confirmar', async (req, res) => {
    const resumen = await cargar(req, res);
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
    const resumen = await cargar(req, res);
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
