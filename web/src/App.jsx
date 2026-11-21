import { useEffect, useState } from 'react';
import Kiosco from './pages/Kiosco.jsx';
import PanelRh from './pages/PanelRh.jsx';
import Firma from './pages/Firma.jsx';
import Convenio from './pages/Convenio.jsx';
import MiChecador from './pages/MiChecador.jsx';

function useRuta() {
  const [ruta, setRuta] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => {
    const cambio = () => setRuta(location.hash.slice(1) || '/');
    addEventListener('hashchange', cambio);
    return () => removeEventListener('hashchange', cambio);
  }, []);
  return ruta;
}

export default function App() {
  const ruta = useRuta();
  if (ruta.startsWith('/kiosco')) return <Kiosco />;
  if (ruta.startsWith('/rh')) return <PanelRh />;
  if (ruta.startsWith('/mi')) return <MiChecador />;
  const firma = /^\/firma\/(\d+)/.exec(ruta);
  if (firma) return <Firma resumenId={Number(firma[1])} />;
  const convenio = /^\/convenio\/(\d+)/.exec(ruta);
  if (convenio) return <Convenio convenioId={Number(convenio[1])} />;

  return (
    <main className="inicio">
      <p className="sobretitulo">Checador 2027</p>
      <h1>Registro de jornada con evidencia legal</h1>
      <p className="tenue">Elige qué pantalla abrir en este dispositivo.</p>
      <div className="inicio-opciones">
        <a href="#/kiosco" className="tarjeta-opcion">
          <strong>Kiosco</strong>
          <span>Tablet en la entrada: PIN y foto automática.</span>
        </a>
        <a href="#/mi" className="tarjeta-opcion">
          <strong>Mi checador</strong>
          <span>Para el trabajador: registrar desde casa u otro lugar (home office e híbridos).</span>
        </a>
        <a href="#/rh" className="tarjeta-opcion">
          <strong>Panel de RH</strong>
          <span>Horas contra el tope, correcciones, firmas e integridad.</span>
        </a>
      </div>
    </main>
  );
}
