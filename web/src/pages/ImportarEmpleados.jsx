// Importación masiva de empleados: plantilla → archivo → vista previa con errores por fila → importar → PINs.
import { useState } from 'react';
import { MODALIDADES, rh } from '../api.js';
import { descargarPines, descargarPlantilla, leerArchivoEmpleados } from '../excel.js';

const ACCION = { crear: 'Nuevo', actualizar: 'Actualizar', sin_cambios: 'Sin cambios', error: 'Con error' };
const CAMPOS = { nombre: 'nombre', puesto: 'puesto', telefono: 'teléfono', modalidad: 'modalidad', tipo_jornada: 'jornada' };

export default function ImportarEmpleados({ empresa, onCerrar, onImportado }) {
  const [paso, setPaso] = useState('archivo'); // archivo | revision | listo
  const [archivo, setArchivo] = useState(null);
  const [filas, setFilas] = useState(null);
  const [previa, setPrevia] = useState(null);
  const [resultado, setResultado] = useState(null);
  const [filtro, setFiltro] = useState('todas');
  const [error, setError] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [arrastrando, setArrastrando] = useState(false);
  const [enviarConvenio, setEnviarConvenio] = useState(true);

  async function elegir(f) {
    if (!f) return;
    setError(null); setOcupado(true); setArchivo(f);
    try {
      const leido = await leerArchivoEmpleados(f);
      if (leido.filas.length === 0) throw new Error('El archivo no tiene empleados debajo de los encabezados.');
      const p = await rh.importarEmpleados({ filas: leido.filas, confirmar: false });
      setFilas(leido.filas);
      setPrevia({ ...p, columnas: leido.columnas });
      setFiltro(p.resumen.errores > 0 ? 'error' : 'todas');
      setPaso('revision');
    } catch (e) {
      setError(e.message);
    }
    setOcupado(false);
  }

  async function importar() {
    setOcupado(true); setError(null);
    try {
      const r = await rh.importarEmpleados({ filas, confirmar: true, enviar_convenio: enviarConvenio });
      setResultado(r);
      setPaso('listo');
      onImportado();
    } catch (e) { setError(e.message); }
    setOcupado(false);
  }

  const aGuardar = previa ? previa.resumen.crear + previa.resumen.actualizar : 0;
  const visibles = previa?.filas.filter((f) => filtro === 'todas' || f.accion === filtro || (filtro === 'avisos' && f.avisos.length)) ?? [];

  return (
    <div className="modal-fondo" onClick={ocupado ? undefined : onCerrar}>
      <div className="modal modal-ancho" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Importar empleados">
        <header className="modal-cabeza">
          <div>
            <h2>Importar empleados desde Excel</h2>
            <Pasos actual={paso} />
          </div>
          <button className="cerrar" onClick={onCerrar} aria-label="Cerrar" disabled={ocupado}>×</button>
        </header>

        {paso === 'archivo' && (
          <>
            <div className="importar-plantilla">
              <div>
                <strong>1. Descarga la plantilla</strong>
                <p className="tenue">Columnas: Número, Nombre, Puesto, Teléfono, Modalidad, Jornada y PIN. Trae ejemplos e instrucciones.
                  También sirve tu propio Excel o CSV si usa esos encabezados.</p>
              </div>
              <button className="boton-secundario" onClick={() => descargarPlantilla().catch((e) => setError(e.message))}>Descargar plantilla</button>
            </div>
            <label
              className={`zona-archivo ${arrastrando ? 'arrastrando' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setArrastrando(true); }}
              onDragLeave={() => setArrastrando(false)}
              onDrop={(e) => { e.preventDefault(); setArrastrando(false); elegir(e.dataTransfer.files[0]); }}
            >
              <input type="file" accept=".xlsx,.csv" onChange={(e) => { elegir(e.target.files[0]); e.target.value = ''; }} disabled={ocupado} />
              <strong>2. {ocupado ? `Revisando ${archivo?.name}…` : 'Arrastra aquí tu archivo o haz clic para elegirlo'}</strong>
              <span className="tenue">.xlsx o .csv · hasta 3,000 empleados · nada se guarda hasta que confirmes</span>
            </label>
            {error && <p className="error">{error}</p>}
          </>
        )}

        {paso === 'revision' && previa && (
          <>
            <p className="tenue">{archivo?.name} · {previa.resumen.total} filas. Revisa antes de importar: todavía no se ha guardado nada.</p>
            <div className="chips">
              <Chip activo={filtro === 'todas'} onClick={() => setFiltro('todas')}>Todas {previa.resumen.total}</Chip>
              <Chip activo={filtro === 'crear'} onClick={() => setFiltro('crear')} clase="chip-ok">Nuevos {previa.resumen.crear}</Chip>
              <Chip activo={filtro === 'actualizar'} onClick={() => setFiltro('actualizar')} clase="chip-info">Actualizar {previa.resumen.actualizar}</Chip>
              {previa.resumen.sin_cambios > 0 && <Chip activo={filtro === 'sin_cambios'} onClick={() => setFiltro('sin_cambios')}>Sin cambios {previa.resumen.sin_cambios}</Chip>}
              <Chip activo={filtro === 'error'} onClick={() => setFiltro('error')} clase={previa.resumen.errores ? 'chip-error' : ''}>Con error {previa.resumen.errores}</Chip>
              <Chip activo={filtro === 'avisos'} onClick={() => setFiltro('avisos')}>Avisos {previa.filas.filter((f) => f.avisos.length).length}</Chip>
            </div>
            {!previa.columnas.includes('telefono') && <p className="nota-alerta">El archivo no trae columna de teléfono: nadie podrá firmar por WhatsApp hasta que lo agregues.</p>}
            {previa.resumen.errores > 0 && (
              <p className="nota-alerta">Las {previa.resumen.errores} filas con error <strong>no se importarán</strong>. Corrígelas en tu Excel y vuelve a subirlo (las que ya existan solo se actualizan), o importa las demás ahora.</p>
            )}
            <div className="tabla-scroll tabla-alta">
              <table>
                <thead><tr><th>Fila</th><th>Estado</th><th>No.</th><th>Nombre</th><th>Modalidad</th><th>Teléfono</th><th>Detalle</th></tr></thead>
                <tbody>
                  {visibles.map((f) => (
                    <tr key={f.fila} className={`fila-${f.accion}`}>
                      <td className="tenue">{f.fila}</td>
                      <td><span className={`estado accion-${f.accion}`}>{ACCION[f.accion]}</span></td>
                      <td>{f.numero}</td>
                      <td>{f.nombre}<br /><span className="tenue">{f.puesto}</span></td>
                      <td>{MODALIDADES[f.modalidad] ?? '—'}{f.tipo_jornada && f.tipo_jornada !== 'diurna' ? ` · ${f.tipo_jornada}` : ''}</td>
                      <td>{f.telefono ?? '—'}</td>
                      <td>
                        {f.errores.map((e, i) => <div key={i} className="texto-critico">{e}</div>)}
                        {f.cambios && Object.entries(f.cambios).map(([k, c]) => (
                          <div key={k} className="tenue">{CAMPOS[k]}: {c.antes ?? '—'} → <strong>{c.despues}</strong></div>
                        ))}
                        {f.avisos.map((a, i) => <div key={i} className="texto-alerta">{a}</div>)}
                      </td>
                    </tr>
                  ))}
                  {visibles.length === 0 && <tr><td colSpan={7} className="tenue">Nada en este filtro.</td></tr>}
                </tbody>
              </table>
            </div>
            {previa.resumen.crear > 0 && (
              <label className="casilla">
                <input type="checkbox" checked={enviarConvenio} onChange={(e) => setEnviarConvenio(e.target.checked)} />
                Enviar por WhatsApp el convenio y el aviso de privacidad a los {previa.resumen.crear} nuevos (los que tengan teléfono)
              </label>
            )}
            {error && <p className="error">{error}</p>}
            <div className="acciones">
              <button className="boton" onClick={importar} disabled={ocupado || aGuardar === 0}>
                {ocupado ? 'Importando…' : aGuardar === 0 ? 'Nada que importar' : `Importar ${aGuardar} empleado${aGuardar === 1 ? '' : 's'}`}
              </button>
              <button className="boton-secundario" onClick={() => { setPaso('archivo'); setPrevia(null); setError(null); }} disabled={ocupado}>Subir otro archivo</button>
            </div>
          </>
        )}

        {paso === 'listo' && resultado && (
          <>
            <div className="resultado-cadena ok">
              <strong>Importación terminada</strong>
              <p>{resultado.creados.length} dados de alta · {resultado.resumen.actualizar} actualizados
                {resultado.resumen.errores > 0 && ` · ${resultado.resumen.errores} filas con error no se importaron`}</p>
              {resultado.convenios_enviados > 0 && <p>Convenio enviado por WhatsApp a {resultado.convenios_enviados} trabajadores para su firma.</p>}
            </div>
            {resultado.creados.length > 0 && (
              <>
                <p className="nota-alerta"><strong>Descarga ahora los PINs.</strong> Por seguridad no se guardan en claro y no se vuelven a mostrar; si se pierden, hay que generar uno nuevo por persona.</p>
                <div className="acciones">
                  <button className="boton" onClick={() => descargarPines(resultado.creados, empresa).catch((e) => setError(e.message))}>Descargar PINs en Excel</button>
                </div>
                <div className="tabla-scroll tabla-alta">
                  <table>
                    <thead><tr><th>No.</th><th>Nombre</th><th>PIN</th></tr></thead>
                    <tbody>{resultado.creados.map((c) => <tr key={c.numero}><td>{c.numero}</td><td>{c.nombre}</td><td className="pin-grande">{c.pin}</td></tr>)}</tbody>
                  </table>
                </div>
              </>
            )}
            {error && <p className="error">{error}</p>}
            <div className="acciones"><button className="boton-secundario" onClick={onCerrar}>Cerrar</button></div>
          </>
        )}
      </div>
    </div>
  );
}

function Pasos({ actual }) {
  const pasos = [['archivo', 'Archivo'], ['revision', 'Revisión'], ['listo', 'PINs']];
  const i = pasos.findIndex(([k]) => k === actual);
  return (
    <ol className="pasos">
      {pasos.map(([k, v], j) => <li key={k} className={j < i ? 'hecho' : j === i ? 'actual' : ''}>{v}</li>)}
    </ol>
  );
}

const Chip = ({ activo, onClick, clase = '', children }) => (
  <button className={`chip ${clase} ${activo ? 'activo' : ''}`} onClick={onClick}>{children}</button>
);
