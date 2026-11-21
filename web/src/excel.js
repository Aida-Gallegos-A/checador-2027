// Lectura de la plantilla de empleados (Excel o CSV) y generación de archivos para descargar.
import readXlsxFile from 'read-excel-file/browser';
import writeXlsxFile from 'write-excel-file/browser';

const normal = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Encabezados aceptados para cada campo (ya normalizados: sin acentos, minúsculas).
const ENCABEZADOS = {
  numero: ['numero', 'no', 'num', 'numero de empleado', 'no de empleado', 'no empleado', 'num empleado', 'clave', 'clave empleado', 'id', 'nomina', 'numero nomina'],
  nombre: ['nombre', 'nombre completo', 'empleado', 'trabajador', 'colaborador'],
  puesto: ['puesto', 'cargo', 'area', 'posicion'],
  telefono: ['telefono', 'celular', 'whatsapp', 'tel', 'movil', 'telefono whatsapp', 'telefono celular'],
  modalidad: ['modalidad', 'tipo', 'esquema', 'modalidad de trabajo', 'tipo de trabajo'],
  jornada: ['jornada', 'tipo de jornada', 'turno'],
  pin: ['pin', 'nip', 'clave kiosco', 'pin kiosco'],
};

function campoDe(encabezado) {
  const n = normal(encabezado);
  if (!n) return null;
  for (const [campo, opciones] of Object.entries(ENCABEZADOS)) if (opciones.includes(n)) return campo;
  // Tolerante: "Nombre del empleado", "Teléfono (WhatsApp)", etc.
  for (const [campo, opciones] of Object.entries(ENCABEZADOS)) if (opciones.some((o) => o.length > 3 && n.startsWith(o))) return campo;
  return null;
}

/** Celda → texto. Las fechas o números raros se convierten a texto tal cual. */
const celda = (v) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());

/**
 * Lee un archivo .xlsx o .csv y devuelve las filas con los campos reconocidos.
 * Busca la fila de encabezados en las primeras 10 (por si el archivo trae un título arriba).
 */
export async function leerArchivoEmpleados(archivo) {
  const nombre = archivo.name.toLowerCase();
  let filas;
  if (nombre.endsWith('.csv') || nombre.endsWith('.txt')) {
    filas = parsearCsv(await archivo.text());
  } else if (nombre.endsWith('.xlsx')) {
    const hojas = await readXlsxFile(archivo);
    const hoja = hojas.find((h) => normal(h.sheet) === 'empleados') ?? hojas[0];
    filas = hoja?.data ?? [];
  } else if (nombre.endsWith('.xls')) {
    throw new Error('Ese es el formato viejo de Excel (.xls). Ábrelo en Excel y guárdalo como .xlsx o .csv.');
  } else {
    throw new Error('Sube un archivo .xlsx o .csv');
  }

  let inicio = -1;
  let mapa = null;
  for (let i = 0; i < Math.min(filas.length, 10); i++) {
    const m = (filas[i] ?? []).map(campoDe);
    if (m.includes('numero') && m.includes('nombre')) { inicio = i; mapa = m; break; }
  }
  if (inicio < 0) {
    throw new Error('No encontramos las columnas "Número" y "Nombre". Usa la plantilla o revisa que los encabezados estén en la primera fila.');
  }

  const columnas = [...new Set(mapa.filter(Boolean))];
  const datos = [];
  for (let i = inicio + 1; i < filas.length; i++) {
    const fila = filas[i] ?? [];
    if (fila.every((c) => celda(c) === '')) continue; // renglones vacíos
    const obj = { fila: i + 1 };
    mapa.forEach((campo, j) => { if (campo && obj[campo] === undefined) obj[campo] = celda(fila[j]); });
    datos.push(obj);
  }
  return { filas: datos, columnas };
}

/** CSV con comillas; detecta coma o punto y coma (Excel en español suele usar ;). */
export function parsearCsv(texto) {
  texto = texto.replace(/^﻿/, '');
  const primera = texto.split(/\r?\n/, 1)[0] ?? '';
  const sep = (primera.match(/;/g)?.length ?? 0) > (primera.match(/,/g)?.length ?? 0) ? ';' : ',';
  const filas = [];
  let fila = [];
  let campo = '';
  let comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === sep) { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo); filas.push(fila); fila = []; campo = '';
    } else campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

// ---------- Descargas ----------

const titulo = (value) => ({ value, fontWeight: 'bold', backgroundColor: '#123D33', textColor: '#FFFFFF' });
// Formato "@" = texto en Excel: así "005" no se convierte en 5 al escribirlo.
const txt = (value) => ({ value: value ?? '', type: String, format: '@' });

export async function descargarPlantilla() {
  const encabezados = ['Número', 'Nombre', 'Puesto', 'Teléfono', 'Modalidad', 'Jornada', 'PIN'];
  const ejemplos = [
    ['005', 'Laura Méndez Ruiz', 'Guardia', '55 1234 5678', 'Campo', 'Diurna', ''],
    ['006', 'Carlos Ortiz Peña', 'Almacenista', '5598765432', 'Presencial', 'Nocturna', ''],
    ['007', 'Sofía Herrera Gil', 'Analista', '+52 33 1111 2222', 'Home office', 'Diurna', ''],
  ];
  const instrucciones = [
    [titulo('Cómo llenar la plantilla')],
    ['1. Una fila por trabajador, en la hoja "Empleados". Borra las filas de ejemplo.'],
    ['2. Obligatorios: Número, Nombre y Modalidad.'],
    ['3. Modalidad: Presencial (oficina, planta, tienda), Campo (guardias, choferes, técnicos) o Home office.'],
    ['4. Jornada: Diurna (8 h), Nocturna (7 h) o Mixta (7.5 h). Si la dejas vacía se toma Diurna.'],
    ['5. Teléfono: celular a 10 dígitos. Ahí le llegan por WhatsApp el convenio y su resumen semanal para firmar.'],
    ['6. PIN: 4 dígitos para el kiosco. Déjalo vacío y el sistema genera uno distinto para cada quien.'],
    ['7. Si un número de empleado ya existe, se actualizan sus datos (su PIN no cambia).'],
    ['8. Para que no se pierdan los ceros a la izquierda (005), las columnas Número y PIN de esta plantilla ya son de texto.'],
  ];
  await writeXlsxFile([
    {
      sheet: 'Empleados',
      data: [encabezados.map(titulo), ...ejemplos.map((f) => f.map(txt)), ...Array.from({ length: 200 }, () => [txt(''), null, null, txt(''), null, null, txt('')])],
      columns: [{ width: 12 }, { width: 32 }, { width: 20 }, { width: 18 }, { width: 16 }, { width: 12 }, { width: 8 }],
      stickyRowsCount: 1,
    },
    { sheet: 'Instrucciones', data: instrucciones, columns: [{ width: 110 }] },
  ]).toFile('plantilla-empleados.xlsx');
}

export async function descargarPines(creados, empresa = '') {
  await writeXlsxFile([
    {
      sheet: 'PINs',
      data: [
        [titulo('Número'), titulo('Nombre'), titulo('PIN')],
        ...creados.map((c) => [txt(c.numero), txt(c.nombre), txt(c.pin)]),
        [],
        [`Confidencial${empresa ? ` · ${empresa}` : ''}. Entrega a cada trabajador solo su PIN y destruye esta lista después.`],
      ],
      columns: [{ width: 12 }, { width: 34 }, { width: 10 }],
    },
  ]).toFile(`pines-empleados-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
