// Página que abre el trabajador desde el enlace de WhatsApp para confirmar u objetar su semana.
import { useState } from 'react';
import { fechaCorta, firmas, h } from '../api.js';

export default function Firma({ resumenId }) {
  const [codigo, setCodigo] = useState('');
  const [resumen, setResumen] = useState(null);
  const [objetando, setObjetando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [hecho, setHecho] = useState(null);
  const [error, setError] = useState(null);

  const intentar = (fn) => async (e) => {
    e?.preventDefault();
    setError(null);
    try { await fn(); } catch (err) { setError(err.message); }
  };

  if (hecho) {
    return (
      <main className="inicio">
        <div className="palomita" aria-hidden>✓</div>
        <h1>{hecho === 'firmada' ? 'Semana confirmada' : 'Objeción enviada'}</h1>
        <p className="tenue">{hecho === 'firmada'
          ? 'Gracias. Tu confirmación quedó registrada.'
          : 'RH revisará tus horas y te enviará un resumen corregido.'}</p>
      </main>
    );
  }

  return (
    <main className="inicio">
      <p className="sobretitulo">Confirmación semanal de horas</p>
      {!resumen ? (
        <form className="formulario" onSubmit={intentar(async () => setResumen((await firmas.ver(resumenId, codigo)).resumen))}>
          <h1>Escribe tu código</h1>
          <p className="tenue">Te llegó por WhatsApp junto con tu resumen.</p>
          <input className="codigo" inputMode="numeric" maxLength={6} value={codigo}
            onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))} autoFocus aria-label="Código de 6 dígitos" />
          {error && <p className="error">{error}</p>}
          <button className="boton" disabled={codigo.length !== 6}>Ver mi semana</button>
        </form>
      ) : (
        <>
          <h1>Semana del {fechaCorta(resumen.semana)} al {fechaCorta(resumen.domingo)}</h1>
          <dl className="resumen-firma">
            <div><dt>Días trabajados</dt><dd>{resumen.dias}</dd></div>
            <div><dt>Horas ordinarias</dt><dd>{h(resumen.ordinarias)}</dd></div>
            <div><dt>Horas extra dobles</dt><dd>{h(resumen.extra_dobles)}</dd></div>
            {resumen.extra_triples > 0 && <div><dt>Horas extra triples</dt><dd>{h(resumen.extra_triples)}</dd></div>}
            {resumen.jornadas_incompletas > 0 && <div><dt>Días sin salida registrada</dt><dd>{resumen.jornadas_incompletas}</dd></div>}
          </dl>
          {error && <p className="error">{error}</p>}
          {!objetando ? (
            <div className="acciones">
              <button className="boton" onClick={intentar(async () => { await firmas.confirmar(resumenId, codigo); setHecho('firmada'); })}>
                Confirmo mis horas
              </button>
              <button className="boton-secundario" onClick={() => setObjetando(true)}>Algo no cuadra</button>
            </div>
          ) : (
            <form className="formulario" onSubmit={intentar(async () => { await firmas.objetar(resumenId, codigo, motivo); setHecho('objetada'); })}>
              <label>¿Qué no cuadra?
                <textarea required rows={4} value={motivo} onChange={(e) => setMotivo(e.target.value)}
                  placeholder="Ej.: el jueves me quedé una hora más por un pedido urgente" />
              </label>
              <div className="acciones">
                <button className="boton">Enviar objeción</button>
                <button type="button" className="boton-secundario" onClick={() => setObjetando(false)}>Volver</button>
              </div>
            </form>
          )}
        </>
      )}
    </main>
  );
}
