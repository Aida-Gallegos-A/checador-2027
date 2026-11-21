// Generar el expediente PDF de un trabajador para una inspección de la STPS o una demanda.
import { useEffect, useState } from 'react';
import { MODALIDADES, rh, sumarDias } from '../api.js';

const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());

export default function Expediente({ empleadoInicial }) {
  const [empleados, setEmpleados] = useState(null);
  const [f, setF] = useState(() => ({
    empleado_id: empleadoInicial ?? '',
    desde: sumarDias(hoy(), -30),
    hasta: hoy(),
    generado_por: (() => { try { return localStorage.getItem('checador.supervisor') ?? ''; } catch { return ''; } })(),
  }));
  const [resultado, setResultado] = useState(null);
  const [error, setError] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => { rh.empleados().then(setEmpleados).catch((e) => setError(e.message)); }, []);

  async function generar(e) {
    e.preventDefault();
    setOcupado(true); setError(null); setResultado(null);
    try {
      try { localStorage.setItem('checador.supervisor', f.generado_por); } catch { /* sin almacenamiento */ }
      setResultado(await rh.expediente(f));
    } catch (err) { setError(err.message); }
    setOcupado(false);
  }

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const atajo = (dias) => setF({ ...f, desde: sumarDias(hoy(), -dias), hasta: hoy() });

  return (
    <section className="tarjeta">
      <h2>Expediente para inspección STPS o demanda</h2>
      <p className="tenue">PDF con el convenio firmado, resúmenes semanales y su confirmación, cada registro con su evidencia (fotos verificadas, GPS o IP),
        correcciones con su historial y los hashes para que un perito verifique que nada se alteró.</p>
      <form className="formulario" onSubmit={generar}>
        <label>Trabajador
          <select required value={f.empleado_id} onChange={set('empleado_id')}>
            <option value="">Elige…</option>
            {(empleados ?? []).map((e) => (
              <option key={e.id} value={e.id}>{e.numero} · {e.nombre} ({MODALIDADES[e.modalidad]}){e.activo ? '' : ' · baja'}</option>
            ))}
          </select>
        </label>
        <div className="dos-columnas">
          <label>Desde<input type="date" required value={f.desde} onChange={set('desde')} max={f.hasta} /></label>
          <label>Hasta<input type="date" required value={f.hasta} onChange={set('hasta')} min={f.desde} /></label>
        </div>
        <div className="chips">
          {[[30, 'Último mes'], [90, '3 meses'], [365, 'Último año']].map(([d, t]) => (
            <button type="button" key={d} className="chip" onClick={() => atajo(d)}>{t}</button>
          ))}
        </div>
        <label>Generado por<input required value={f.generado_por} onChange={set('generado_por')} placeholder="Tu nombre (queda en la bitácora)" /></label>
        {error && <p className="error">{error}</p>}
        <div className="acciones"><button className="boton" disabled={ocupado}>{ocupado ? 'Generando…' : 'Generar PDF'}</button></div>
      </form>
      {resultado && (
        <div className="resultado-cadena ok">
          <strong>Descargado: {resultado.nombre}</strong>
          <p>Quedó constancia en la bitácora con la huella de este archivo. Si alguien modifica el PDF, su huella ya no coincidirá:</p>
          <p className="hash">SHA-256: {resultado.huella}</p>
        </div>
      )}
    </section>
  );
}
