/*
 * speech-to-action · ESP32 robot subscriber (LOG-ONLY)
 * ----------------------------------------------------
 * Subscribes to the MQTT topics the Python bridge publishes to and prints every
 * command to the Serial Monitor. No motors are driven yet — this is the "does
 * the message arrive?" stage. Motor control goes where the TODOs are.
 *
 * Arduino IDE setup:
 *   - Board:    "ESP32 Dev Module" (install via Boards Manager → "esp32" by Espressif)
 *   - Libraries (Library Manager):
 *       • PubSubClient   by Nick O'Leary
 *       • ArduinoJson    by Benoit Blanchon  (v7)
 *   - Serial Monitor:   115200 baud
 *
 * Payloads it expects (see apps/bridge/README.md):
 *   topic robot/commands : {"commands":[{"action":"forward","speed":60,"seconds":2.0}, ...]}
 *   topic robot/stop     : {"stop":true}
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ===================== CONFIG — EDIT THESE ============================
const char *WIFI_SSID = "your-wifi";
const char *WIFI_PASS = "your-wifi-password";

const char *MQTT_HOST = "192.168.1.10";   // broker IP/host (laptop running Mosquitto, or broker.hivemq.com)
const int   MQTT_PORT = 1883;
const char *MQTT_USER = "";               // leave "" if broker has no auth
const char *MQTT_PASS = "";
const char *MQTT_CLIENT_ID = "esp32-robot";

// Must match the bridge's BRIDGE_MQTT_TOPIC_* values
const char *TOPIC_COMMANDS = "robot/commands";
const char *TOPIC_STOP     = "robot/stop";
// =====================================================================

WiFiClient net;
PubSubClient mqtt(net);

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

// ---- Handle one command (LOG ONLY) --------------------------------------
void handleCommand(JsonObject cmd, int idx) {
  const char *action = cmd["action"] | "(none)";

  if (strcmp(action, "stop") == 0) {
    Serial.printf("   [%d] action=stop\n", idx);
    // TODO(motors): stopMotors();
    return;
  }

  float speed   = cmd["speed"]   | 0.0f;   // 0–100 (%)
  float seconds = cmd["seconds"] | 0.0f;   // how long to run
  Serial.printf("   [%d] action=%-8s speed=%5.1f%%  seconds=%.3f\n",
                idx, action, speed, seconds);

  // TODO(motors): set direction from `action`, PWM duty from `speed`,
  //               run for `seconds`, then stop. Keep your own max-runtime guard.
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

  // E-STOP
  if (strcmp(topic, TOPIC_STOP) == 0) {
    bool stop = doc["stop"] | false;
    Serial.printf("[MQTT] >>> E-STOP received (stop=%s) <<<\n", stop ? "true" : "false");
    // TODO(motors): stopMotors();  // abort any running sequence immediately
    return;
  }

  // Command sequence
  if (strcmp(topic, TOPIC_COMMANDS) == 0) {
    JsonArray commands = doc["commands"].as<JsonArray>();
    if (commands.isNull()) {
      Serial.println("[MQTT] no \"commands\" array in payload");
      return;
    }
    Serial.printf("[MQTT] sequence of %u command(s):\n", commands.size());
    int idx = 0;
    for (JsonObject cmd : commands) {
      handleCommand(cmd, idx++);
    }
    Serial.println("[MQTT] sequence done (logged).");
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
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== speech-to-action ESP32 subscriber (LOG-ONLY) ===");
  connectWiFi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMessage);
  mqtt.setBufferSize(1024);   // command sequences can exceed the 256B default
  connectMQTT();
}

void loop() {
  if (!mqtt.connected()) connectMQTT();
  mqtt.loop();
}
