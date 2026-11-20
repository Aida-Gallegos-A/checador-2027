// Kiosco presencial: tipo de registro → PIN → "Hola, nombre" + cámara con cuenta regresiva → confirmación.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorApi, hora, kiosco, TIPOS } from '../api.js';

const INACTIVIDAD_MS = 20_000;
const CONFIRMACION_MS = 2_500;

export default function Kiosco() {
  const [paso, setPaso] = useState('tipo'); // tipo | pin | camara | enviando | listo
  const [tipo, setTipo] = useState(null);
  const [pin, setPin] = useState('');
  const [empleado, setEmpleado] = useState(null);
  const [aviso, setAviso] = useState(null);
  const [error, setError] = useState(null);
  const [resultado, setResultado] = useState(null);
  const [info, setInfo] = useState(null);
  const [desfase, setDesfase] = useState(0);
  const [ahora, setAhora] = useState(Date.now());

  const reiniciar = useCallback(() => {
    setPaso('tipo'); setTipo(null); setPin(''); setEmpleado(null); setAviso(null); setError(null); setResultado(null);
  }, []);

  // Reloj con la hora del servidor (la tablet puede estar mal; el registro usa la del servidor).
  useEffect(() => {
    kiosco.info()
      .then((i) => { setInfo(i); setDesfase(new Date(i.hora_servidor).getTime() - Date.now()); })
      .catch((e) => setError(e.status === 401 ? 'Este kiosco no está dado de alta.' : 'Sin conexión con el servidor.'));
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Si alguien deja el kiosco a medias, vuelve al inicio.
  useEffect(() => {
    if (paso !== 'pin') return;
    const t = setTimeout(reiniciar, INACTIVIDAD_MS);
    return () => clearTimeout(t);
  }, [paso, pin, reiniciar]);

  useEffect(() => {
    if (paso !== 'listo') return;
    const t = setTimeout(reiniciar, CONFIRMACION_MS);
    return () => clearTimeout(t);
  }, [paso, reiniciar]);

  async function identificar(valor) {
    setError(null);
    try {
      const r = await kiosco.identificar(valor);
      setEmpleado(r.empleado);
      if (!r.permitidos.includes(tipo)) {
        setAviso(r.ultima
          ? `Tu último registro fue "${TIPOS[r.ultima.tipo]}" a las ${hora(r.ultima.hora)}. Se registrará y RH lo revisará.`
          : 'No tienes una entrada registrada hoy. Se registrará y RH lo revisará.');
      }
      setPaso('camara');
    } catch (e) {
      setPin('');
      setError(e instanceof ErrorApi && e.status === 404 ? 'PIN no encontrado. Intenta de nuevo.' : e.message);
    }
  }

  function teclear(d) {
    if (pin.length >= 8) return;
    const nuevo = pin + d;
    setPin(nuevo);
    if (nuevo.length === 4) identificar(nuevo);
  }

  async function registrar(foto) {
    setPaso('enviando');
    try {
      const r = await kiosco.checar({ pin, tipo, foto, hora_dispositivo: new Date().toISOString() });
      setResultado(r);
      setPaso('listo');
    } catch (e) {
      setError(`No se pudo registrar: ${e.message}`);
      setPaso('pin');
      setPin('');
    }
  }

  return (
    <main className="kiosco">
      <header className="kiosco-barra">
        <span>{info ? `${info.empresa} · ${info.centro}` : 'Checador 2027'}</span>
        <span className="kiosco-reloj">{hora(ahora + desfase)}</span>
      </header>

      {paso === 'tipo' && (
        <section className="kiosco-centro">
          <h1>¿Qué vas a registrar?</h1>
          {error && <p className="kiosco-error">{error}</p>}
          <div className="kiosco-tipos">
            {Object.entries(TIPOS).map(([k, v]) => (
              <button key={k} className={`kiosco-tipo tipo-${k}`} onClick={() => { setTipo(k); setPaso('pin'); setError(null); }}>
                {v}
              </button>
            ))}
          </div>
        </section>
      )}

      {paso === 'pin' && (
        <section className="kiosco-centro">
          <p className="sobretitulo">{TIPOS[tipo]}</p>
          <h1>Teclea tu PIN</h1>
          <div className="pin-puntos" aria-label={`${pin.length} dígitos`}>
            {[0, 1, 2, 3].map((i) => <span key={i} className={i < pin.length ? 'lleno' : ''} />)}
          </div>
          {error && <p className="kiosco-error">{error}</p>}
          <div className="teclado">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} onClick={() => teclear(d)}>{d}</button>)}
            <button className="tecla-sec" onClick={reiniciar}>Cancelar</button>
            <button onClick={() => teclear('0')}>0</button>
            <button className="tecla-sec" onClick={() => setPin(pin.slice(0, -1))}>Borrar</button>
          </div>
        </section>
      )}

      {paso === 'camara' && (
        <section className="kiosco-centro">
          <h1>Hola, {empleado.nombre}</h1>
          {aviso && <p className="kiosco-aviso">{aviso}</p>}
          <Camara onFoto={registrar} />
          <button className="boton-secundario" onClick={reiniciar}>No soy yo</button>
        </section>
      )}

      {paso === 'enviando' && <section className="kiosco-centro"><h1>Registrando…</h1></section>}

      {paso === 'listo' && resultado && (
        <section className="kiosco-centro kiosco-listo">
          <div className="palomita" aria-hidden>✓</div>
          <h1>{TIPOS[resultado.tipo]} registrada</h1>
          <p className="kiosco-hora">{hora(resultado.hora)}</p>
          <p>{resultado.empleado.nombre}</p>
        </section>
      )}
    </main>
  );
}

/** Cámara frontal con óvalo guía y cuenta regresiva 3-2-1; toma la foto sola. */
function Camara({ onFoto }) {
  const video = useRef(null);
  const [cuenta, setCuenta] = useState(null);
  const [sinCamara, setSinCamara] = useState(false);
  const enviado = useRef(false);
  const alTomar = useRef(onFoto);
  alTomar.current = onFoto;

  useEffect(() => {
    let flujo;
    let cancelado = false;
    let intervalo;

    const empezarCuenta = () => {
      let n = 3;
      setCuenta(n);
      intervalo = setInterval(() => {
        n -= 1;
        if (n > 0) return setCuenta(n);
        clearInterval(intervalo);
        setCuenta(0);
        if (enviado.current) return;
        enviado.current = true;
        alTomar.current(capturar(video.current));
      }, 1000);
    };

    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false })
      .then((s) => {
        if (cancelado) { s.getTracks().forEach((t) => t.stop()); return; }
        flujo = s;
        video.current.srcObject = s;
        video.current.onloadeddata = empezarCuenta;
      })
      .catch(() => { if (!cancelado) { setSinCamara(true); empezarCuenta(); } });
    if (!navigator.mediaDevices) { setSinCamara(true); empezarCuenta(); }

    return () => {
      cancelado = true;
      clearInterval(intervalo);
      flujo?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="camara">
      <video ref={video} autoPlay playsInline muted />
      <div className="camara-ovalo" />
      {sinCamara && <p className="camara-sin">Cámara no disponible: el registro quedará marcado “sin foto”.</p>}
      {cuenta > 0 && <div className="camara-cuenta">{cuenta}</div>}
    </div>
  );
}

function capturar(video) {
  if (!video?.videoWidth) return null;
  const lienzo = document.createElement('canvas');
  lienzo.width = 480;
  lienzo.height = Math.round((480 * video.videoHeight) / video.videoWidth);
  lienzo.getContext('2d').drawImage(video, 0, 0, lienzo.width, lienzo.height);
  return lienzo.toDataURL('image/jpeg', 0.8);
}
