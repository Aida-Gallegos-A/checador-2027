// Punto de entrada para Hostinger: su servidor (LiteSpeed) carga la app con require(),
// y el checador es ESM con await de nivel superior. Este archivo CommonJS lo carga con import().
import('./src/index.js').catch((error) => {
  console.error('No se pudo iniciar el checador:', error);
  process.exit(1);
});
