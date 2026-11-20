import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { sha256 } from './cadena.js';

const secreto = () => process.env.APP_SECRET ?? 'secreto-de-desarrollo';

/** Índice de PIN: permite buscar al empleado por PIN sin guardar el PIN en claro. */
export function indicePin(empresaId, pin) {
  return createHmac('sha256', secreto()).update(`pin:${empresaId}:${pin}`).digest('hex');
}

export function hashToken(token) {
  return sha256(`token:${token}`);
}

/** Código de 6 dígitos para firmar (se manda por WhatsApp/SMS). */
export function generarCodigo() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function generarSal() {
  return randomBytes(12).toString('hex');
}

/** El código nunca se guarda en claro: solo HMAC(secreto, sal + código). */
export function hashCodigo(sal, codigo) {
  return createHmac('sha256', secreto()).update(`firma:${sal}:${codigo}`).digest('hex');
}

export function igualSeguro(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
