// Página que abre el trabajador desde WhatsApp: escribe su código, lee los tres documentos y firma.
import { useState } from 'react';
import { convenios } from '../api.js';

export default function Convenio({ convenioId }) {
  const [codigo, setCodigo] = useState('');
  const [datos, setDatos] = useState(null);
  const [abierto, setAbierto] = useState(0);
  const [leidos, setLeidos] = useState(new Set([0]));
  const [acepto, setAcepto] = useState(false);
  const [dudas, setDudas] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [hecho, setHecho] = useState(null);
  const [error, setError] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  const intentar = (fn) => async (e) => {
    e?.preventDefault();
    setError(null); setOcupado(true);
    try { await fn(); } catch (err) { setError(err.message); }
    setOcupado(false);
  };

  const abrir = (i) => { setAbierto(abierto === i ? -1 : i); setLeidos(new Set([...leidos, i])); };

  if (hecho) {
    return (
      <main className="inicio">
        <div className={`palomita ${hecho === 'rechazado' ? 'palomita-alerta' : ''}`} aria-hidden>{hecho === 'firmado' ? '✓' : '!'}</div>
        <h1>{hecho === 'firmado' ? 'Convenio firmado' : 'Recibimos tus comentarios'}</h1>
        <p className="tenue">{hecho === 'firmado'
          ? 'Gracias. Tu firma quedó registrada. Puedes pedir una copia a RH cuando quieras.'
          : 'RH se pondrá en contacto contigo para resolver tus dudas antes de firmar.'}</p>
      </main>
    );
  }

  if (!datos) {
    return (
      <main className="inicio">
        <p className="sobretitulo">Convenio de registro de jornada</p>
        <form className="formulario" onSubmit={intentar(async () => setDatos(await convenios.ver(convenioId, codigo)))}>
          <h1>Escribe tu código</h1>
          <p className="tenue">Te llegó por WhatsApp junto con el enlace a esta página.</p>
          <input className="codigo" inputMode="numeric" maxLength={6} value={codigo} autoFocus aria-label="Código de 6 dígitos"
            onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))} />
          {error && <p className="error">{error}</p>}
          <button className="boton" disabled={codigo.length !== 6 || ocupado}>Ver documentos</button>
        </form>
      </main>
    );
  }

  const todosLeidos = leidos.size >= datos.documentos.length;
  return (
    <main className="inicio inicio-ancho">
      <p className="sobretitulo">{datos.empresa}</p>
      <h1>Hola, {datos.empleado.split(' ')[0]}</h1>
      <p className="tenue">Antes de usar el checador necesitamos tu acuerdo. Lee los tres documentos; explican qué se registra, qué no y cuáles son tus derechos.</p>

      <div className="documentos">
        {datos.documentos.map((d, i) => (
          <section key={d.clave} className={`documento ${abierto === i ? 'abierto' : ''}`}>
            <button className="documento-cabeza" onClick={() => abrir(i)} aria-expanded={abierto === i}>
              <span className={`documento-check ${leidos.has(i) ? 'leido' : ''}`} aria-hidden>{leidos.has(i) ? '✓' : i + 1}</span>
              <strong>{d.titulo}</strong>
              <span className="tenue">{abierto === i ? 'Cerrar' : 'Leer'}</span>
            </button>
            {abierto === i && <div className="documento-texto">{d.texto}</div>}
          </section>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      {!dudas ? (
        <>
          <label className="casilla casilla-grande">
            <input type="checkbox" checked={acepto} disabled={!todosLeidos} onChange={(e) => setAcepto(e.target.checked)} />
            <span>{todosLeidos ? 'Leí los tres documentos y estoy de acuerdo.' : 'Abre los tres documentos para poder firmar.'}</span>
          </label>
          <div className="acciones">
            <button className="boton" disabled={!acepto || ocupado}
              onClick={intentar(async () => { await convenios.firmar(convenioId, codigo); setHecho('firmado'); })}>
              Firmar con mi código
            </button>
            <button className="boton-secundario" onClick={() => setDudas(true)}>Tengo dudas o no estoy de acuerdo</button>
          </div>
        </>
      ) : (
        <form className="formulario" onSubmit={intentar(async () => { await convenios.rechazar(convenioId, codigo, motivo); setHecho('rechazado'); })}>
          <label>¿Qué dudas tienes o con qué no estás de acuerdo?
            <textarea required rows={4} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          </label>
          <div className="acciones">
            <button className="boton" disabled={ocupado}>Enviar a RH</button>
            <button type="button" className="boton-secundario" onClick={() => setDudas(false)}>Volver</button>
          </div>
        </form>
      )}
    </main>
  );
}
