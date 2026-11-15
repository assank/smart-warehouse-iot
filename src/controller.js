// Логика умного склада. Один и тот же алгоритм работает на ESP32 (Controller.h) и в браузере (демо-режим).
// Шаг симуляции = 100 мс. Позиция на ленте 0..1000, скорость 10 единиц за шаг (100 ед/с).
export class WarehouseController {
  constructor(seed = 20260101) { this.reset(seed); }
  reset(seed = this.seed) {
    this.CAP = 5; this.DIV = [250, 500, 750]; this.END = 1000; this.STEP = 10; this.MAXP = 12;
    this.seed = seed >>> 0; this.rng = this.seed;
    this.mode = 'normal'; this.tickNo = 0; this.parcels = [];
    this.lanes = [0, 0, 0]; this.sv = [0, 0, 0];
    this.rejects = 0; this.sorted = 0; this.backlog = 0; this.nextId = 1; this.spawnTimer = 0; this.lastWeight = 0;
    this.buckets = [0, 0, 0, 0, 0, 0]; this.bucketIdx = 0;
    this.estop = false; this.fault = false; this.blocked = -1; this.belt = false;
    this.temp = 24; this.hum = 45; this.weight = 17; this.weightOk = true; this.alarm = 'OK';
  }
  rand() { this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0; return this.rng >>> 16; }
  setInputs({ weight, temp, hum, estop }) {
    this.weightOk = Number.isFinite(weight);
    this.weight = this.weightOk ? Math.round(weight) : 0;
    this.temp = temp; this.hum = hum; this.estop = !!estop;
  }
  setMode(m) { if (m === 'normal' || m === 'rush' || m === 'idle') this.mode = m; }
  setFault(on) { this.fault = !!on; }
  jam() { this.lanes[0] = this.CAP; }
  clearAll() { this.lanes = [0, 0, 0]; }
  clearLane(i) { if (i >= 0 && i < 3) this.lanes[i] = 0; }
  get rate() { return this.buckets.reduce((a, b) => a + b, 0); }
  canSpawn() { return this.parcels.length < this.MAXP && !this.parcels.some(p => p.pos < 100); }
  spawn() {
    const r1 = this.rand(), r2 = this.rand();
    const bad = this.fault || !this.weightOk;
    let w, dest;
    if (bad) { w = -1; dest = 3; }
    else { w = this.weight + (r2 % 5); dest = w > 40 ? 3 : r1 % 3; }
    this.lastWeight = w;
    this.parcels.push({ id: this.nextId++, pos: 0, dest, w, mask: 0 });
  }
  move() {
    const kept = []; let stop = false;
    for (const p of this.parcels) {
      if (stop) { kept.push(p); continue; }
      p.pos += this.STEP;
      let removed = false;
      for (let i = 0; i < 3 && !removed && !stop; i++) {
        if (p.mask & (1 << i)) continue;
        if (p.pos >= this.DIV[i]) {
          if (p.dest === i) {
            if (this.lanes[i] < this.CAP) { this.lanes[i]++; this.sv[i] = 6; this.sorted++; this.buckets[this.bucketIdx]++; removed = true; }
            else { p.pos = this.DIV[i]; this.blocked = i; stop = true; }
          } else p.mask |= (1 << i);
        }
      }
      if (removed) continue;
      if (!stop && p.pos >= this.END) { this.rejects++; continue; }
      kept.push(p);
    }
    this.parcels = kept;
  }
  tick() {
    this.tickNo++;
    if (this.tickNo % 100 === 0) { this.bucketIdx = (this.bucketIdx + 1) % 6; this.buckets[this.bucketIdx] = 0; }
    for (let i = 0; i < 3; i++) if (this.sv[i] > 0) this.sv[i]--;
    const interval = this.mode === 'rush' ? 15 : this.mode === 'idle' ? 0 : 40;
    if (interval > 0 && !this.estop) {
      this.spawnTimer++;
      if (this.spawnTimer >= interval) {
        this.spawnTimer = 0;
        if (this.canSpawn()) this.spawn(); else this.backlog++;
      }
    }
    if (this.blocked >= 0 && this.lanes[this.blocked] < this.CAP) this.blocked = -1;
    this.belt = !this.estop && this.blocked < 0 && (this.parcels.length > 0 || this.mode !== 'idle');
    if (this.belt) { this.move(); if (this.blocked >= 0) this.belt = false; }
    if (this.estop) this.alarm = 'ESTOP';
    else if (this.blocked >= 0) this.alarm = 'FULL:' + 'ABC'[this.blocked];
    else if (this.fault || !this.weightOk) this.alarm = 'FAULT';
    else if (this.temp >= 30) this.alarm = 'HOT';
    else this.alarm = 'OK';
  }
  snapshot() {
    return {
      mode: this.mode, belt: this.belt ? 1 : 0, estop: this.estop ? 1 : 0, alarm: this.alarm,
      t: this.temp, h: this.hum, w: this.lastWeight, lanes: [...this.lanes], cap: this.CAP,
      rej: this.rejects, sorted: this.sorted, rate: this.rate, back: this.backlog, sv: this.sv.map(v => v > 0 ? 1 : 0),
      p: this.parcels.map(p => [p.id, p.pos, p.dest, p.w])
    };
  }
  trace() {
    return `${this.tickNo}|${this.belt ? 1 : 0}|${this.alarm}|${this.lanes.join(',')}|${this.rejects}|${this.sorted}|${this.rate}|${this.backlog}|${this.sv.join(',')}|${this.parcels.map(p => `${p.id}:${p.pos}:${p.dest}:${p.w}`).join(';')}`;
  }
}
