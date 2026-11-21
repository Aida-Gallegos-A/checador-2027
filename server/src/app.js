import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rutasKiosco } from './routes/kiosco.js';
import { rutasRh } from './routes/rh.js';
import { rutasFirmas } from './routes/firmas.js';
import { rutasConvenios } from './routes/convenios.js';
import { rutasYo } from './routes/yo.js';

// Pantallas ya compiladas (npm run build). En producción las sirve este mismo servidor.
const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

export function crearApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '4mb' })); // las fotos llegan en base64

  app.get('/api/salud', (_req, res) => res.json({ ok: true, hora_servidor: new Date() }));
  app.use('/api/kiosco', rutasKiosco(db));
  app.use('/api/rh', rutasRh(db));
  app.use('/api/firmas', rutasFirmas(db));
  app.use('/api/convenios', rutasConvenios(db));
  app.use('/api/yo', rutasYo(db));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, {
      index: 'index.html',
      setHeaders: (res, ruta) => {
        // Los archivos con huella en el nombre (assets/) se cachean; index.html nunca, para ver siempre la última versión.
        res.set('Cache-Control', /[\\/]assets[\\/]/.test(ruta) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.set('Cache-Control', 'no-cache').sendFile('index.html', { root: WEB_DIST }));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'La foto es demasiado grande' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  });
  return app;
}
