// "Mi checador": el trabajador registra desde su celular o computadora cuando no está en la oficina.
// Se vincula una vez con su celular y un código por WhatsApp. Se guarda IP y dispositivo, nunca su ubicación.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorApi, h, hora, LUGARES, TIPOS, tokens, yo } from '../api.js';

export default function MiChecador() {
  const [vinculado, setVinculado] = useState(() => Boolean(tokens.dispositivo()));
  return vinculado
    ? <Checador onDesvincular={() => { tokens.setDispositivo(''); setVinculado(false); }} />
    : <Activar onListo={(token) => { tokens.setDispositivo(token); setVinculado(true); }} />;
}

function Activar({ onListo }) {
  const [paso, setPaso] = useState('telefono');
  const [telefono, setTelefono] = useState('');
  const [codigo, setCodigo] = useState('');
  const [demo, setDemo] = useState(null);
  const [error, setError] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  const intentar = (fn) => async (e) => {
    e.preventDefault();
    setError(null); setOcupado(true);
    try { await fn(); } catch (err) { setError(err.message); }
    setOcupado(false);
  };

  return (
    <main className="inicio mi">
      <p className="sobretitulo">Mi checador</p>
      {paso === 'telefono' ? (
        <form className="formulario" onSubmit={intentar(async () => {
          const r = await yo.solicitar(telefono);
          setDemo(r.codigo_demo ?? null);
          setPaso('codigo');
        })}>
          <h1>Activa tu checador</h1>
          <p className="tenue">Para registrar tu jornada cuando trabajas fuera de la oficina. Solo lo haces una vez en este dispositivo.</p>
          <label>Tu celular
            <input inputMode="tel" autoComplete="tel" value={telefono} onChange={(e) => setTelefono(e.target.value)} placeholder="55 1234 5678" autoFocus required />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="boton" disabled={ocupado}>Enviarme un código por WhatsApp</button>
        </form>
      ) : (
        <form className="formulario" onSubmit={intentar(async () => onListo((await yo.confirmar(telefono, codigo)).token))}>
          <h1>Escribe tu código</h1>
          <p className="tenue">Si tu número está registrado en tu empresa, te llegó un código por WhatsApp. Vence en 10 minutos.</p>
          {demo && <p className="nota-alerta">Modo demo: el código es <strong>{demo}</strong></p>}
          <input className="codigo" inputMode="numeric" maxLength={6} value={codigo} autoFocus aria-label="Código de 6 dígitos"
            onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))} />
          {error && <p className="error">{error}</p>}
          <button className="boton" disabled={codigo.length !== 6 || ocupado}>Activar</button>
          <button type="button" className="enlace" onClick={() => { setPaso('telefono'); setCodigo(''); setError(null); }}>Cambiar número o pedir otro código</button>
        </form>
      )}
    </main>
  );
}

function Checador({ onDesvincular }) {
  const [d, setD] = useState(null);
  const [desfase, setDesfase] = useState(0);
  const [ahora, setAhora] = useState(Date.now());
  const [lugar, setLugar] = useState('casa');
  const [confirmacion, setConfirmacion] = useState(null);
  const [error, setError] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const alDesvincular = useRef(onDesvincular);
  alDesvincular.current = onDesvincular;

  const cargar = useCallback(async () => {
    try {
      const r = await yo.estado();
      setD(r);
      setDesfase(new Date(r.hora_servidor).getTime() - Date.now());
    } catch (e) {
      if (e instanceof ErrorApi && e.status === 401) alDesvincular.current();
      else setError(e.message);
    }
  }, []);

  useEffect(() => {
    cargar();
    const reloj = setInterval(() => setAhora(Date.now()), 1000);
    const refresco = setInterval(cargar, 60_000);
    return () => { clearInterval(reloj); clearInterval(refresco); };
  }, [cargar]);

  useEffect(() => {
    if (!confirmacion) return;
    const t = setTimeout(() => setConfirmacion(null), 4000);
    return () => clearTimeout(t);
  }, [confirmacion]);

  async function checar(tipo) {
    if (tipo === 'salida' && !confirm('¿Terminar tu jornada de hoy?')) return;
    setError(null); setOcupado(true);
    try {
      const r = await yo.checar(tipo, tipo === 'entrada' || tipo === 'regreso_comida' ? lugar : undefined);
      setConfirmacion(`${TIPOS[tipo]} registrada a las ${hora(r.hora)}${r.lugar && r.lugar !== 'oficina' ? ` · ${LUGARES[r.lugar]}` : ''}`);
      await cargar();
    } catch (e) { setError(e.message); }
    setOcupado(false);
  }

  async function desvincular() {
    if (!confirm('¿Desvincular este dispositivo? Para volver a usarlo tendrás que activarlo con un código.')) return;
    try { await yo.salir(); } catch { /* si ya no estaba vinculado, igual se limpia */ }
    onDesvincular();
  }

  if (!d) return <main className="inicio mi"><p>{error ?? 'Cargando…'}</p></main>;

  const reloj = ahora + desfase;
  const minutosHoy = d.hoy.minutos_cerrados
    + (d.estado === 'trabajando' && d.ultima ? Math.max(0, (reloj - new Date(d.ultima.hora).getTime()) / 60000) : 0);
  const pct = Math.min(100, (minutosHoy / d.hoy.jornada_diaria_min) * 100);
  const extra = minutosHoy > d.hoy.jornada_diaria_min;
  const hhmm = (m) => `${Math.floor(m / 60)} h ${String(Math.floor(m % 60)).padStart(2, '0')} min`;
  const lugarTexto = d.lugar_actual === 'oficina' ? 'en la oficina' : d.lugar_actual === 'casa' ? 'desde casa' : d.lugar_actual === 'otro' ? 'desde otro lugar' : '';

  const ESTADO = {
    fuera: { titulo: 'Fuera de turno', detalle: d.ultima?.tipo === 'salida' ? `Terminaste a las ${hora(d.ultima.hora)}` : 'Aún no inicias tu jornada' },
    trabajando: { titulo: `Trabajando ${lugarTexto}`, detalle: `Desde las ${hora(d.ultima.hora)}` },
    en_pausa: { titulo: 'En pausa', detalle: `Desde las ${hora(d.ultima.hora)}` },
  }[d.estado];

  const necesitaLugar = d.permitidos.includes('entrada') || d.permitidos.includes('regreso_comida');

  return (
    <main className="inicio mi">
      <header className="mi-cabeza">
        <div>
          <p className="sobretitulo">{d.empresa}</p>
          <h1>Hola, {d.empleado.nombre.split(' ')[0]}</h1>
        </div>
        <span className="mi-reloj">{hora(reloj)}</span>
      </header>

      <section className={`tarjeta mi-estado mi-${d.estado}`}>
        <strong>{ESTADO.titulo}</strong>
        <span className="tenue">{ESTADO.detalle}</span>
        {d.estado !== 'fuera' || d.hoy.minutos_cerrados > 0 ? (
          <>
            <div className="barra-pista mi-barra"><div className={`barra-relleno ${extra ? 'sobre' : pct > 90 ? 'cerca' : ''}`} style={{ width: `${pct}%` }} /></div>
            <span>Hoy: <strong>{hhmm(minutosHoy)}</strong> de {hhmm(d.hoy.jornada_diaria_min)}</span>
            {extra && d.estado === 'trabajando' && (
              <p className="nota-alerta">Ya cumpliste tu jornada. Si continúas, se registrará como <strong>tiempo extra</strong> y tu supervisor lo verá.</p>
            )}
          </>
        ) : null}
      </section>

      {confirmacion && <div className="aviso" role="status">✓ {confirmacion}</div>}
      {error && <p className="error">{error}</p>}

      {!d.puede_remoto ? (
        <p className="nota-alerta">Tu registro es en el kiosco de tu centro de trabajo. Si algunos días trabajas desde casa, pide a RH que te cambie a modalidad híbrida.</p>
      ) : (
        <section className="mi-acciones">
          {necesitaLugar && (
            <fieldset className="mi-lugar">
              <legend>¿Desde dónde trabajas{d.permitidos.includes('regreso_comida') ? ' ahora' : ' hoy'}?</legend>
              {[['casa', 'En casa'], ['otro', 'Otro lugar']].map(([k, v]) => (
                <label key={k} className={lugar === k ? 'activo' : ''}>
                  <input type="radio" name="lugar" value={k} checked={lugar === k} onChange={() => setLugar(k)} /> {v}
                </label>
              ))}
              <small className="tenue">Solo guardamos la IP y el tipo de dispositivo, nunca tu ubicación. ¿Estás en la oficina? Checa en el kiosco de la entrada.</small>
            </fieldset>
          )}
          {d.permitidos.includes('entrada') && <button className="boton boton-grande" disabled={ocupado} onClick={() => checar('entrada')}>Iniciar jornada</button>}
          {d.permitidos.includes('regreso_comida') && <button className="boton boton-grande" disabled={ocupado} onClick={() => checar('regreso_comida')}>Regresar de la pausa</button>}
          {d.permitidos.includes('salida_comida') && <button className="boton-secundario boton-grande" disabled={ocupado} onClick={() => checar('salida_comida')}>Pausa para comer</button>}
          {d.permitidos.includes('salida') && <button className="boton boton-grande boton-terminar" disabled={ocupado} onClick={() => checar('salida')}>Terminar jornada</button>}
        </section>
      )}

      <section className="tarjeta mi-semana">
        <div><span className="tenue">Esta semana</span><strong>{h(d.semana.total)}</strong><small>de {d.semana.tope} h</small></div>
        <div><span className="tenue">Extra</span><strong>{h(d.semana.extra)}</strong></div>
        {d.puede_remoto && <div><span className="tenue">A distancia</span><strong>{d.semana.porcentaje_remoto}%</strong><small>del tiempo</small></div>}
      </section>

      <footer className="mi-pie">
        <span className="tenue">{d.empleado.nombre} · {d.dispositivo}</span>
        <button className="enlace" onClick={desvincular}>Desvincular este dispositivo</button>
      </footer>
    </main>
  );
}
