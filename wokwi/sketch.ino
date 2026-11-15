// Smart Warehouse. ESP32 / Wokwi. Один файл: логика склада встроена, чтобы Wokwi хватило одного sketch.ino.
// Источник: src/Controller.h + src/sketch_main.cpp (сборка: python3 tools/build.py).

// Логика умного склада (C++). Зеркало src/controller.js: тот же алгоритм, те же числа.
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

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ESP32Servo.h>

// Учебная демонстрация. Публичный брокер передаёт только синтетические данные.
const char* MQTT_HOST = "broker.hivemq.com";
const char* DEVICE_ID = "sw-3f9a2c71";
const char* TOPIC_STATE = "smartwarehouse/sw-3f9a2c71/state";
const char* TOPIC_COMMAND = "smartwarehouse/sw-3f9a2c71/command";

const int DHT_PIN = 4, WEIGHT_PIN = 34;
const int SERVO_PIN[3] = {18, 19, 23};
const int LANE_BTN[3] = {25, 26, 27};
const int STOP_BTN = 14, BELT_LED = 13, ALARM_LED = 15, BUZZER_PIN = 32;

DHT dht(DHT_PIN, DHT22);
Adafruit_SSD1306 display(128, 64, &Wire, -1);
Servo servos[3];
WiFiClient network;
PubSubClient mqtt(network);
WarehouseController wh(20260101);

bool screenAvailable = false, softStop = false;
float temperature = 24, humidity = 45;
int servoAngle[3] = {-1, -1, -1};
uint32_t lastTick = 0, lastDht = 0, lastPublish = 0, lastScreen = 0, lastBeep = 0, lastMqttAttempt = 0, lastWifiAttempt = 0;
volatile bool mqttOnline = false;
struct StatePacket { char text[900]; };
struct IncomingCommand { char text[16]; };
QueueHandle_t stateQueue, commandQueue;

struct Button { int pin; bool last; uint32_t changed; };
Button laneButtons[3] = {{25, true, 0}, {26, true, 0}, {27, true, 0}};
Button stopButton = {14, true, 0};
bool pressed(Button& b) {
  bool now = digitalRead(b.pin);
  uint32_t t = millis();
  if (now != b.last && t - b.changed > 40) {
    b.changed = t; b.last = now;
    if (!now) return true;
  }
  return false;
}

const char* modeName() { return wh.mode == WH_RUSH ? "rush" : wh.mode == WH_IDLE ? "idle" : "normal"; }

void applyCommand(String v) {
  v.trim(); v.toLowerCase();
  if (v == "normal") wh.setMode(WH_NORMAL);
  else if (v == "rush") wh.setMode(WH_RUSH);
  else if (v == "idle") wh.setMode(WH_IDLE);
  else if (v == "jam") wh.jam();
  else if (v == "clear") wh.clearAll();
  else if (v == "clra") wh.clearLane(0);
  else if (v == "clrb") wh.clearLane(1);
  else if (v == "clrc") wh.clearLane(2);
  else if (v == "fault") wh.setFault(true);
  else if (v == "fixed") wh.setFault(false);
  else if (v == "estop") softStop = true;
  else if (v == "release") softStop = false;
  else { Serial.println("Commands: normal rush idle jam clear clra clrb clrc fault fixed estop release"); return; }
  Serial.print("COMMAND "); Serial.println(v);
}
void onMessage(char* topic, byte* payload, unsigned int length) {
  if (String(topic) != TOPIC_COMMAND || length > 15) return;
  IncomingCommand command = {};
  memcpy(command.text, payload, length); command.text[length] = 0;
  xQueueSend(commandQueue, &command, 0);
}
void networkTask(void*) {
  StatePacket packet = {};
  for (;;) {
    uint32_t now = millis();
    if (WiFi.status() == WL_CONNECTED) {
      if (!mqtt.connected() && uint32_t(now - lastMqttAttempt) >= 10000) {
        lastMqttAttempt = now;
        if (mqtt.connect("sw-3f9a2c71-esp32")) mqtt.subscribe(TOPIC_COMMAND);
      }
      mqttOnline = mqtt.connected();
      if (mqttOnline) { mqtt.loop(); if (xQueueReceive(stateQueue, &packet, 0) == pdTRUE) mqtt.publish(TOPIC_STATE, packet.text, false); }
    } else {
      mqttOnline = false;
      if (uint32_t(now - lastWifiAttempt) >= 20000) { lastWifiAttempt = now; WiFi.reconnect(); }
    }
    vTaskDelay(pdMS_TO_TICKS(30));
  }
}
void publishState() {
  StatePacket q = {};
  char* p = q.text; const size_t cap = sizeof(q.text);
  int n = snprintf(p, cap, "{\"d\":\"%s\",\"src\":\"wokwi\",\"up\":%lu,\"mode\":\"%s\",\"belt\":%d,\"estop\":%d,\"alarm\":\"%s\",\"t\":%.1f,\"h\":%.0f,\"w\":%d,\"lanes\":[%d,%d,%d],\"cap\":%d,\"rej\":%d,\"sorted\":%d,\"rate\":%d,\"back\":%d,\"sv\":[%d,%d,%d],\"p\":[",
    DEVICE_ID, (unsigned long)millis(), modeName(), wh.belt ? 1 : 0, wh.estop ? 1 : 0, wh.alarm, temperature, humidity, wh.lastWeight,
    wh.lanes[0], wh.lanes[1], wh.lanes[2], (int)WarehouseController::CAP, wh.rejects, wh.sorted, wh.rate(), wh.backlog,
    wh.sv[0] > 0, wh.sv[1] > 0, wh.sv[2] > 0);
  for (int i = 0; i < wh.count && n < (int)cap - 40; i++)
    n += snprintf(p + n, cap - n, "%s[%d,%d,%d,%d]", i ? "," : "", wh.parcels[i].id, wh.parcels[i].pos, wh.parcels[i].dest, wh.parcels[i].w);
  snprintf(p + n, cap - n, "]}");
  Serial.println(q.text);
  xQueueOverwrite(stateQueue, &q);
}
void drawScreen() {
  if (!screenAvailable) return;
  display.clearDisplay(); display.setTextColor(SSD1306_WHITE); display.setTextSize(1); display.setCursor(0, 0);
  display.println("SMART WAREHOUSE");
  display.printf("%s  T:%.0fC\n", modeName(), temperature);
  display.printf("A:%d B:%d C:%d R:%d\n", wh.lanes[0], wh.lanes[1], wh.lanes[2], wh.rejects);
  display.printf("Sorted:%d %d/min\n", wh.sorted, wh.rate());
  display.printf("Belt:%s Q:%d\n", wh.belt ? "RUN" : "STOP", wh.backlog);
  display.printf("%s %s", wh.alarm, mqttOnline ? "MQTT" : "LOCAL");
  display.display();
}
void actuate() {
  digitalWrite(BELT_LED, wh.belt ? HIGH : LOW);
  bool alarm = strcmp(wh.alarm, "OK") != 0;
  digitalWrite(ALARM_LED, alarm ? HIGH : LOW);
  for (int i = 0; i < 3; i++) {
    int angle = wh.sv[i] > 0 ? 60 : 0;
    if (angle != servoAngle[i]) { servos[i].write(angle); servoAngle[i] = angle; }
  }
  // Сигнал без LEDC, чтобы не конфликтовать с сервоприводами.
  bool loud = alarm && strcmp(wh.alarm, "HOT") != 0;
  if (loud && millis() - lastBeep > 800) {
    lastBeep = millis();
    for (int i = 0; i < 50; i++) { digitalWrite(BUZZER_PIN, HIGH); delayMicroseconds(280); digitalWrite(BUZZER_PIN, LOW); delayMicroseconds(280); }
  }
}
void setup() {
  Serial.begin(115200);
  pinMode(BELT_LED, OUTPUT); pinMode(ALARM_LED, OUTPUT); pinMode(BUZZER_PIN, OUTPUT);
  for (int i = 0; i < 3; i++) pinMode(LANE_BTN[i], INPUT_PULLUP);
  pinMode(STOP_BTN, INPUT_PULLUP);
  analogReadResolution(12);
  ESP32PWM::allocateTimer(0); servos[0].setPeriodHertz(50);
  for (int i = 0; i < 3; i++) { servos[i].setPeriodHertz(50); servos[i].attach(SERVO_PIN[i], 500, 2400); servos[i].write(0); servoAngle[i] = 0; }
  Wire.begin(21, 22); dht.begin();
  screenAvailable = display.begin(SSD1306_SWITCHCAPVCC, 0x3c);
  WiFi.mode(WIFI_STA); WiFi.begin("Wokwi-GUEST", "", 6);
  mqtt.setServer(MQTT_HOST, 1883); mqtt.setCallback(onMessage); mqtt.setBufferSize(1024); mqtt.setSocketTimeout(30);
  network.setTimeout(1000);
  stateQueue = xQueueCreate(1, sizeof(StatePacket)); commandQueue = xQueueCreate(4, sizeof(IncomingCommand));
  if (!stateQueue || !commandQueue) { Serial.println("Queue allocation failed"); for (;;) delay(1000); }
  xTaskCreatePinnedToCore(networkTask, "network", 8192, nullptr, 1, nullptr, 0);
  lastTick = millis();
  Serial.println("Ready. Commands: normal rush idle jam clear clra clrb clrc fault fixed estop release");
}
String commandBuffer;
void loop() {
  uint32_t now = millis();
  IncomingCommand incoming;
  while (xQueueReceive(commandQueue, &incoming, 0) == pdTRUE) applyCommand(String(incoming.text));
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') { if (commandBuffer.length()) { applyCommand(commandBuffer); commandBuffer = ""; } }
    else if (commandBuffer.length() < 15) commandBuffer += c;
  }
  for (int i = 0; i < 3; i++) if (pressed(laneButtons[i])) { wh.clearLane(i); Serial.printf("Lane %c cleared\n", 'A' + i); }
  if (pressed(stopButton)) { softStop = !softStop; Serial.println(softStop ? "E-STOP ON" : "E-STOP OFF"); }
  if (now - lastDht >= 2000) {
    lastDht = now;
    float t = dht.readTemperature(), h = dht.readHumidity();
    if (isfinite(t)) temperature = t;
    if (isfinite(h)) humidity = h;
  }
  if (now - lastTick > 1000) lastTick = now - 100;
  while (millis() - lastTick >= 100) {
    lastTick += 100;
    int weight = analogRead(WEIGHT_PIN) * 50 / 4095;
    wh.setInputs(weight, true, temperature, humidity, softStop);
    wh.tick();
  }
  actuate();
  if (now - lastPublish >= 500) { lastPublish = now; publishState(); }
  if (now - lastScreen >= 500) { lastScreen = now; drawScreen(); }
  delay(2);
}
