/*
 * secrets.example.h — template for the ESP32 firmware config.
 * Copy to secrets.h (gitignored) and fill in your values.
 *
 * The MQTT_* values should mirror apps/bridge/.env so the ESP32 and the Python
 * bridge talk to the same broker. WiFi is ESP32-only (not in .env).
 */
#pragma once

// ---- WiFi ----------------------------------------------------------------
#define WIFI_SSID  "your-wifi"
#define WIFI_PASS  "your-wifi-password"

// ---- MQTT broker ---------------------------------------------------------
//   local Mosquitto:   host "192.168.1.x", port 1883, TLS 0, no user/pass
//   HiveMQ Cloud:      host "xxxx.s1.eu.hivemq.cloud", port 8883, TLS 1, user/pass
#define MQTT_HOST       "broker.hivemq.com"
#define MQTT_PORT       1883
#define MQTT_TLS        0             // 1 = TLS (WiFiClientSecure), 0 = plain
#define MQTT_USER       ""            // leave "" if the broker has no auth
#define MQTT_PASS       ""
#define MQTT_CLIENT_ID  "esp32-robot"

// ---- Topics (must match the bridge's BRIDGE_MQTT_TOPIC_*) -----------------
#define TOPIC_COMMANDS  "robot/commands"
#define TOPIC_STOP      "robot/stop"
