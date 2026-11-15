// Логика умного склада (C++). Зеркало src/controller.js: тот же алгоритм, те же числа.
#pragma once
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <math.h>

struct Parcel { uint16_t id; int16_t pos; int8_t dest; int16_t w; uint8_t mask; };
enum WhMode { WH_NORMAL = 0, WH_RUSH = 1, WH_IDLE = 2 };

class WarehouseController {
 public:
  enum { CAP = 5, MAXP = 12, STEP = 10, END = 1000 };
  int DIV[3] = {250, 500, 750};
  Parcel parcels[MAXP];
  int count = 0;
  int lanes[3], sv[3];
  int mode = WH_NORMAL;
  uint32_t tickNo = 0, rng = 0, seed = 0;
  int rejects = 0, sorted = 0, backlog = 0, nextId = 1, spawnTimer = 0, lastWeight = 0;
  int buckets[6], bucketIdx = 0;
  bool estop = false, fault = false, belt = false, weightOk = true;
  int blocked = -1;
  float temp = 24, hum = 45;
  int weight = 17;
  char alarm[8];

  WarehouseController(uint32_t s = 20260101) { reset(s); }
  void reset(uint32_t s) {
    seed = s; rng = s; mode = WH_NORMAL; tickNo = 0; count = 0;
    for (int i = 0; i < 3; i++) { lanes[i] = 0; sv[i] = 0; }
    for (int i = 0; i < 6; i++) buckets[i] = 0;
    rejects = sorted = backlog = spawnTimer = lastWeight = bucketIdx = 0; nextId = 1;
    estop = fault = belt = false; weightOk = true; blocked = -1;
    temp = 24; hum = 45; weight = 17;
    strcpy(alarm, "OK");
  }
  uint32_t rand16() { rng = rng * 1664525u + 1013904223u; return rng >> 16; }
  void setInputs(int w, bool wOk, float t, float h, bool stop) {
    weightOk = wOk; weight = wOk ? w : 0; temp = t; hum = h; estop = stop;
  }
  void setMode(int m) { if (m >= 0 && m <= 2) mode = m; }
  void setFault(bool on) { fault = on; }
  void jam() { lanes[0] = CAP; }
  void clearAll() { lanes[0] = lanes[1] = lanes[2] = 0; }
  void clearLane(int i) { if (i >= 0 && i < 3) lanes[i] = 0; }
  int rate() const { int s = 0; for (int i = 0; i < 6; i++) s += buckets[i]; return s; }
  bool canSpawn() const {
    if (count >= MAXP) return false;
    for (int i = 0; i < count; i++) if (parcels[i].pos < 100) return false;
    return true;
  }
  void spawn() {
    uint32_t r1 = rand16(), r2 = rand16();
    bool bad = fault || !weightOk;
    int w, dest;
    if (bad) { w = -1; dest = 3; }
    else { w = weight + (int)(r2 % 5); dest = w > 40 ? 3 : (int)(r1 % 3); }
    lastWeight = w;
    Parcel p; p.id = nextId++; p.pos = 0; p.dest = dest; p.w = w; p.mask = 0;
    parcels[count++] = p;
  }
  void move() {
    Parcel kept[MAXP]; int k = 0; bool stop = false;
    for (int n = 0; n < count; n++) {
      Parcel p = parcels[n];
      if (stop) { kept[k++] = p; continue; }
      p.pos += STEP;
      bool removed = false;
      for (int i = 0; i < 3 && !removed && !stop; i++) {
        if (p.mask & (1 << i)) continue;
        if (p.pos >= DIV[i]) {
          if (p.dest == i) {
            if (lanes[i] < CAP) { lanes[i]++; sv[i] = 6; sorted++; buckets[bucketIdx]++; removed = true; }
            else { p.pos = DIV[i]; blocked = i; stop = true; }
          } else p.mask |= (1 << i);
        }
      }
      if (removed) continue;
      if (!stop && p.pos >= END) { rejects++; continue; }
      kept[k++] = p;
    }
    for (int i = 0; i < k; i++) parcels[i] = kept[i];
    count = k;
  }
  void tick() {
    tickNo++;
    if (tickNo % 100 == 0) { bucketIdx = (bucketIdx + 1) % 6; buckets[bucketIdx] = 0; }
    for (int i = 0; i < 3; i++) if (sv[i] > 0) sv[i]--;
    int interval = mode == WH_RUSH ? 15 : mode == WH_IDLE ? 0 : 40;
    if (interval > 0 && !estop) {
      spawnTimer++;
      if (spawnTimer >= interval) {
        spawnTimer = 0;
        if (canSpawn()) spawn(); else backlog++;
      }
    }
    if (blocked >= 0 && lanes[blocked] < CAP) blocked = -1;
    belt = !estop && blocked < 0 && (count > 0 || mode != WH_IDLE);
    if (belt) { move(); if (blocked >= 0) belt = false; }
    if (estop) strcpy(alarm, "ESTOP");
    else if (blocked >= 0) { strcpy(alarm, "FULL:A"); alarm[5] = 'A' + blocked; }
    else if (fault || !weightOk) strcpy(alarm, "FAULT");
    else if (temp >= 30) strcpy(alarm, "HOT");
    else strcpy(alarm, "OK");
  }
  // Тот же формат, что и trace() в controller.js.
  int trace(char* out, size_t len) const {
    int n = snprintf(out, len, "%u|%d|%s|%d,%d,%d|%d|%d|%d|%d|%d,%d,%d|", (unsigned)tickNo, belt ? 1 : 0, alarm,
                     lanes[0], lanes[1], lanes[2], rejects, sorted, rate(), backlog, sv[0], sv[1], sv[2]);
    for (int i = 0; i < count && n < (int)len - 40; i++)
      n += snprintf(out + n, len - n, "%s%d:%d:%d:%d", i ? ";" : "", parcels[i].id, parcels[i].pos, parcels[i].dest, parcels[i].w);
    return n;
  }
};
