// Alta, cambios, PIN y baja de empleados. Cada movimiento queda en la bitácora.
import { useEffect, useState } from 'react';
import { MODALIDADES, rh } from '../api.js';
import ImportarEmpleados from './ImportarEmpleados.jsx';

const JORNADAS = { diurna: 'Diurna (8 h)', nocturna: 'Nocturna (7 h)', mixta: 'Mixta (7.5 h)' };
const VACIO = { numero: '', nombre: '', puesto: '', telefono: '', modalidad: 'presencial', tipo_jornada: 'diurna', pin: '' };

export default function Empleados({ empresa, onCambio, onAviso }) {
  const [lista, setLista] = useState(null);
  const [importando, setImportando] = useState(false);
  const [form, setForm] = useState(null); // null | { modo: 'alta' | 'editar', datos }
  const [verBajas, setVerBajas] = useState(false);
  const [error, setError] = useState(null);

  const cargar = () => rh.empleados().then(setLista).catch((e) => setError(e.message));
  useEffect(() => { cargar(); }, []);

  const listo = async (mensaje) => { setForm(null); setError(null); await cargar(); onCambio(); onAviso(mensaje); };

  async function guardar(e) {
    e.preventDefault();
    const d = form.datos;
    try {
      if (form.modo === 'alta') {
        const r = await rh.altaEmpleado({ ...d, pin: d.pin || undefined });
        await listo(<span>{r.nombre} dado de alta. PIN para el kiosco: <strong className="pin-grande">{r.pin}</strong> (anótalo: no se vuelve a mostrar).</span>);
      } else {
        await rh.editarEmpleado(d.id, {
          nombre: d.nombre, puesto: d.puesto, telefono: d.telefono, modalidad: d.modalidad, tipo_jornada: d.tipo_jornada,
        });
        await listo(`Cambios de ${d.nombre} guardados.`);
      }
    } catch (err) { setError(err.message); }
  }

  async function cambiarPin(emp) {
    if (!confirm(`¿Generar un PIN nuevo para ${emp.nombre}? El anterior dejará de funcionar.`)) return;
    try {
      const r = await rh.nuevoPin(emp.id);
      onAviso(<span>Nuevo PIN de {emp.nombre}: <strong className="pin-grande">{r.pin}</strong> (anótalo: no se vuelve a mostrar).</span>);
    } catch (err) { setError(err.message); }
  }

  async function cambiarActivo(emp) {
    const motivo = emp.activo
      ? prompt(`Motivo de la baja de ${emp.nombre} (renuncia, despido, fin de contrato…):`)
      : prompt(`Motivo de la reactivación de ${emp.nombre}:`);
    if (motivo === null) return;
    try {
      await rh.editarEmpleado(emp.id, { activo: !emp.activo, motivo });
      await listo(emp.activo
        ? `${emp.nombre} dado de baja. Sus registros se conservan (al menos un año después del término de la relación laboral).`
        : `${emp.nombre} reactivado.`);
    } catch (err) { setError(err.message); }
  }

  if (!lista) return <p>{error ?? 'Cargando…'}</p>;
  const visibles = lista.filter((e) => verBajas || e.activo);
  const bajas = lista.filter((e) => !e.activo).length;

  return (
    <>
      <div className="acciones acciones-entre">
        <div className="acciones-grupo">
          <button className="boton" onClick={() => { setError(null); setForm({ modo: 'alta', datos: { ...VACIO } }); }}>+ Dar de alta</button>
          <button className="boton-secundario" onClick={() => setImportando(true)}>Importar desde Excel</button>
        </div>
        {bajas > 0 && (
          <label className="casilla"><input type="checkbox" checked={verBajas} onChange={(e) => setVerBajas(e.target.checked)} /> Mostrar bajas ({bajas})</label>
        )}
      </div>
      {error && !form && <p className="error">{error}</p>}

      <div className="tabla-scroll">
        <table>
          <thead><tr><th>No.</th><th>Nombre</th><th>Modalidad</th><th>Jornada</th><th>WhatsApp</th><th /></tr></thead>
          <tbody>
            {visibles.map((e) => (
              <tr key={e.id} className={e.activo ? '' : 'fila-baja'}>
                <td>{e.numero}</td>
                <td><strong>{e.nombre}</strong>{!e.activo && <span className="estado estado-sin_enviar"> Baja</span>}<br /><span className="tenue">{e.puesto}</span></td>
                <td>{MODALIDADES[e.modalidad]}</td>
                <td>{JORNADAS[e.tipo_jornada]}</td>
                <td>{e.telefono ?? <span className="texto-critico">Falta</span>}</td>
                <td className="celda-acciones">
                  {e.activo && <button className="enlace" onClick={() => { setError(null); setForm({ modo: 'editar', datos: { ...e, puesto: e.puesto ?? '', telefono: e.telefono ?? '' } }); }}>Editar</button>}
                  {e.activo && <button className="enlace" onClick={() => cambiarPin(e)}>Nuevo PIN</button>}
                  <button className="enlace" onClick={() => cambiarActivo(e)}>{e.activo ? 'Dar de baja' : 'Reactivar'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="tenue">El teléfono se usa para mandar por WhatsApp el convenio y el resumen semanal a firmar. Sin teléfono no hay firma.</p>

      {importando && (
        <ImportarEmpleados empresa={empresa} onCerrar={() => setImportando(false)} onImportado={() => { cargar(); onCambio(); }} />
      )}

      {form && (
        <div className="modal-fondo" onClick={() => setForm(null)}>
          <div className="modal modal-chico" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Empleado">
            <header className="modal-cabeza">
              <h2>{form.modo === 'alta' ? 'Alta de empleado' : `Editar a ${form.datos.nombre}`}</h2>
              <button className="cerrar" onClick={() => setForm(null)} aria-label="Cerrar">×</button>
            </header>
            <FormEmpleado form={form} setForm={setForm} onSubmit={guardar} error={error} />
          </div>
        </div>
      )}
    </>
  );
}

function FormEmpleado({ form, setForm, onSubmit, error }) {
  const d = form.datos;
  const set = (k) => (e) => setForm({ ...form, datos: { ...d, [k]: e.target.value } });
  const alta = form.modo === 'alta';
  return (
    <form className="formulario" onSubmit={onSubmit}>
      <div className="dos-columnas">
        <label>Número de empleado
          <input required value={d.numero} onChange={set('numero')} disabled={!alta} placeholder="005" />
        </label>
        <label>Teléfono (WhatsApp)
          <input value={d.telefono} onChange={set('telefono')} inputMode="tel" placeholder="55 1234 5678" />
        </label>
      </div>
      <label>Nombre completo<input required value={d.nombre} onChange={set('nombre')} autoFocus /></label>
      <label>Puesto<input value={d.puesto} onChange={set('puesto')} placeholder="Guardia, chofer, analista…" /></label>
      <div className="dos-columnas">
        <label>Modalidad
          <select value={d.modalidad} onChange={set('modalidad')}>
            {Object.entries(MODALIDADES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Tipo de jornada
          <select value={d.tipo_jornada} onChange={set('tipo_jornada')}>
            {Object.entries(JORNADAS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      {alta && (
        <label>PIN para el kiosco (opcional)
          <input value={d.pin} onChange={(e) => setForm({ ...form, datos: { ...d, pin: e.target.value.replace(/\D/g, '').slice(0, 4) } })}
            inputMode="numeric" placeholder="Vacío = se genera uno al azar" />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <div className="acciones">
        <button className="boton">{alta ? 'Dar de alta' : 'Guardar cambios'}</button>
        <button type="button" className="boton-secundario" onClick={() => setForm(null)}>Cancelar</button>
      </div>
    </form>
  );
}
