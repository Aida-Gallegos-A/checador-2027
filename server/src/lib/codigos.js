// Validación común de códigos de firma (resumen semanal y convenio).
import { hashCodigo, igualSeguro } from './seguridad.js';

const INTENTOS_MAX = 5;

/**
 * Devuelve una función que valida el código contra un documento pendiente de firma.
 * Lleva la cuenta de intentos fallidos por código enviado (un recordatorio trae código nuevo y reinicia).
 */
export function crearValidador() {
  const fallos = new Map();
  return function validar(res, doc, codigo) {
    if (!doc) { res.status(404).json({ error: 'No encontrado' }); return false; }
    if (doc.reemplazado) { res.status(409).json({ error: 'Este envío fue reemplazado por uno más reciente; usa el último mensaje que recibiste' }); return false; }
    if (doc.respondido) { res.status(409).json({ error: 'Esto ya fue respondido' }); return false; }
    if (new Date() > doc.codigo_expira) { res.status(410).json({ error: 'El código expiró; pide a RH que lo reenvíe' }); return false; }

    const llave = `${doc.id}:${doc.codigo_hash}`;
    if ((fallos.get(llave) ?? 0) >= INTENTOS_MAX) {
      res.status(429).json({ error: 'Demasiados intentos. Pide a RH que reenvíe el código.' });
      return false;
    }
    const valor = String(codigo ?? '');
    if (!/^\d{6}$/.test(valor) || !igualSeguro(hashCodigo(doc.codigo_sal, valor), doc.codigo_hash)) {
      fallos.set(llave, (fallos.get(llave) ?? 0) + 1);
      res.status(403).json({ error: 'Código incorrecto' });
      return false;
    }
    return true;
  };
}
