/*
 * speech-to-action · ESP32 robot subscriber (L298N motor control)
 * ----------------------------------------------------------------
 * Subscribes to the MQTT topics the Python bridge publishes to and drives two DC
 * motors through an L298N module. A command sequence is enqueued and stepped
 * through in loop() (NON-BLOCKING) so mqtt.loop() keeps running and an E-STOP can
 * cut the motors mid-sequence. A hard max-runtime guard stops a runaway step.
 *
 * Arduino IDE setup:
 *   - Board:    "ESP32 Dev Module" (install via Boards Manager → "esp32" by Espressif, core v3.x)
 *   - Libraries (Library Manager):
 *       • PubSubClient   by Nick O'Leary
 *       • ArduinoJson    by Benoit Blanchon  (v7)
 *   - Serial Monitor:   115200 baud
 *
 * Payloads it expects (see apps/bridge/README.md):
 *   topic robot/commands : {"commands":[{"action":"forward","speed":60,"seconds":2.0}, ...]}
 *   topic robot/stop     : {"stop":true}
 *
 * L298N wiring (remove the ENA/ENB jumpers first):
 *   Motor A (LEFT) : ENA→GPIO14  IN1→GPIO27  IN2→GPIO26   OUT1/OUT2→left motor
 *   Motor B (RIGHT): ENB→GPIO32  IN3→GPIO25  IN4→GPIO33   OUT3/OUT4→right motor
 *   Power: battery + → L298N 12V, battery − → L298N GND *and* ESP32 GND (common ground!).
 *   ESP32 powered over USB → leave the L298N 5V pin unconnected.
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "secrets.h"   // WiFi + MQTT credentials — gitignored; copy from secrets.example.h

#if MQTT_TLS
  #include <WiFiClientSecure.h>
#endif

// ===================== CONFIG ========================================
// WiFi / MQTT credentials live in secrets.h (broker matches apps/bridge/.env).
// Below is per-robot hardware config — safe to commit, tune to your build.

// ---- L298N pins (Motor A = LEFT, Motor B = RIGHT) -------------------------
const int ENA = 14, IN1 = 27, IN2 = 26;   // left motor
const int ENB = 32, IN3 = 25, IN4 = 33;   // right motor

// ---- Tuning --------------------------------------------------------------
const int   MIN_DUTY      = 60;     // 0–255: smallest PWM that actually turns the wheels (beat stiction)
const float MAX_STEP_SECS = 10.0;   // hard per-step safety cap (mirrors bridge BRIDGE_MAX_DURATION)
const int   MAX_STEPS     = 32;     // longest command sequence we'll buffer
// =====================================================================

#if MQTT_TLS
WiFiClientSecure net;
#else
WiFiClient net;
#endif
PubSubClient mqtt(net);

// ---- Command queue (filled by MQTT, drained by loop) ---------------------
struct Step {
  char  action[12];
  int   duty;        // 0–255 PWM, already scaled from speed%
  unsigned long ms;  // how long to run this step
};
Step          queue[MAX_STEPS];
volatile int  queueLen   = 0;   // number of valid steps
int           queueIdx   = -1;  // step currently running (-1 = idle)
unsigned long stepStart  = 0;   // millis() when current step began

// ---- Low-level motor control ---------------------------------------------
// dir: +1 forward, -1 reverse, 0 stop. duty 0–255.
void setMotor(int en, int inA, int inB, int dir, int duty) {
  if (dir > 0)      { digitalWrite(inA, HIGH); digitalWrite(inB, LOW); }
  else if (dir < 0) { digitalWrite(inA, LOW);  digitalWrite(inB, HIGH); }
  else              { digitalWrite(inA, LOW);  digitalWrite(inB, LOW); }  // brake
  analogWrite(en, dir == 0 ? 0 : duty);
}

void stopMotors() {
  setMotor(ENA, IN1, IN2, 0, 0);
  setMotor(ENB, IN3, IN4, 0, 0);
}

// Apply one action at a given PWM duty. Differential drive: left/right spin in place.
void drive(const char *action, int duty) {
  if      (strcmp(action, "forward")  == 0) { setMotor(ENA, IN1, IN2, +1, duty); setMotor(ENB, IN3, IN4, +1, duty); }
  else if (strcmp(action, "backward") == 0) { setMotor(ENA, IN1, IN2, -1, duty); setMotor(ENB, IN3, IN4, -1, duty); }
  else if (strcmp(action, "left")     == 0) { setMotor(ENA, IN1, IN2, -1, duty); setMotor(ENB, IN3, IN4, +1, duty); }
  else if (strcmp(action, "right")    == 0) { setMotor(ENA, IN1, IN2, +1, duty); setMotor(ENB, IN3, IN4, -1, duty); }
  else                                       { stopMotors(); }  // "stop" or unknown
}

// ---- Sequencer -----------------------------------------------------------
void abortSequence() {
  queueLen = 0;
  queueIdx = -1;
  stopMotors();
}

// Begin step `i`, or finish the sequence if past the end.
void startStep(int i) {
  if (i >= queueLen) {
    Serial.println("[seq] sequence done — motors stopped.");
    abortSequence();
    return;
  }
  queueIdx  = i;
  stepStart = millis();
  drive(queue[i].action, queue[i].duty);
  Serial.printf("[seq] step %d: action=%-8s duty=%3d  for %lums\n",
                i, queue[i].action, queue[i].duty, queue[i].ms);
}

// Advance the running sequence; called every loop().
void serviceSequence() {
  if (queueIdx < 0) return;                       // idle
  if (millis() - stepStart >= queue[queueIdx].ms) // this step's time is up
    startStep(queueIdx + 1);
}

// ---- WiFi ----------------------------------------------------------------
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("[WiFi] connecting to \"%s\" ", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.printf("\n[WiFi] connected, IP = %s\n", WiFi.localIP().toString().c_str());
}

// ---- Build a queued Step from one JSON command ---------------------------
// speed (0–100 %) → PWM duty (MIN_DUTY..255); seconds → ms, clamped.
void enqueue(JsonObject cmd) {
  if (queueLen >= MAX_STEPS) return;
  const char *action = cmd["action"] | "stop";
  Step &s = queue[queueLen];

  strncpy(s.action, action, sizeof(s.action) - 1);
  s.action[sizeof(s.action) - 1] = '\0';

  if (strcmp(action, "stop") == 0) {
    s.duty = 0;
    s.ms   = 0;            // stop step: cut motors and move on immediately
  } else {
    float speed = cmd["speed"] | 0.0f;          // 0–100 %
    speed = max(0.0f, min(100.0f, speed));
    s.duty = speed <= 0 ? 0 : (int)(MIN_DUTY + (speed / 100.0f) * (255 - MIN_DUTY) + 0.5f);

    float secs = cmd["seconds"] | 0.0f;
    secs = max(0.0f, min(MAX_STEP_SECS, secs));
    s.ms = (unsigned long)(secs * 1000.0f);
  }
  queueLen++;
}

// ---- MQTT message callback ----------------------------------------------
void onMessage(char *topic, byte *payload, unsigned int len) {
  Serial.printf("\n[MQTT] message on \"%s\" (%u bytes)\n", topic, len);

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, len);
  if (err) {
    Serial.printf("[MQTT] JSON parse error: %s\n", err.c_str());
    return;
  }

  // E-STOP — cut motors immediately, drop any running sequence.
  if (strcmp(topic, TOPIC_STOP) == 0) {
    bool stop = doc["stop"] | false;
    Serial.printf("[MQTT] >>> E-STOP received (stop=%s) <<<\n", stop ? "true" : "false");
    abortSequence();
    return;
  }

  // Command sequence — replace the queue (latest wins) and start running.
  if (strcmp(topic, TOPIC_COMMANDS) == 0) {
    JsonArray commands = doc["commands"].as<JsonArray>();
    if (commands.isNull()) {
      Serial.println("[MQTT] no \"commands\" array in payload");
      return;
    }
    abortSequence();           // pre-empt whatever was running
    for (JsonObject cmd : commands) enqueue(cmd);
    Serial.printf("[MQTT] queued %d step(s); starting.\n", queueLen);
    startStep(0);
  }
}

// ---- MQTT (re)connect ----------------------------------------------------
void connectMQTT() {
  while (!mqtt.connected()) {
    connectWiFi();
    Serial.printf("[MQTT] connecting to %s:%d ... ", MQTT_HOST, MQTT_PORT);
    bool ok = (strlen(MQTT_USER) > 0)
                ? mqtt.connect(MQTT_CLIENT_ID, MQTT_USER, MQTT_PASS)
                : mqtt.connect(MQTT_CLIENT_ID);
    if (ok) {
      Serial.println("connected.");
      mqtt.subscribe(TOPIC_COMMANDS);
      mqtt.subscribe(TOPIC_STOP);
      Serial.printf("[MQTT] subscribed to \"%s\" and \"%s\"\n", TOPIC_COMMANDS, TOPIC_STOP);
    } else {
      Serial.printf("failed (rc=%d), retry in 2s\n", mqtt.state());
      stopMotors();   // don't keep driving while disconnected
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== speech-to-action ESP32 subscriber (L298N) ===");

  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT); pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  stopMotors();

#if MQTT_TLS
  net.setInsecure();   // skip CA validation (simplest for HiveMQ Cloud); load a root CA to pin it
#endif

  connectWiFi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMessage);
  mqtt.setBufferSize(1024);   // command sequences can exceed the 256B default
  connectMQTT();
}

void loop() {
  if (!mqtt.connected()) {
    abortSequence();          // safety: stop if we lose the broker mid-sequence
    connectMQTT();
  }
  mqtt.loop();
  serviceSequence();
}
