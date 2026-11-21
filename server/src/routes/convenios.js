// Página pública del convenio: el trabajador abre el enlace de WhatsApp, lee y firma (o manifiesta que no está de acuerdo).
import { Router } from 'express';
import { agregarEvento } from '../lib/cadena.js';
import { crearValidador } from '../lib/codigos.js';
import { convenioParaFirmar } from '../convenios.js';

export function rutasConvenios(db) {
  const r = Router();
  const validar = crearValidador();

  async function cargar(req, res) {
    const id = Number(req.params.id);
    const conv = Number.isInteger(id) ? await convenioParaFirmar(db, id) : null;
    return validar(res, conv, req.body?.codigo) ? conv : null;
  }

  r.post('/:id/ver', async (req, res) => {
    const conv = await cargar(req, res);
    if (!conv) return;
    const { rows: [info] } = await db.query(
      `SELECT e.nombre AS empleado, x.nombre AS empresa FROM empleados e JOIN empresas x ON x.id = e.empresa_id WHERE e.id = $1`,
      [conv.empleado_id],
    );
    res.json({
      convenio_id: conv.id, empresa: info.empresa, empleado: info.empleado, version: conv.datos.version,
      documentos: conv.datos.documentos.map(({ clave, titulo, texto }) => ({ clave, titulo, texto })),
    });
  });

  r.post('/:id/firmar', async (req, res) => {
    if (req.body?.acepto !== true) return res.status(400).json({ error: 'Debes marcar que leíste y aceptas los documentos' });
    const conv = await cargar(req, res);
    if (!conv) return;
    const evento = await db.transaction((tx) => agregarEvento(tx, {
      empresa_id: conv.empresa_id, empleado_id: conv.empleado_id, clase: 'convenio_firmado',
      datos: {
        convenio_id: conv.id,
        version: conv.datos.version,
        hash_documentos: conv.datos.hash_documentos, // exactamente lo que firmó
        documentos: conv.datos.documentos.map(({ clave, hash }) => ({ clave, hash })),
        metodo: 'codigo_whatsapp',
        telefono: conv.datos.telefono,
        ip: req.ip,
        agente: req.get('user-agent') ?? null,
      },
    }));
    res.status(201).json({ estado: 'firmado', evento: evento.id, hora: evento.hora });
  });

  r.post('/:id/rechazar', async (req, res) => {
    const motivo = String(req.body?.motivo ?? '').trim();
    if (!motivo) return res.status(400).json({ error: 'Cuéntanos qué no te parece o qué dudas tienes' });
    const conv = await cargar(req, res);
    if (!conv) return;
    const evento = await db.transaction((tx) => agregarEvento(tx, {
      empresa_id: conv.empresa_id, empleado_id: conv.empleado_id, clase: 'convenio_rechazado',
      datos: { convenio_id: conv.id, version: conv.datos.version, hash_documentos: conv.datos.hash_documentos, motivo: motivo.slice(0, 2000), ip: req.ip },
    }));
    res.status(201).json({ estado: 'rechazado', evento: evento.id });
  });

  return r;
}
