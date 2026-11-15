import { WarehouseController } from '../src/controller.js';
import assert from 'node:assert/strict';
const c = new WarehouseController(7);
const lines = [];
let inp = { weight: 17, temp: 24, hum: 45, estop: false };
const seen = new Set();
for (let t = 1; t <= 1700; t++) {
  if (t === 300) c.setMode('rush');
  if (t === 600) c.jam();
  if (t === 900) c.clearAll();
  if (t === 1000) c.setMode('normal');
  if (t === 1100) inp = { ...inp, estop: true };
  if (t === 1150) inp = { ...inp, estop: false };
  if (t === 1190 || t === 1390) c.clearAll();
  if (t === 1200) inp = { ...inp, temp: 33 };
  if (t === 1300) c.setFault(true);
  if (t === 1350) c.setFault(false);
  if (t === 1400) inp = { ...inp, temp: 24, weight: 45 };
  if (t === 1500) inp = { ...inp, weight: 17 };
  if (t === 1600) inp = { ...inp, weight: NaN };
  c.setInputs(inp); c.tick(); seen.add(c.alarm);
  if (t % 10 === 0) lines.push(c.trace());
}
if (process.argv[2] === 'trace') { console.log(lines.join('\n')); process.exit(0); }
for (const a of ['OK', 'FULL:A', 'ESTOP', 'HOT', 'FAULT']) assert.ok(seen.has(a), 'alarm ' + a);
assert.ok(c.sorted > 20, 'sorted');
assert.ok(c.rejects > 0, 'rejects (перегруз и сбой)');
assert.ok(c.lanes.every(v => v >= 0 && v <= c.CAP), 'lane bounds');
// Затор: полный лоток A останавливает ленту, освобождение запускает снова.
const d = new WarehouseController(1); d.setInputs({ weight: 17, temp: 24, hum: 45, estop: false }); d.jam();
let blocked = false; for (let i = 0; i < 1200; i++) { d.tick(); if (d.alarm === 'FULL:A') { blocked = true; break; } }
assert.ok(blocked, 'затор должен возникнуть'); assert.equal(d.belt, false);
d.clearLane(0); d.tick(); assert.equal(d.belt, true); assert.notEqual(d.alarm, 'FULL:A');
// Аварийный стоп замораживает ленту и производство посылок.
const e = new WarehouseController(2); e.setInputs({ weight: 17, temp: 24, hum: 45, estop: true });
for (let i = 0; i < 200; i++) e.tick(); assert.equal(e.parcels.length, 0); assert.equal(e.alarm, 'ESTOP');
// Перегруз и неисправность датчика уходят в брак.
const f = new WarehouseController(3); f.setInputs({ weight: 45, temp: 24, hum: 45, estop: false });
for (let i = 0; i < 2500; i++) f.tick(); assert.equal(f.sorted, 0); assert.ok(f.rejects > 0);
console.log('JS controller: все проверки пройдены, sorted=%d rej=%d', c.sorted, c.rejects);
