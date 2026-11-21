import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calcularJornadas, calcularSemana, checadasEfectivas, inicioDelDiaLocal, lugarDe, lunesDe, reglaDelAnio, alertasSemana,
} from '../src/lib/jornada.js';

const Z = 'America/Mexico_City';
const en = (fecha, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(inicioDelDiaLocal(fecha, Z).getTime() + (h * 60 + m) * 60000);
};
let n = 0;
const ch = (fecha, tipo, hhmm) => ({ id: ++n, tipo, hora: en(fecha, hhmm) });

test('tope por año y años fuera de rango', () => {
  assert.equal(reglaDelAnio(2027).topeSemanal, 46);
  assert.equal(reglaDelAnio(2030).extraMaxSemanal, 12);
  assert.equal(reglaDelAnio(2035).topeSemanal, 40);
  assert.equal(reglaDelAnio(2025).topeSemanal, 48);
});

test('lunes de la semana', () => {
  assert.equal(lunesDe('2026-11-19'), '2026-11-16'); // jueves
  assert.equal(lunesDe('2026-11-22'), '2026-11-16'); // domingo
  assert.equal(lunesDe('2026-11-16'), '2026-11-16');
});

test('inicio del día local en Ciudad de México (UTC-6)', () => {
  assert.equal(inicioDelDiaLocal('2027-01-04', Z).toISOString(), '2027-01-04T06:00:00.000Z');
});

test('jornada con comida descuenta la pausa', () => {
  const { jornadas } = calcularJornadas([
    ch('2027-01-04', 'entrada', '08:00'),
    ch('2027-01-04', 'salida_comida', '13:00'),
    ch('2027-01-04', 'regreso_comida', '14:00'),
    ch('2027-01-04', 'salida', '17:00'),
  ], Z);
  assert.equal(jornadas.length, 1);
  assert.equal(jornadas[0].minutosTrabajados, 8 * 60);
  assert.equal(jornadas[0].minutosComida, 60);
  assert.equal(jornadas[0].incompleta, false);
});

test('turno nocturno que cruza la medianoche cuenta para el día de entrada', () => {
  const { jornadas } = calcularJornadas([
    ch('2027-01-04', 'entrada', '22:00'),
    ch('2027-01-05', 'salida', '05:00'),
  ], Z);
  assert.equal(jornadas[0].fecha, '2027-01-04');
  assert.equal(jornadas[0].minutosTrabajados, 7 * 60);
});

test('salida olvidada: la jornada queda incompleta, nunca se cierra sola', () => {
  const { jornadas } = calcularJornadas([
    ch('2027-01-04', 'entrada', '08:00'),
    ch('2027-01-05', 'entrada', '08:00'),
    ch('2027-01-05', 'salida', '16:00'),
  ], Z);
  assert.equal(jornadas.length, 2);
  assert.equal(jornadas[0].incompleta, true);
  assert.equal(jornadas[0].minutosTrabajados, 0);
  assert.deepEqual(jornadas[0].incidencias, ['entrada_sin_salida']);
  assert.equal(jornadas[1].minutosTrabajados, 8 * 60);
});

test('2027: seis días de 8 h = 48 h → 46 ordinarias y 2 extra dobles', () => {
  const jornadas = Array.from({ length: 6 }, () => ({ minutosTrabajados: 480, incompleta: false }));
  const s = calcularSemana(jornadas, { anio: 2027 });
  assert.equal(s.total, 48);
  assert.equal(s.ordinarias, 46);
  assert.equal(s.extraDobles, 2);
  assert.equal(s.extraTriples, 0);
});

test('guardia 12x12: cuatro turnos de 12 h → 32 ordinarias, 9 dobles, 7 triples', () => {
  const jornadas = Array.from({ length: 4 }, () => ({ minutosTrabajados: 720, incompleta: false }));
  const s = calcularSemana(jornadas, { anio: 2027 });
  assert.equal(s.ordinarias, 32);
  assert.equal(s.extraDobles, 9);
  assert.equal(s.extraTriples, 7);
  assert.ok(alertasSemana(s, 'Pedro').some((a) => a.codigo === 'extra_triple'));
});

test('2030: tope de 40 h y 12 h extra', () => {
  const jornadas = Array.from({ length: 6 }, () => ({ minutosTrabajados: 480, incompleta: false }));
  const s = calcularSemana(jornadas, { anio: 2030 });
  assert.equal(s.ordinarias, 40);
  assert.equal(s.extraDobles, 8);
});

test('jornada nocturna: 7 h diarias ordinarias', () => {
  const s = calcularSemana([{ minutosTrabajados: 480, incompleta: false }], { anio: 2027, tipoJornada: 'nocturna' });
  assert.equal(s.ordinarias, 7);
  assert.equal(s.extraDobles, 1);
});

test('híbrido: día mixto (mañana en casa, tarde en oficina) reparte las horas por lugar', () => {
  const lugar = (l) => (c) => ({ ...c, lugar: l });
  const { jornadas } = calcularJornadas([
    lugar('casa')(ch('2027-01-04', 'entrada', '08:30')),
    lugar('casa')(ch('2027-01-04', 'salida_comida', '12:30')),
    lugar('oficina')(ch('2027-01-04', 'regreso_comida', '14:00')),
    lugar('oficina')(ch('2027-01-04', 'salida', '18:00')),
  ], Z);
  assert.deepEqual(jornadas[0].minutosPorLugar, { casa: 240, oficina: 240 });
  const s = calcularSemana(jornadas, { anio: 2027 });
  assert.equal(s.porcentajeRemoto, 50);
  assert.deepEqual(s.diasPorLugar, { mixto: 1 });
});

test('híbrido: 3 días en casa y 2 en oficina = 60% remoto (supera el 40% de la NOM-037)', () => {
  const dia = (l) => ({ minutosTrabajados: 480, minutosPorLugar: { [l]: 480 }, incompleta: false });
  const s = calcularSemana([dia('oficina'), dia('casa'), dia('casa'), dia('oficina'), dia('casa')], { anio: 2027 });
  assert.equal(s.porcentajeRemoto, 60);
  assert.deepEqual(s.diasPorLugar, { oficina: 2, remoto: 3 });
  assert.equal(lugarDe({ datos: { origen: 'kiosco' } }), 'oficina');
  assert.equal(lugarDe({ datos: { origen: 'web' } }), 'casa');
  assert.equal(lugarDe({ datos: { origen: 'app' } }), 'campo', 'el trabajo de campo no es teletrabajo');
});

test('una corrección aprobada reemplaza al original sin borrarlo', () => {
  const eventos = [
    { id: 1, clase: 'checada', hora: en('2027-01-04', '08:12'), datos: { tipo: 'entrada', origen: 'kiosco' } },
    { id: 2, clase: 'checada', hora: en('2027-01-04', '17:00'), datos: { tipo: 'salida', origen: 'kiosco' } },
    { id: 3, clase: 'correccion_aprobada', hora: en('2027-01-04', '08:00'), datos: { tipo: 'entrada', reemplaza: 1 } },
  ];
  const efectivas = checadasEfectivas(eventos);
  assert.deepEqual(efectivas.map((c) => c.id), [3, 2]);
  assert.equal(efectivas[0].corregida, true);
});
