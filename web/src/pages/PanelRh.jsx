// Panel de RH: resumen con alertas, correcciones, firmas semanales e integridad/nómina.
import { useCallback, useEffect, useState } from 'react';
import Empleados from './Empleados.jsx';
import { ErrorApi, fechaCorta, fechaHora, h, hora, MODALIDADES, rh, sumarDias, TIPOS, tokens } from '../api.js';

const SECCIONES = { resumen: 'Resumen', empleados: 'Empleados', correcciones: 'Correcciones', firmas: 'Firmas semanales', integridad: 'Integridad y nómina' };
const ESTADO_FIRMA = { firmada: 'Firmada', pendiente: 'Pendiente', objetada: 'Objetada', sin_enviar: 'Sin enviar' };

export default function PanelRh() {
  const [token, setToken] = useState(tokens.rh());
  const [seccion, setSeccion] = useState('resumen');
  const [semana, setSemana] = useState(null);
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);
  const [aviso, setAviso] = useState(null);
  const [version, setVersion] = useState(0);
  const recargar = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!token) return;
    rh.resumen(semana)
      .then((d) => { setDatos(d); setError(null); if (!semana) setSemana(d.semana.lunes); })
      .catch((e) => {
        if (e instanceof ErrorApi && e.status === 401) { tokens.setRh(''); setToken(''); }
        setError(e.message);
      });
  }, [token, semana, version]);

  if (!token) return <Acceso onEntrar={(t) => { tokens.setRh(t); setToken(t); }} error={error} />;

  return (
    <div className="panel">
      <header className="panel-barra">
        <div>
          <p className="sobretitulo">Panel de RH</p>
          <strong>{datos?.empresa ?? '…'}</strong>
        </div>
        {semana && (
          <div className="selector-semana">
            <button onClick={() => setSemana(sumarDias(semana, -7))} aria-label="Semana anterior">‹</button>
            <span>{fechaCorta(semana)} – {fechaCorta(sumarDias(semana, 6))}</span>
            <button onClick={() => setSemana(sumarDias(semana, 7))} aria-label="Semana siguiente">›</button>
          </div>
        )}
      </header>

      <nav className="panel-pestanas">
        {Object.entries(SECCIONES).map(([k, v]) => (
          <button key={k} className={seccion === k ? 'activa' : ''} onClick={() => setSeccion(k)}>
            {v}
            {k === 'correcciones' && datos?.indicadores.correcciones_pendientes > 0 && (
              <span className="globo">{datos.indicadores.correcciones_pendientes}</span>
            )}
          </button>
        ))}
      </nav>

      {error && <p className="error">{error}</p>}
      {aviso && <div className="aviso" role="status">{aviso}<button onClick={() => setAviso(null)} aria-label="Cerrar">×</button></div>}

      <main className="panel-contenido">
        {seccion === 'resumen' && datos && <Resumen datos={datos} semana={semana} onCambio={recargar} onAviso={setAviso} />}
        {seccion === 'empleados' && <Empleados empresa={datos?.empresa} onCambio={recargar} onAviso={setAviso} />}
        {seccion === 'correcciones' && <Correcciones version={version} onCambio={recargar} onAviso={setAviso} />}
        {seccion === 'firmas' && semana && <Firmas semana={semana} version={version} onCambio={recargar} onAviso={setAviso} />}
        {seccion === 'integridad' && semana && <Integridad semana={semana} />}
      </main>
    </div>
  );
}

function Acceso({ onEntrar, error }) {
  const [t, setT] = useState('');
  return (
    <main className="inicio">
      <p className="sobretitulo">Panel de RH</p>
      <h1>Acceso</h1>
      <form className="formulario" onSubmit={(e) => { e.preventDefault(); if (t.trim()) onEntrar(t.trim()); }}>
        <label>Token de acceso<input value={t} onChange={(e) => setT(e.target.value)} placeholder="rh-demo" autoFocus /></label>
        {error && <p className="error">{error}</p>}
        <button className="boton">Entrar</button>
      </form>
    </main>
  );
}

// ---------- Resumen ----------

function Resumen({ datos, semana, onCambio, onAviso }) {
  const [detalle, setDetalle] = useState(null);
  const { indicadores: k, semana: s } = datos;
  return (
    <>
      <p className="tenue">
        Regla aplicada: tope de <strong>{s.regla?.topeSemanal} h</strong> semanales y hasta <strong>{s.regla?.extraMaxSemanal} h</strong> extra
        dobles ({s.regla?.anio}).
      </p>
      <div className="indicadores">
        <Indicador titulo="Dentro ahora" valor={k.presentes} nota={`${k.vinieron_hoy} vinieron hoy`} />
        <Indicador titulo="Salidas faltantes" valor={k.salidas_faltantes} alerta={k.salidas_faltantes > 0} />
        <Indicador titulo="Horas extra" valor={h(k.horas_extra)} nota="esta semana" />
        <Indicador titulo="Semanas firmadas" valor={`${k.semanas_firmadas}/${k.empleados}`} />
        <Indicador titulo="Correcciones" valor={k.correcciones_pendientes} nota="pendientes" alerta={k.correcciones_pendientes > 0} />
      </div>

      {datos.alertas.length > 0 && (
        <section className="tarjeta">
          <h2>Alertas para actuar antes de incumplir</h2>
          <ul className="alertas">
            {datos.alertas.map((a, i) => <li key={i} className={`nivel-${a.nivel}`}>{a.mensaje}</li>)}
          </ul>
        </section>
      )}

      <section className="tarjeta">
        <h2>Horas por persona contra el tope</h2>
        <div className="tabla-scroll">
          <table>
            <thead>
              <tr><th>Trabajador</th><th>Modalidad</th><th>Semana</th><th>Ordinarias</th><th>Extra dobles</th><th>Extra triples</th><th>Firma</th></tr>
            </thead>
            <tbody>
              {datos.empleados.map((f) => (
                <tr key={f.empleado.id} className="fila-click" onClick={() => setDetalle(f.empleado)}>
                  <td><strong>{f.empleado.nombre}</strong><br /><span className="tenue">{f.empleado.puesto}</span></td>
                  <td>{MODALIDADES[f.empleado.modalidad]}</td>
                  <td><Barra total={f.semana.total} tope={f.semana.regla.topeSemanal} /></td>
                  <td>{h(f.semana.ordinarias)}</td>
                  <td>{h(f.semana.extraDobles)}</td>
                  <td className={f.semana.extraTriples > 0 ? 'texto-critico' : ''}>{h(f.semana.extraTriples)}</td>
                  <td><Estado estado={f.firma.estado} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {detalle && (
        <DetalleEmpleado empleado={detalle} semana={semana} onCerrar={() => setDetalle(null)}
          onCorreccion={() => { onCambio(); onAviso('Corrección solicitada. Queda pendiente de aprobación.'); }} />
      )}
    </>
  );
}

function Indicador({ titulo, valor, nota, alerta }) {
  return (
    <div className={`indicador ${alerta ? 'indicador-alerta' : ''}`}>
      <span>{titulo}</span>
      <strong>{valor}</strong>
      {nota && <small>{nota}</small>}
    </div>
  );
}

function Barra({ total, tope }) {
  const pct = Math.min(100, (total / tope) * 100);
  const clase = total > tope ? 'sobre' : total >= tope - 2 ? 'cerca' : '';
  return (
    <div className="barra" title={`${total} de ${tope} h`}>
      <div className="barra-pista"><div className={`barra-relleno ${clase}`} style={{ width: `${pct}%` }} /></div>
      <span>{h(total)} / {tope}</span>
    </div>
  );
}

const Estado = ({ estado }) => <span className={`estado estado-${estado}`}>{ESTADO_FIRMA[estado] ?? estado}</span>;

function DetalleEmpleado({ empleado, semana, onCerrar, onCorreccion }) {
  const [d, setD] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { rh.semanaEmpleado(empleado.id, semana).then(setD).catch((e) => setError(e.message)); }, [empleado.id, semana]);

  async function enviar(e) {
    e.preventDefault();
    try {
      await rh.solicitarCorreccion({ empleado_id: empleado.id, ...form, hora: new Date(form.hora).toISOString() });
      setForm(null);
      onCorreccion();
      setD(await rh.semanaEmpleado(empleado.id, semana));
    } catch (err) { setError(err.message); }
  }

  const checadas = d?.eventos.filter((e) => e.clase === 'checada' || e.clase === 'correccion_aprobada') ?? [];
  const reemplazadas = new Set(d?.eventos.filter((e) => e.clase === 'correccion_aprobada').map((e) => e.datos.reemplaza) ?? []);

  return (
    <div className="modal-fondo" onClick={onCerrar}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={empleado.nombre}>
        <header className="modal-cabeza">
          <div><h2>{empleado.nombre}</h2><span className="tenue">{MODALIDADES[empleado.modalidad]} · jornada {empleado.tipo_jornada}</span></div>
          <button className="cerrar" onClick={onCerrar} aria-label="Cerrar">×</button>
        </header>
        {error && <p className="error">{error}</p>}
        {!d ? <p>Cargando…</p> : (
          <>
            <h3>Jornadas</h3>
            <table>
              <thead><tr><th>Día</th><th>Entrada</th><th>Salida</th><th>Trabajado</th><th>Incidencias</th></tr></thead>
              <tbody>
                {d.jornadas.map((j, i) => (
                  <tr key={i}>
                    <td>{fechaCorta(j.fecha)}</td>
                    <td>{hora(j.entrada)}</td>
                    <td>{j.salida ? hora(j.salida) : <span className="texto-critico">Sin salida</span>}</td>
                    <td>{h(j.minutosTrabajados / 60)}</td>
                    <td className="tenue">{j.incidencias.join(', ').replaceAll('_', ' ')}</td>
                  </tr>
                ))}
                {d.jornadas.length === 0 && <tr><td colSpan={5} className="tenue">Sin jornadas esta semana.</td></tr>}
              </tbody>
            </table>

            <h3>Registros (nada se borra)</h3>
            <ul className="registros">
              {checadas.map((e) => (
                <li key={e.id} className={reemplazadas.has(e.id) ? 'reemplazado' : ''}>
                  <span>{fechaHora(e.hora)}</span>
                  <span>{TIPOS[e.datos.tipo]}</span>
                  <span className="tenue">
                    {e.clase === 'correccion_aprobada' ? `Corrección aprobada por ${e.datos.decidido_por}` : e.datos.origen}
                    {e.datos.evidencia?.foto_sha256 && ' · con foto'}
                    {e.datos.evidencia?.gps && ' · GPS'}
                    {(e.datos.banderas ?? []).length > 0 && ` · ⚠ ${e.datos.banderas.join(', ').replaceAll('_', ' ')}`}
                  </span>
                  {!reemplazadas.has(e.id) && e.clase === 'checada' && (
                    <button className="enlace" onClick={() => setForm({ tipo: e.datos.tipo, reemplaza: e.id, hora: aLocal(e.hora), motivo: '', solicitado_por: '' })}>Corregir</button>
                  )}
                </li>
              ))}
            </ul>
            {!form && (
              <button className="boton-secundario" onClick={() => setForm({ tipo: 'salida', reemplaza: null, hora: '', motivo: '', solicitado_por: '' })}>
                Agregar registro faltante
              </button>
            )}
            {form && (
              <form className="formulario" onSubmit={enviar}>
                <h3>{form.reemplaza ? 'Corregir registro' : 'Agregar registro faltante'}</h3>
                <label>Tipo
                  <select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
                    {Object.entries(TIPOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
                <label>Hora correcta<input type="datetime-local" required value={form.hora} onChange={(e) => setForm({ ...form, hora: e.target.value })} /></label>
                <label>Motivo<input required value={form.motivo} onChange={(e) => setForm({ ...form, motivo: e.target.value })} placeholder="Olvidó checar al salir" /></label>
                <label>Solicitado por<input required value={form.solicitado_por} onChange={(e) => setForm({ ...form, solicitado_por: e.target.value })} placeholder={empleado.nombre} /></label>
                <div className="acciones">
                  <button className="boton">Solicitar corrección</button>
                  <button type="button" className="boton-secundario" onClick={() => setForm(null)}>Cancelar</button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Fecha para <input type="datetime-local"> en hora de la Ciudad de México. */
function aLocal(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// ---------- Correcciones ----------

function Correcciones({ version, onCambio, onAviso }) {
  const [lista, setLista] = useState(null);
  const [quien, setQuien] = useState(() => { try { return localStorage.getItem('checador.supervisor') ?? ''; } catch { return ''; } });
  const [error, setError] = useState(null);

  useEffect(() => { rh.correcciones().then(setLista).catch((e) => setError(e.message)); }, [version]);

  async function decidir(c, aprobar) {
    if (!quien.trim()) { setError('Escribe tu nombre para dejar constancia de quién decide.'); return; }
    try { localStorage.setItem('checador.supervisor', quien); } catch { /* ignorar */ }
    try {
      await rh.decidir(c.id, { aprobar, decidido_por: quien.trim() });
      onAviso(`Corrección ${aprobar ? 'aprobada' : 'rechazada'}. El registro original se conserva.`);
      setError(null);
      onCambio();
    } catch (e) { setError(e.message); }
  }

  if (!lista) return <p>{error ?? 'Cargando…'}</p>;
  const pendientes = lista.filter((c) => c.estado === 'pendiente');
  const decididas = lista.filter((c) => c.estado !== 'pendiente');

  return (
    <>
      <label className="campo-linea">Decide: <input value={quien} onChange={(e) => setQuien(e.target.value)} placeholder="Tu nombre" /></label>
      {error && <p className="error">{error}</p>}
      <h2>Pendientes</h2>
      {pendientes.length === 0 && <p className="tenue">No hay correcciones pendientes.</p>}
      <div className="lista-tarjetas">
        {pendientes.map((c) => (
          <article key={c.id} className="tarjeta">
            <header><strong>{c.empleado}</strong> <span className="tenue">· pidió {c.solicitado_por}, {fechaHora(c.solicitada_en)}</span></header>
            <div className="comparar">
              <div><span className="tenue">Registro original</span><p>{c.original ? `${TIPOS[c.original.tipo]} · ${fechaHora(c.original.hora)}` : 'No existe (registro faltante)'}</p></div>
              <div><span className="tenue">Corrección solicitada</span><p><strong>{TIPOS[c.tipo]} · {fechaHora(c.hora_propuesta)}</strong></p></div>
            </div>
            <p>“{c.motivo}”</p>
            <div className="acciones">
              <button className="boton" onClick={() => decidir(c, true)}>Aprobar</button>
              <button className="boton-secundario" onClick={() => decidir(c, false)}>Rechazar</button>
            </div>
          </article>
        ))}
      </div>
      <h2>Historial</h2>
      <ul className="registros">
        {decididas.map((c) => (
          <li key={c.id}>
            <span>{c.empleado}</span>
            <span>{TIPOS[c.tipo]} {fechaHora(c.hora_propuesta)}</span>
            <span className="tenue">Pidió {c.solicitado_por} · {c.estado} por {c.decision?.por} el {fechaHora(c.decision?.en)}</span>
          </li>
        ))}
        {decididas.length === 0 && <li className="tenue">Sin historial todavía.</li>}
      </ul>
    </>
  );
}

// ---------- Firmas ----------

function Firmas({ semana, version, onCambio, onAviso }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { rh.firmas(semana).then(setD).catch((e) => setError(e.message)); }, [semana, version]);

  const avisoCodigo = (lista) => {
    const conCodigo = lista.filter((x) => x.codigo_demo);
    if (conCodigo.length === 0) return;
    onAviso(
      <span>Modo demo, códigos enviados: {conCodigo.map((x, i) => (
        <span key={i}>{i > 0 && ' · '}{x.empleado ?? 'trabajador'} <a href={`#/firma/${x.resumen_id}`} target="_blank" rel="noreferrer">{x.codigo_demo}</a></span>
      ))}</span>,
    );
  };

  async function enviar(empleadoId) {
    try {
      const r = await rh.enviarFirmas({ semana, ...(empleadoId ? { empleado_id: empleadoId } : {}) });
      if (r.enviados.length === 0) onAviso('No había resúmenes por enviar (los pendientes se recuerdan con “Recordar”).');
      else avisoCodigo(r.enviados);
      onCambio();
    } catch (e) { setError(e.message); }
  }

  async function recordar(f) {
    try {
      const r = await rh.recordar(f.resumen_id);
      avisoCodigo([{ ...r, empleado: f.empleado.nombre, resumen_id: f.resumen_id }]);
      onCambio();
    } catch (e) { setError(e.message); }
  }

  if (!d) return <p>{error ?? 'Cargando…'}</p>;
  return (
    <>
      <div className="acciones">
        <button className="boton" onClick={() => enviar()}>Enviar resúmenes por WhatsApp</button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="tabla-scroll">
        <table>
          <thead><tr><th>Trabajador</th><th>Resumen</th><th>Estado</th><th>Recordatorios</th><th /></tr></thead>
          <tbody>
            {d.firmas.map((f) => (
              <tr key={f.empleado.id}>
                <td><strong>{f.empleado.nombre}</strong></td>
                <td>{f.resumen ? `${h(f.resumen.ordinarias)} ord. · ${h(f.resumen.extra_dobles)} dobles${f.resumen.extra_triples ? ` · ${h(f.resumen.extra_triples)} triples` : ''}` : '—'}</td>
                <td>
                  <Estado estado={f.estado} />
                  {f.objecion && <p className="objecion">“{f.objecion}”</p>}
                  {f.respondido_en && <small className="tenue"> {fechaHora(f.respondido_en)}</small>}
                </td>
                <td>{f.recordatorios ?? 0}</td>
                <td>
                  {f.estado === 'pendiente' && <button className="enlace" onClick={() => recordar(f)}>Recordar</button>}
                  {f.estado === 'objetada' && <button className="enlace" onClick={() => enviar(f.empleado.id)}>Reenviar corregido</button>}
                  {f.estado === 'sin_enviar' && <button className="enlace" onClick={() => enviar(f.empleado.id)}>Enviar</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="tenue">Si el trabajador objeta, corrige sus registros (por ejemplo, agrega la hora extra que le pidieron) y reenvía el resumen.
        Cada envío, recordatorio y respuesta queda en la bitácora.</p>
    </>
  );
}

// ---------- Integridad y nómina ----------

function Integridad({ semana }) {
  const [v, setV] = useState(null);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(false);

  async function verificar() {
    setCargando(true);
    try { setV(await rh.verificar()); setError(null); } catch (e) { setError(e.message); }
    setCargando(false);
  }

  async function descargar() {
    try {
      const blob = await rh.nomina(semana);
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: `nomina-${semana}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="lista-tarjetas">
      <section className="tarjeta">
        <h2>Integridad de la bitácora</h2>
        <p className="tenue">Recorre todos los eventos y comprueba que la cadena de hashes no se rompió: si alguien alteró, borró o reordenó un registro directamente en la base, aparece aquí.</p>
        <button className="boton" onClick={verificar} disabled={cargando}>{cargando ? 'Verificando…' : 'Verificar ahora'}</button>
        {v && (
          <div className={`resultado-cadena ${v.integra ? 'ok' : 'mal'}`}>
            <strong>{v.integra ? 'Cadena íntegra' : 'Se detectaron alteraciones'}</strong>
            <p>{v.total} eventos verificados el {fechaHora(v.verificado_en)}</p>
            <p className="hash">Último hash: {v.ultimo_hash}</p>
            {v.problemas.map((p, i) => <p key={i}>Evento {p.id}: {p.problema}</p>)}
          </div>
        )}
      </section>
      <section className="tarjeta">
        <h2>Nómina</h2>
        <p className="tenue">Horas ordinarias, extra dobles, extra triples y estado de firma por trabajador, semana del {fechaCorta(semana)}.</p>
        <button className="boton" onClick={descargar}>Descargar CSV</button>
      </section>
      <section className="tarjeta">
        <h2>Expediente para inspección STPS</h2>
        <p className="tenue">Próximo paso: PDF por trabajador y periodo con registros, evidencia, correcciones, firmas y convenio.</p>
      </section>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
