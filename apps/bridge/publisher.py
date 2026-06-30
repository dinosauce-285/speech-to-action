"""Publishes abstract JSON movement commands to MQTT for an ESP32 robot.

Platform-neutral: the backend/web never change. This bridge receives the same
`{ "commands": [...] }` JSON the API produced and republishes a normalized,
time-based payload onto an MQTT topic that an ESP32 (or any subscriber) consumes.

Normalization — each command is reduced to what a simple time-based car needs:
`action`, `speed` (0–100 %), and `seconds`. `degrees`/`rotations` (wheel travel)
are approximated to seconds since a generic ESP32 car has no encoder. `seconds`
is clamped to BRIDGE_MAX_DURATION as a safety cap. `stop` carries no measure.

Published payloads
------------------
Topic BRIDGE_MQTT_TOPIC_COMMANDS (default ``robot/commands``)::

    {"commands": [
        {"action": "forward", "speed": 60, "seconds": 2.0},
        {"action": "right",   "speed": 60, "seconds": 1.0},
        {"action": "stop"}
    ]}

Topic BRIDGE_MQTT_TOPIC_STOP (default ``robot/stop``) — independent E-STOP::

    {"stop": true}
"""

from __future__ import annotations

import json
import logging
import os

import paho.mqtt.client as mqtt

log = logging.getLogger("bridge.publisher")

# --- Config (override via env) ---------------------------------------------
MQTT_HOST = os.getenv("BRIDGE_MQTT_HOST", "localhost")
MQTT_PORT = int(os.getenv("BRIDGE_MQTT_PORT", "1883"))
MQTT_USERNAME = os.getenv("BRIDGE_MQTT_USERNAME") or None
MQTT_PASSWORD = os.getenv("BRIDGE_MQTT_PASSWORD") or None
MQTT_TLS = os.getenv("BRIDGE_MQTT_TLS", "0") == "1"
MQTT_CLIENT_ID = os.getenv("BRIDGE_MQTT_CLIENT_ID", "speech-to-action-bridge")
MQTT_KEEPALIVE = int(os.getenv("BRIDGE_MQTT_KEEPALIVE", "60"))
MQTT_QOS = int(os.getenv("BRIDGE_MQTT_QOS", "1"))
TOPIC_COMMANDS = os.getenv("BRIDGE_MQTT_TOPIC_COMMANDS", "robot/commands")
TOPIC_STOP = os.getenv("BRIDGE_MQTT_TOPIC_STOP", "robot/stop")

# Movement normalization (JSON → time-based for a simple car)
MAX_DURATION = float(os.getenv("BRIDGE_MAX_DURATION", "10"))       # clamp seconds/step (safety)
DEFAULT_SPEED_PCT = float(os.getenv("BRIDGE_DEFAULT_SPEED_PCT", "60"))  # when speed omitted
ROT_PER_SEC = float(os.getenv("BRIDGE_ROT_PER_SEC", "1.0"))        # approx degrees/rotations → s


def _speed_pct(c: dict) -> float:
    """`speed` 0–100 (%); default when the command omits it."""
    pct = c.get("speed")
    pct = DEFAULT_SPEED_PCT if pct is None else float(pct)
    return max(0.0, min(100.0, pct))


def _seconds(c: dict) -> float:
    """How long to run this step (mirrors the API contract):
    seconds | degrees | rotations are mutually exclusive; default 1s.
    degrees/rotations (wheel travel) are approximated to time (ROT_PER_SEC)
    since a generic car has no encoder. Clamped to MAX_DURATION."""
    if c.get("seconds") is not None:
        s = float(c["seconds"])
    elif c.get("duration") is not None:  # legacy/back-compat
        s = float(c["duration"])
    else:
        rotations = None
        if c.get("rotations") is not None:
            rotations = float(c["rotations"])
        elif c.get("degrees") is not None:
            rotations = float(c["degrees"]) / 360.0
        s = rotations / ROT_PER_SEC if (rotations is not None and ROT_PER_SEC > 0) else 1.0
    return min(s, MAX_DURATION)


def _normalize(c: dict) -> dict:
    """Reduce a command to the ESP32-friendly shape: action[, speed, seconds]."""
    action = c.get("action")
    if action == "stop":
        return {"action": "stop"}
    return {
        "action": action,
        "speed": round(_speed_pct(c), 1),
        "seconds": round(_seconds(c), 3),
    }


class CommandPublisher:
    """Owns the MQTT connection and republishes command sequences.

    Keeps the same surface the old robomaster executor exposed (connect/close/
    run/estop/busy/connected) so the FastAPI layer is unchanged.
    """

    def __init__(self) -> None:
        self._client = mqtt.Client(client_id=MQTT_CLIENT_ID, clean_session=True)
        if MQTT_USERNAME:
            self._client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
        if MQTT_TLS:
            self._client.tls_set()
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self.connected = False

    # The ESP32 owns sequencing/timing, so the bridge never blocks.
    @property
    def busy(self) -> bool:
        return False

    def _on_connect(self, client, userdata, flags, rc) -> None:
        self.connected = rc == 0
        if rc == 0:
            log.info("MQTT connected to %s:%s", MQTT_HOST, MQTT_PORT)
        else:
            log.warning("MQTT connect failed (rc=%s)", rc)

    def _on_disconnect(self, client, userdata, rc) -> None:
        self.connected = False
        log.warning("MQTT disconnected (rc=%s) — will retry", rc)

    def connect(self) -> None:
        """Start the network loop. Non-blocking: keeps retrying so the bridge
        boots even before the broker exists (configure it later)."""
        self._client.reconnect_delay_set(min_delay=1, max_delay=30)
        try:
            self._client.connect_async(MQTT_HOST, MQTT_PORT, keepalive=MQTT_KEEPALIVE)
            self._client.loop_start()
            log.info(
                "MQTT connecting to %s:%s (topics: %s | %s)",
                MQTT_HOST, MQTT_PORT, TOPIC_COMMANDS, TOPIC_STOP,
            )
        except Exception as e:  # never let a missing broker crash boot
            log.warning("MQTT setup error: %s — will keep retrying", e)

    def close(self) -> None:
        try:
            self._client.loop_stop()
            self._client.disconnect()
        except Exception:
            pass
        self.connected = False

    def _publish(self, topic: str, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False)
        self._client.publish(topic, data, qos=MQTT_QOS)
        state = "online" if self.connected else "OFFLINE (broker not connected yet)"
        log.info("publish → %s [%s]: %s", topic, state, data)

    def run(self, commands: list[dict]) -> None:
        """Republish a command sequence to the commands topic."""
        self._publish(TOPIC_COMMANDS, {"commands": [_normalize(c) for c in commands]})

    def estop(self) -> None:
        """Publish an independent E-STOP."""
        self._publish(TOPIC_STOP, {"stop": True})
        log.warning("E-STOP published to %s", TOPIC_STOP)
