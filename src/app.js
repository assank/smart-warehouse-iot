// Умный склад: 3D-интерфейс, демо-режим и связь с ESP32 по MQTT.
const DEVICE = 'sw-3f9a2c71';
const TOPIC_STATE = 'smartwarehouse/sw-3f9a2c71/state', TOPIC_COMMAND = 'smartwarehouse/sw-3f9a2c71/command';
const $ = id => document.getElementById(id);
const LANES = ['A', 'B', 'C'];
const LANE_COLOR = ['#3b82f6', '#f59e0b', '#22a559'];
const posToX = p => -8 + p * 0.016;
const DIV_POS = [250, 500, 750];
const DIVX = DIV_POS.map(posToX);
const BELT_TOP = 0.99;
const MODE_RU = { normal: 'обычный поток', rush: 'час пик', idle: 'пауза' };

// ---------- Состояние ----------
const demo = new WarehouseController((Date.now() & 0xffff) + 1);
const input = { weight: 17, temp: 24, hum: 45 };
let mode = 'demo', client = null, connected = false, estopDemo = false;
let state = demo.snapshot(), stateAt = performance.now(), lastSeen = 0, prevState = null, lastDomUpdate = 0;
const rateHistory = [];

function alarmText(a) {
  if (a === 'OK') return 'Работа в штатном режиме.';
  if (a === 'ESTOP') return 'Аварийный стоп: лента остановлена, приём посылок закрыт.';
  if (a === 'FAULT') return 'Сбой датчика веса: посылки уходят в брак.';
  if (a === 'HOT') return 'В складе жарче 30 °C. Лента работает, нужна вентиляция.';
  if (a.startsWith('FULL:')) return 'Лоток ' + a.slice(5) + ' полон. Лента остановлена, освободите лоток.';
  return a;
}
const alarmTone = a => a === 'OK' ? 'ok' : a === 'HOT' ? 'warn' : 'bad';

function addLog(text, tone = 'info') {
  const ul = $('log'), li = document.createElement('li');
  const d = new Date(), t = d.toTimeString().slice(0, 8);
  li.dataset.tone = tone;
  li.innerHTML = '<time></time><span></span>';
  li.firstChild.textContent = t; li.lastChild.textContent = text;
  ul.prepend(li);
  while (ul.children.length > 7) ul.lastChild.remove();
}
function diffEvents(a, b) {
  if (!a) return;
  for (let i = 0; i < 3; i++) {
    if (b.lanes[i] > a.lanes[i]) addLog(`Посылка → лоток ${LANES[i]} (${b.lanes[i]}/${b.cap})`, 'ok');
    else if (b.lanes[i] < a.lanes[i]) addLog(`Лоток ${LANES[i]} освобождён`, 'info');
  }
  if (b.rej > a.rej) addLog('Посылка ушла в брак: перегруз или нет веса', 'warn');
  if (b.alarm !== a.alarm) addLog(alarmText(b.alarm), alarmTone(b.alarm));
  if (b.mode !== a.mode) addLog('Режим: ' + (MODE_RU[b.mode] || b.mode), 'info');
}
function pushState(s) {
  diffEvents(prevState, s);
  prevState = s; state = s; stateAt = performance.now();
  const now = performance.now();
  if (now - lastDomUpdate > 200) { lastDomUpdate = now; updateDom(); }
}

// ---------- Демо-контроллер ----------
setInterval(() => {
  if (mode !== 'demo') return;
  demo.setInputs({ weight: input.weight, temp: input.temp, hum: input.hum, estop: estopDemo });
  demo.tick();
  pushState(demo.snapshot());
}, 100);
setInterval(() => {
  const now = performance.now();
  rateHistory.push({ at: now, v: state.rate });
  while (rateHistory.length && now - rateHistory[0].at > 120000) rateHistory.shift();
  drawChart();
}, 1000);

function sendCommand(cmd) {
  if (mode === 'live') { if (client && client.connected) client.publish(TOPIC_COMMAND, cmd); return; }
  switch (cmd) {
    case 'normal': case 'rush': case 'idle': demo.setMode(cmd); break;
    case 'jam': demo.jam(); break;
    case 'clear': demo.clearAll(); break;
    case 'clra': demo.clearLane(0); break;
    case 'clrb': demo.clearLane(1); break;
    case 'clrc': demo.clearLane(2); break;
    case 'fault': demo.setFault(true); break;
    case 'fixed': demo.setFault(false); break;
    case 'estop': estopDemo = true; break;
    case 'release': estopDemo = false; break;
  }
}
function toggleEstop() { sendCommand(state.estop ? 'release' : 'estop'); }
function toggleFault() { sendCommand(state.alarm === 'FAULT' ? 'fixed' : 'fault'); }

// ---------- Панель ----------
function updateDom() {
  const s = state;
  $('k-sorted').textContent = s.sorted; $('k-rate').textContent = s.rate; $('k-rej').textContent = s.rej; $('k-back').textContent = s.back;
  $('k-temp').textContent = Number(s.t).toFixed(0); $('k-weight').textContent = s.w < 0 ? '—' : s.w;
  for (let i = 0; i < 3; i++) { $('bar-' + i).style.width = (s.lanes[i] / s.cap * 100) + '%'; $('out-' + i).textContent = s.lanes[i] + '/' + s.cap; }
  const st = $('status'); st.textContent = alarmText(s.alarm); st.dataset.tone = alarmTone(s.alarm);
  for (const b of document.querySelectorAll('#scenarios [data-cmd]')) {
    const c = b.dataset.cmd;
    if (c === 'normal' || c === 'rush' || c === 'idle') b.setAttribute('aria-pressed', String(s.mode === c));
  }
  $('estop-btn').setAttribute('aria-pressed', String(!!s.estop));
  $('estop-btn').textContent = s.estop ? 'Снять аварийный стоп' : 'Аварийный стоп';
  $('fault-btn').setAttribute('aria-pressed', String(s.alarm === 'FAULT'));
  $('fault-btn').textContent = s.alarm === 'FAULT' ? 'Датчик веса исправен' : 'Сбой датчика веса';
  const bn = $('banner');
  if (s.alarm === 'OK') bn.dataset.show = 'false';
  else { bn.dataset.show = 'true'; bn.dataset.tone = s.alarm === 'HOT' ? 'warn' : 'bad'; bn.textContent = alarmText(s.alarm); }
}
for (const b of document.querySelectorAll('#scenarios [data-cmd]')) {
  b.addEventListener('click', () => {
    const c = b.dataset.cmd;
    if (c === 'estop') toggleEstop(); else if (c === 'fault') toggleFault(); else sendCommand(c);
    if (mode === 'demo') updateDom();
  });
}
$('in-weight').addEventListener('input', e => { input.weight = +e.target.value; $('out-weight').textContent = input.weight + ' кг'; });
$('in-temp').addEventListener('input', e => { input.temp = +e.target.value; $('out-temp').textContent = input.temp + ' °C'; });
function setLive(on) { $('in-weight').disabled = on; $('in-temp').disabled = on; }
function setChip(stateName, text) { $('conn-chip').dataset.state = stateName; $('conn-text').textContent = text; }

function drawChart() {
  const cv = $('chart'); if (!cv) return;
  const dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const x0 = 34, x1 = w - 12, y0 = 12, y1 = h - 22, now = performance.now();
  const max = Math.max(8, ...rateHistory.map(p => p.v)) * 1.15;
  ctx.font = '11px system-ui'; ctx.fillStyle = css.getPropertyValue('--muted'); ctx.strokeStyle = css.getPropertyValue('--line'); ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) { const y = y1 - (y1 - y0) * i / 3; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText(Math.round(max * i / 3), x0 - 6, y + 4); }
  ctx.textAlign = 'left'; ctx.fillText('−2 мин', x0, h - 6); ctx.textAlign = 'right'; ctx.fillText('сейчас', x1, h - 6);
  if (rateHistory.length < 2) return;
  const X = p => x0 + (1 - (now - p.at) / 120000) * (x1 - x0), Y = p => y1 - p.v / max * (y1 - y0);
  ctx.beginPath(); ctx.moveTo(X(rateHistory[0]), y1);
  for (const p of rateHistory) ctx.lineTo(X(p), Y(p));
  ctx.lineTo(X(rateHistory[rateHistory.length - 1]), y1); ctx.closePath(); ctx.fillStyle = 'rgba(226,118,27,.15)'; ctx.fill();
  ctx.beginPath(); rateHistory.forEach((p, i) => i ? ctx.lineTo(X(p), Y(p)) : ctx.moveTo(X(p), Y(p)));
  ctx.strokeStyle = css.getPropertyValue('--accent'); ctx.lineWidth = 2; ctx.stroke();
}

// ---------- MQTT ----------
function validState(s) {
  return s && s.d === DEVICE && Array.isArray(s.p) && Array.isArray(s.lanes) && s.lanes.length === 3 && Array.isArray(s.sv) &&
    ['sorted', 'rej', 'rate', 'back', 'cap', 'up'].every(k => Number.isFinite(s[k])) && typeof s.alarm === 'string';
}
$('connect').addEventListener('click', () => {
  if (client) return;
  mode = 'live'; connected = false; lastSeen = 0; prevState = null; setLive(true); resetDynamic();
  $('connect').hidden = true; $('disconnect').hidden = false;
  setChip('wait', 'Подключаемся…'); $('conn-note').textContent = 'Подключаемся к брокеру MQTT…';
  client = mqtt.connect('wss://broker.hivemq.com:8884/mqtt', { clientId: DEVICE + '-ui-' + Math.random().toString(16).slice(2, 10), connectTimeout: 30000, reconnectPeriod: 5000, clean: true });
  client.on('connect', () => { connected = true; client.subscribe(TOPIC_STATE); setChip('wait', 'Ждём ESP32…'); $('conn-note').textContent = 'Брокер подключён. Запустите ▶ в Wokwi и дождитесь Wi-Fi.'; });
  client.on('message', (topic, buffer) => {
    if (topic !== TOPIC_STATE) return;
    try {
      const s = JSON.parse(buffer.toString());
      if (!validState(s)) return;
      lastSeen = performance.now();
      setChip('live', 'ESP32 / Wokwi'); $('conn-note').textContent = 'Получаем состояние платы каждые 0,5 с. Ползунки отключены: датчики читает плата.';
      pushState(s); updateDom();
    } catch { $('conn-note').textContent = 'Получен некорректный пакет. Ждём следующий.'; }
  });
  client.on('error', () => { setChip('wait', 'Брокер недоступен'); $('conn-note').textContent = 'Брокер недоступен. Проверьте интернет или вернитесь в демо.'; });
  client.on('offline', () => { connected = false; setChip('wait', 'Нет связи'); });
});
$('disconnect').addEventListener('click', () => {
  if (client) client.end(true); client = null; connected = false; mode = 'demo'; lastSeen = 0; prevState = null; setLive(false); resetDynamic();
  $('connect').hidden = false; $('disconnect').hidden = true; setChip('demo', 'Демо в браузере');
  $('conn-note').textContent = 'Сейчас работает встроенная копия логики в браузере. Чтобы увидеть настоящую плату, запустите проект в Wokwi и нажмите «Подключить Wokwi».';
  pushState(demo.snapshot()); updateDom();
});
setInterval(() => {
  if (mode === 'live' && lastSeen && performance.now() - lastSeen > 3500) { setChip('wait', 'Данные устарели'); $('conn-note').textContent = 'Плата давно не присылала данные. Проверьте, что симуляция в Wokwi запущена.'; }
}, 1000);

for (const [id, key, name] of [['copy-sketch', 'sketch', 'sketch.ino'], ['copy-diagram', 'diagram', 'diagram.json'], ['copy-libraries', 'libraries', 'libraries.txt']]) {
  $(id).addEventListener('click', () => { $('transfer-panel').hidden = false; $('transfer').value = FILES[key]; $('transfer').dataset.name = name; $('copy-status').textContent = 'Файл ' + name + ' показан ниже.'; });
}
$('copy-now').addEventListener('click', async () => {
  const ta = $('transfer'); ta.select();
  try { await navigator.clipboard.writeText(ta.value); $('copy-status').textContent = 'Скопировано: ' + (ta.dataset.name || 'файл'); }
  catch { $('copy-status').textContent = 'Выделено. Нажмите Ctrl/Cmd+C.'; }
});

// ---------- 3D ----------
let scene, camera, renderer, controls, clock;
let parcelMeshes = new Map(), ghosts = [], laneBoxes = [[], [], []], rejectBoxes = [], diverters = [], labels = [];
let beltTex, beacon, beaconLight, screenTex, screenCtx, estopBtn, hitMeshes = [], laneStrips = [];
let camTween = null, lastScreenDraw = 0;
const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: .72, metalness: .08, ...o });

function resetDynamic() {
  if (!scene) return;
  for (const m of parcelMeshes.values()) scene.remove(m.group);
  parcelMeshes.clear();
  for (const g of ghosts) scene.remove(g.group);
  ghosts = [];
}
function makeParcel(dest, w) {
  const g = new THREE.Group();
  const h = w < 0 ? .4 : .32 + Math.min(w, 50) / 50 * .38;
  const body = new THREE.Mesh(new THREE.BoxGeometry(.62, h, .62), M('#c9a36b', { roughness: .9 }));
  body.castShadow = true; body.receiveShadow = true; body.position.y = h / 2; g.add(body);
  const tapeColor = dest === 3 ? '#b4352c' : LANE_COLOR[dest];
  const tape = new THREE.Mesh(new THREE.BoxGeometry(.2, .012, .64), M(tapeColor, { roughness: .5 }));
  tape.position.y = h + .003; g.add(tape);
  const tape2 = new THREE.Mesh(new THREE.BoxGeometry(.2, h + .01, .636), M(tapeColor, { roughness: .5 }));
  tape2.position.y = h / 2; g.add(tape2);
  g.userData.h = h;
  return g;
}
function labelSprite(text, color, w = 2.2, h = 1) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 116;
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(w, h, 1);
  sp.userData = { cv, tex, color, text: '', draw(t, c = color) {
    if (this.text === t + c) return; this.text = t + c;
    const x = cv.getContext('2d'); x.clearRect(0, 0, 256, 116);
    x.fillStyle = 'rgba(251,250,247,.94)'; x.strokeStyle = c; x.lineWidth = 8;
    x.beginPath(); x.roundRect(6, 6, 244, 104, 20); x.fill(); x.stroke();
    x.fillStyle = '#1f2328'; x.font = '700 58px system-ui,sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(t, 128, 60);
    tex.needsUpdate = true;
  } };
  return sp;
}

function buildScene() {
  const stage = $('stage');
  scene = new THREE.Scene(); scene.background = new THREE.Color('#e9e6df'); scene.fog = new THREE.Fog('#e9e6df', 45, 110);
  camera = new THREE.PerspectiveCamera(36, 1, .1, 120); camera.position.set(0, 9.5, 17);
  try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); }
  catch (e) { stage.insertAdjacentHTML('beforeend', '<p style="padding:40px">WebGL недоступен в этом браузере. Панель справа продолжает работать.</p>'); return false; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  stage.prepend(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, .8, 2); controls.enableDamping = true; controls.dampingFactor = .07; controls.minDistance = 6; controls.maxDistance = 70; controls.maxPolarAngle = Math.PI / 2.05; controls.enablePan = false;
  scene.add(new THREE.HemisphereLight('#fff8ec', '#8f9088', 1.7));
  const sun = new THREE.DirectionalLight('#fff1dc', 2.6); sun.position.set(-8, 16, 10); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 12, bottom: -12, near: 1, far: 50 }); sun.shadow.bias = -.0004; scene.add(sun);
  clock = new THREE.Clock();
  const add = (geo, mat, x, y, z, parent = scene) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
  const B = (w, h, d, mat, x, y, z, parent) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z, parent);
  const steel = M('#8c949c', { metalness: .5, roughness: .45 }), dark = M('#30343a'), orange = M('#f08a24', { roughness: .55 }), concrete = M('#d9d5ca', { roughness: 1 });

  // Пол, стены, разметка
  const floor = add(new THREE.PlaneGeometry(60, 40), concrete, 0, 0, 3); floor.rotation.x = -Math.PI / 2; floor.castShadow = false;
  B(26, 6.4, .2, M('#cbc6ba', { roughness: 1 }), 0, 3.2, -7); B(.2, 6.4, 16, M('#cbc6ba', { roughness: 1 }), -13, 3.2, 1); B(.2, 6.4, 16, M('#cbc6ba', { roughness: 1 }), 13, 3.2, 1);
  for (const z of [-1.5, 1.5]) B(17.6, .012, .12, M('#e8c53a', { roughness: .8 }), 0, .008, z).castShadow = false;
  B(.12, .012, 3.2, M('#e8c53a'), -10.2, .008, 0).castShadow = false;
  // Стеллажи у задней стены
  const boxMats = ['#b9955f', '#c9a36b', '#a98557'].map(c => M(c, { roughness: .95 }));
  for (const rx of [-9.5, -3.2, 3.2, 9.5]) {
    for (const px of [-2.1, 2.1]) B(.1, 4.6, .8, orange, rx + px, 2.3, -5.6);
    for (let lv = 0; lv < 3; lv++) {
      B(4.4, .1, .9, steel, rx, .5 + lv * 1.4, -5.6);
      for (let k = 0; k < 4; k++) if ((k * 7 + lv * 3 + Math.round(rx)) % 5 !== 0) B(.8 + (k % 2) * .2, .6 + (k % 3) * .1, .6, boxMats[(k + lv) % 3], rx - 1.6 + k * 1.05, .85 + lv * 1.4, -5.6);
    }
  }

  // Конвейер
  const cvs = document.createElement('canvas'); cvs.width = 64; cvs.height = 64;
  const cx = cvs.getContext('2d'); cx.fillStyle = '#2d3136'; cx.fillRect(0, 0, 64, 64); cx.fillStyle = '#464c53'; cx.fillRect(0, 0, 5, 64); cx.fillStyle = '#3a4046'; cx.fillRect(5, 0, 2, 64);
  beltTex = new THREE.CanvasTexture(cvs); beltTex.wrapS = beltTex.wrapT = THREE.RepeatWrapping; beltTex.repeat.set(16, 1); beltTex.colorSpace = THREE.SRGBColorSpace;
  const beltMats = [dark, dark, new THREE.MeshStandardMaterial({ map: beltTex, roughness: .85 }), dark, dark, dark];
  const belt = new THREE.Mesh(new THREE.BoxGeometry(16, .08, 1.4), beltMats); belt.position.set(0, .95, 0); belt.receiveShadow = true; scene.add(belt);
  B(16.6, .22, 1.7, steel, 0, .74, 0);
  for (const z of [-.8, .8]) B(16.4, .14, .07, orange, 0, 1.12, z);
  for (let x = -8; x <= 8; x += 2) for (const z of [-.7, .7]) B(.14, .66, .14, steel, x, .33, z);
  for (const x of [-8.1, 8.1]) { const r = add(new THREE.CylinderGeometry(.16, .16, 1.4, 20), steel, x, .95, 0); r.rotation.x = Math.PI / 2; }
  // Вход
  B(1.7, .1, 1.5, steel, -9.05, .9, 0); B(.1, .5, 1.5, orange, -9.85, 1.15, 0);
  const inSign = labelSprite('ВХОД', '#e2761b', 1.8, .82); inSign.position.set(-9.2, 2.1, 0); scene.add(inSign); inSign.userData.draw('ВХОД');

  // Заслонки, жёлоба, лотки
  for (let i = 0; i < 3; i++) {
    const x = DIVX[i];
    const pivot = new THREE.Group(); pivot.position.set(x - .55, 1.22, -.62); scene.add(pivot);
    const arm = B(1.35, .22, .07, M(LANE_COLOR[i], { roughness: .4 }), .675, 0, 0, pivot); arm.castShadow = true;
    B(.22, .3, .22, dark, 0, 0, 0, pivot);
    diverters.push({ pivot, cur: 0 });
    const ramp = B(1.3, .06, 2.7, steel, x, .72, 2.1); ramp.rotation.x = .23;
    for (const dx of [-.67, .67]) { const w = B(.05, .22, 2.7, orange, x + dx, .83, 2.1); w.rotation.x = .23; }
    const strip = B(1.5, .04, 3.45, M(LANE_COLOR[i], { roughness: .6, emissive: LANE_COLOR[i], emissiveIntensity: 0 }), x, .02, 5.1);
    strip.material.color.set(LANE_COLOR[i]).lerp(new THREE.Color('#d9d5ca'), .72); strip.castShadow = false; laneStrips.push(strip);
    for (const dx of [-.78, .78]) B(.06, .3, 3.45, orange, x + dx, .17, 5.1);
    B(1.62, .3, .06, orange, x, .17, 6.85);
    const lab = labelSprite('', LANE_COLOR[i], 2.1, .95); lab.position.set(x, 2.15, 5.1); scene.add(lab); labels.push(lab);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.2, 3.6), new THREE.MeshBasicMaterial({ visible: false })); hit.position.set(x, .6, 5.1); hit.userData.lane = i; scene.add(hit); hitMeshes.push(hit);
    for (let k = 0; k < 5; k++) {
      const pm = makeParcel(i, 20); pm.position.set(x, .04, 3.8 + k * .62); pm.visible = false; scene.add(pm); laneBoxes[i].push(pm);
    }
  }
  // Корзина брака
  const bin = new THREE.Group(); bin.position.set(9.5, 0, 0); scene.add(bin);
  const binMat = M('#b4352c', { roughness: .6 });
  B(1.9, .08, 1.9, binMat, 0, .1, 0, bin);
  for (const [w, d, x, z] of [[1.9, .08, 0, .95], [1.9, .08, 0, -.95], [.08, 1.9, .95, 0], [.08, 1.9, -.95, 0]]) B(w, .9, d, binMat, x, .55, z, bin);
  const rejLab = labelSprite('БРАК 0', '#b4352c', 2, .9); rejLab.position.set(9.5, 2.1, 0); scene.add(rejLab); labels.push(rejLab);
  for (let k = 0; k < 8; k++) {
    const pm = makeParcel(3, 20); pm.position.set(9.5 + ((k * 37) % 5 - 2) * .22, .14 + Math.floor(k / 4) * .38, ((k * 53) % 7 - 3) * .17); pm.rotation.y = k * .7; pm.visible = false; scene.add(pm); rejectBoxes.push(pm);
  }

  // Шкаф управления, экран, аварийная кнопка, маяк
  B(1.7, 2.6, .8, M('#4a5058', { metalness: .35 }), -7.4, 1.3, -3);
  const scv = document.createElement('canvas'); scv.width = 256; scv.height = 128; screenCtx = scv.getContext('2d'); screenTex = new THREE.CanvasTexture(scv); screenTex.colorSpace = THREE.SRGBColorSpace;
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.35, .68), new THREE.MeshBasicMaterial({ map: screenTex })); scr.position.set(-7.4, 1.75, -2.59); scene.add(scr);
  B(.55, 1.2, .55, M('#f0c419', { roughness: .6 }), -5.5, .6, -1.6);
  estopBtn = add(new THREE.CylinderGeometry(.2, .24, .22, 24), M('#d12b20', { emissive: '#d12b20', emissiveIntensity: .2, roughness: .35 }), -5.5, 1.3, -1.6); estopBtn.userData.estop = true; hitMeshes.push(estopBtn);
  const esLab = labelSprite('STOP', '#d12b20', 1.1, .5); esLab.position.set(-5.5, 2.0, -1.6); scene.add(esLab); esLab.userData.draw('STOP');
  B(.1, 1.1, .1, steel, -8.3, 3.15, -3);
  beacon = add(new THREE.CylinderGeometry(.22, .22, .42, 20), new THREE.MeshStandardMaterial({ color: '#2f8f5b', emissive: '#2f8f5b', emissiveIntensity: .8, roughness: .3 }), -8.3, 3.9, -3);
  beaconLight = new THREE.PointLight('#2f8f5b', 5, 9); beaconLight.position.set(-8.3, 4.2, -2.6); scene.add(beaconLight);

  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
  const pick = e => { const r = renderer.domElement.getBoundingClientRect(); ptr.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); ray.setFromCamera(ptr, camera); return ray.intersectObjects(hitMeshes, false)[0]?.object; };
  renderer.domElement.addEventListener('pointerup', e => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return; downAt = null;
    const o = pick(e); if (!o) return;
    if (o.userData.estop) toggleEstop(); else sendCommand(['clra', 'clrb', 'clrc'][o.userData.lane]);
    if (mode === 'demo') updateDom();
  });
  renderer.domElement.addEventListener('pointermove', e => { renderer.domElement.style.cursor = pick(e) ? 'pointer' : 'grab'; });

  controls.addEventListener('start', () => { autoFit = false; camTween = null; });
  const resize = () => { const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); if (autoFit && typeof setView === 'function' && $('view-main')) setView(currentView, true); };
  new ResizeObserver(resize).observe(stage); resize();
  return true;
}

// [позиция камеры, цель, ширина сцены в метрах, которую нужно уместить в кадр]
const VIEWS = { main: [[0, 9.5, 17], [0, .8, 2], 23], top: [[0, 24, 5.5], [0, 0, 2.4], 23], lanes: [[3, 5.5, 13.5], [0, .6, 3.6], 14] };
let currentView = 'main', autoFit = true;
function viewTargets(name) {
  const [p, t, width] = VIEWS[name], P = new THREE.Vector3(...p), T = new THREE.Vector3(...t);
  const aspect = camera.aspect || 1, need = width / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * aspect);
  const k = Math.max(1, need / P.distanceTo(T));
  return { toP: T.clone().add(P.sub(T).multiplyScalar(k)), toT: T };
}
function setView(name, instant = false) {
  currentView = name; autoFit = true;
  for (const k of Object.keys(VIEWS)) $('view-' + k).setAttribute('aria-pressed', String(k === name));
  if (!camera) return;
  const { toP, toT } = viewTargets(name);
  if (instant) { camera.position.copy(toP); controls.target.copy(toT); camTween = null; return; }
  camTween = { t: 0, fromP: camera.position.clone(), fromT: controls.target.clone(), toP, toT };
}
for (const k of Object.keys(VIEWS)) $('view-' + k).addEventListener('click', () => setView(k));
$('snapshot').addEventListener('click', () => {
  if (!renderer) return; renderer.render(scene, camera);
  const a = document.createElement('a'); a.href = renderer.domElement.toDataURL('image/png'); a.download = 'smart-warehouse.png'; a.click();
});

function drawScreen(s) {
  const c = screenCtx; c.fillStyle = '#0b1220'; c.fillRect(0, 0, 256, 128);
  c.fillStyle = '#9fe3ff'; c.font = '600 17px ui-monospace,Menlo,monospace'; c.textBaseline = 'top';
  const lines = ['SMART WAREHOUSE', `${s.mode}  T:${Number(s.t).toFixed(0)}C`, `A:${s.lanes[0]} B:${s.lanes[1]} C:${s.lanes[2]} R:${s.rej}`, `Sorted:${s.sorted} ${s.rate}/min`, `Belt:${s.belt ? 'RUN' : 'STOP'} Q:${s.back}`, s.alarm + (mode === 'live' ? ' MQTT' : ' DEMO')];
  lines.forEach((t, i) => { c.fillStyle = i === 5 && s.alarm !== 'OK' ? '#ff8a80' : '#9fe3ff'; c.fillText(t, 8, 6 + i * 20); });
  screenTex.needsUpdate = true;
}

function laneSlotZ(k) { return 3.8 + k * .62; }
let wasStale = false;
function frame() {
  requestAnimationFrame(frame);
  if (!renderer) return;
  const dt = Math.min(clock.getDelta(), .1), now = performance.now(), s = state;
  const stale = mode === 'live' && (!lastSeen || now - lastSeen > 3500);
  const since = (now - stateAt) / 1000;
  const moving = !!s.belt && !stale;
  if (camTween) { camTween.t = Math.min(1, camTween.t + dt / .8); const e = 1 - Math.pow(1 - camTween.t, 3); camera.position.lerpVectors(camTween.fromP, camTween.toP, e); controls.target.lerpVectors(camTween.fromT, camTween.toT, e); if (camTween.t >= 1) camTween = null; }
  controls.update();
  if (moving) beltTex.offset.x -= 1.6 * dt;

  // Посылки на ленте
  const alive = new Set();
  for (const p of s.p) {
    const [id, pos, dest, w] = p; alive.add(id);
    let m = parcelMeshes.get(id);
    if (!m) { const g = makeParcel(dest, w); scene.add(g); m = { group: g, x: posToX(pos), born: now, dest, w, pos }; parcelMeshes.set(id, m); g.position.set(m.x, BELT_TOP, 0); }
    let dpos = pos;
    if (moving) { dpos = pos + 100 * Math.min(since, .6); if (dest < 3) dpos = Math.min(dpos, DIV_POS[dest] > pos ? DIV_POS[dest] : pos); dpos = Math.min(dpos, 1000); }
    const tx = posToX(dpos); m.x += (tx - m.x) * Math.min(1, dt * 14); m.pos = pos; m.dest = dest;
    m.group.position.set(m.x, BELT_TOP, 0);
    const sc = Math.min(1, .5 + (now - m.born) / 500); m.group.scale.setScalar(sc);
  }
  for (const [id, m] of parcelMeshes) {
    if (alive.has(id)) continue;
    parcelMeshes.delete(id);
    const toLane = m.dest < 3 && m.pos < 990;
    ghosts.push({ group: m.group, t: 0, kind: toLane ? 'lane' : 'reject', lane: m.dest, from: m.group.position.clone(), slot: toLane ? Math.max(0, s.lanes[m.dest] - 1) : 0 });
  }
  const inflight = [0, 0, 0];
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i]; g.t += dt / (g.kind === 'lane' ? .85 : .6); const t = Math.min(1, g.t);
    if (g.kind === 'lane') {
      const x = DIVX[g.lane], zEnd = laneSlotZ(Math.min(g.slot, 4)); inflight[g.lane]++;
      const e = t * t * (3 - 2 * t);
      g.group.position.set(g.from.x + (x - g.from.x) * Math.min(1, t * 3), BELT_TOP + (.04 - BELT_TOP) * e + Math.sin(t * Math.PI) * .1, .0 + (zEnd) * e);
      g.group.rotation.x = e * .2 * (1 - t);
    } else {
      g.group.position.set(g.from.x + 1.4 * t, BELT_TOP - 1.1 * t * t, 0); g.group.rotation.z = -t * .9;
    }
    if (t >= 1) { scene.remove(g.group); ghosts.splice(i, 1); }
  }

  // Лотки и корзина
  for (let i = 0; i < 3; i++) {
    const shown = Math.max(0, Math.min(5, s.lanes[i] - inflight[i]));
    laneBoxes[i].forEach((b, k) => { b.visible = k < shown; });
    const full = s.lanes[i] >= s.cap;
    laneStrips[i].material.emissive.set(full ? '#d12b20' : LANE_COLOR[i]); laneStrips[i].material.emissiveIntensity = full ? .35 + .3 * Math.sin(now / 160) : 0;
    labels[i].userData.draw(`${LANES[i]}  ${s.lanes[i]}/${s.cap}`, full ? '#d12b20' : LANE_COLOR[i]);
    const target = s.sv[i] ? -1.0 : 0; const d = diverters[i]; d.cur += (target - d.cur) * Math.min(1, dt * 16); d.pivot.rotation.y = d.cur;
  }
  rejectBoxes.forEach((b, k) => { b.visible = k < Math.min(8, s.rej); }); labels[3].userData.draw('БРАК ' + s.rej, '#b4352c');

  // Маяк и кнопка
  const a = s.alarm, bad = a !== 'OK' && a !== 'HOT', col = bad ? '#d12b20' : a === 'HOT' ? '#e0a21b' : '#2f8f5b';
  const pulse = bad ? (.5 + .5 * Math.sin(now / 130)) : 1;
  beacon.material.color.set(col); beacon.material.emissive.set(col); beacon.material.emissiveIntensity = .25 + .9 * pulse;
  beaconLight.color.set(col); beaconLight.intensity = bad ? 2 + 7 * pulse : 3;
  estopBtn.material.emissiveIntensity = s.estop ? .9 : .2; estopBtn.position.y = s.estop ? 1.24 : 1.3;
  if (now - lastScreenDraw > 250) { lastScreenDraw = now; drawScreen(s); }
  $('hint').style.opacity = stale ? 1 : .85;
  renderer.render(scene, camera);
}

if (buildScene()) { setView('main', true); requestAnimationFrame(frame); }
updateDom(); drawChart(); addLog('Склад запущен, демо в браузере', 'info');
window.addEventListener('resize', drawChart);
window.__warehouse = { demo, get state() { return state; }, get mode() { return mode; }, sendCommand };
