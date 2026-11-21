// Datos de la empresa que aparecen en el aviso de privacidad, el convenio y el expediente.
import { useEffect, useState } from 'react';
import { rh } from '../api.js';

export default function Empresa({ onCambio, onAviso }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => { rh.empresa().then(setD).catch((e) => setError(e.message)); }, []);

  async function guardar(e) {
    e.preventDefault();
    setOcupado(true); setError(null);
    try {
      setD(await rh.guardarEmpresa({ nombre: d.nombre, rfc: d.rfc ?? '', domicilio: d.domicilio ?? '', correo_privacidad: d.correo_privacidad ?? '' }));
      onCambio();
      onAviso('Datos de la empresa guardados. Los convenios que se envíen desde ahora los incluyen; los ya firmados conservan su texto original.');
    } catch (err) { setError(err.message); }
    setOcupado(false);
  }

  if (!d) return <p>{error ?? 'Cargando…'}</p>;
  const set = (k) => (e) => setD({ ...d, [k]: e.target.value });
  return (
    <section className="tarjeta tarjeta-form">
      <h2>Datos de la empresa</h2>
      <p className="tenue">Aparecen en el convenio, el aviso de privacidad y el expediente para inspección. Cada cambio queda en la bitácora.</p>
      <form className="formulario" onSubmit={guardar}>
        <label>Razón social<input required value={d.nombre ?? ''} onChange={set('nombre')} /></label>
        <label>RFC<input value={d.rfc ?? ''} onChange={(e) => setD({ ...d, rfc: e.target.value.toUpperCase() })} placeholder="ABC200101XY1" maxLength={13} /></label>
        <label>Domicilio (para el aviso de privacidad)<textarea rows={2} value={d.domicilio ?? ''} onChange={set('domicilio')} placeholder="Calle, número, colonia, alcaldía o municipio, C.P., estado" /></label>
        <label>Correo para derechos ARCO<input type="email" value={d.correo_privacidad ?? ''} onChange={set('correo_privacidad')} placeholder="privacidad@empresa.mx" /></label>
        {error && <p className="error">{error}</p>}
        <div className="acciones"><button className="boton" disabled={ocupado}>{ocupado ? 'Guardando…' : 'Guardar'}</button></div>
      </form>
    </section>
  );
}
