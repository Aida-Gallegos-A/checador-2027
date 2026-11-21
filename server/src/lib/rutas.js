// Rutas de datos configurables. "~/..." se expande a la carpeta personal del usuario del servidor,
// para guardar la base y las fotos FUERA de la carpeta de la app (que se reemplaza en cada publicación).
import { homedir } from 'node:os';
import path from 'node:path';

export function rutaDatos(valor, defecto) {
  const v = valor && valor.trim() ? valor.trim() : defecto;
  if (v === 'memory') return v;
  if (v === '~' || v.startsWith('~/') || v.startsWith('~\\')) return path.join(homedir(), v.slice(1));
  return path.resolve(v);
}

export const dirBase = () => rutaDatos(process.env.PGLITE_DIR, './data/pglite');
export const dirAlmacen = () => rutaDatos(process.env.STORAGE_DIR, './storage');
