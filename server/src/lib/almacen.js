// Guarda la foto de evidencia. En producción se cambia por S3 o similar sin tocar las rutas.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Recibe una foto en data URL (image/jpeg o image/png), la guarda con su sha256 como nombre
 * y devuelve la huella. La huella va a la bitácora: si la foto se cambia, ya no coincide.
 */
export async function guardarFoto(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl ?? '');
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;

  const huella = createHash('sha256').update(bytes).digest('hex');
  const dir = path.resolve(process.env.STORAGE_DIR ?? './storage', 'fotos');
  await mkdir(dir, { recursive: true });
  const archivo = `${huella}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  await writeFile(path.join(dir, archivo), bytes);
  return { foto_sha256: huella, foto_archivo: archivo, foto_bytes: bytes.length };
}
