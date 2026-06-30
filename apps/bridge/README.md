# Robot Bridge · MQTT → ESP32

The physical-execution layer. A **standalone Python service**, fully decoupled
from the backend (`apps/api`). The backend stays platform-neutral and only emits
abstract JSON commands; this bridge **republishes them onto MQTT** so an ESP32
robot can drive itself.

```
NestJS API ─JSON─▶ Web client ─POST /execute─▶ Bridge (this) ─MQTT─▶ Broker ─▶ ESP32 ─▶ motors
(platform-neutral)  (forwards)                 (publishes)
```

The **web client** forwards the JSON — the backend never calls the bridge (low
coupling). Swapping robot platforms = swapping this bridge; API/web don't change.

## Run

```bash
cd apps/bridge
python -m venv .venv && source .venv/bin/activate   # or any Python ≥3.9
pip install -r requirements.txt
cp .env.example .env          # then set your MQTT broker
uvicorn main:app --host 0.0.0.0 --port 8000 --env-file .env
```

The bridge **boots even without a broker** — it retries the connection in the
background. Until the broker is up, `/execute` still returns `202` and logs the
payload as `OFFLINE`. `--host 0.0.0.0` lets other machines on the LAN reach it.

## Endpoints (unchanged — web client compatible)

| Method | Path       | Purpose                                                  |
|--------|------------|----------------------------------------------------------|
| POST   | `/execute` | Publish a command sequence to the commands topic → `202`.|
| POST   | `/stop`    | Publish an independent **E-STOP** to the stop topic.     |
| GET    | `/health`  | `{ connected, busy }` (`connected` = MQTT link up).      |

`/execute` body matches the API response (`§4` of the plan):

```json
{ "commands": [ { "action": "forward", "speed": 90, "seconds": 2 }, { "action": "right", "degrees": 90 } ] }
```

## What gets published (the ESP32 contract)

The bridge **normalizes** each command to a simple time-based shape and publishes
JSON. Subscribe your ESP32 to these topics:

**`robot/commands`** (configurable via `BRIDGE_MQTT_TOPIC_COMMANDS`):

```json
{
  "commands": [
    { "action": "forward", "speed": 60, "seconds": 2.0 },
    { "action": "right",   "speed": 60, "seconds": 1.0 },
    { "action": "stop" }
  ]
}
```

- `action`: one of `forward` `backward` `left` `right` `stop`.
- `speed`: `0–100` (%). Map to PWM duty on the ESP32.
- `seconds`: how long to run the step (float, already clamped to
  `BRIDGE_MAX_DURATION`). Absent for `stop`.
- `degrees`/`rotations` from the API are converted to `seconds` here
  (`BRIDGE_ROT_PER_SEC`), so the ESP32 only ever sees `seconds`.

**`robot/stop`** (configurable via `BRIDGE_MQTT_TOPIC_STOP`) — E-STOP:

```json
{ "stop": true }
```

Suggested ESP32 loop: on a `commands` message, run each step in order
(set motor direction + PWM from `speed`, wait `seconds`, stop between steps);
on any `robot/stop` message, abort immediately and halt the motors. Always end
stopped, and keep your own max-runtime guard as a backstop.

## Config (`.env`)

| Var | Meaning |
|-----|---------|
| `BRIDGE_MQTT_HOST` / `_PORT` | Broker address (e.g. `localhost:1883`, `broker.hivemq.com:1883`). |
| `BRIDGE_MQTT_USERNAME` / `_PASSWORD` | Broker auth (blank = none). |
| `BRIDGE_MQTT_TLS` | `1` for TLS (e.g. HiveMQ Cloud on `8883`). |
| `BRIDGE_MQTT_CLIENT_ID` / `_KEEPALIVE` / `_QOS` | MQTT client tunables. |
| `BRIDGE_MQTT_TOPIC_COMMANDS` / `_STOP` | Topics the ESP32 subscribes to. |
| `BRIDGE_MAX_DURATION` | Clamp `seconds` per step (safety). |
| `BRIDGE_DEFAULT_SPEED_PCT` | Speed % when a command omits `speed`. |
| `BRIDGE_ROT_PER_SEC` | Approximate `degrees`/`rotations` → seconds. |

## Local broker quickstart (optional)

Mosquitto on the laptop, with both ESP32 and bridge on the same Wi-Fi:

```bash
# install + run mosquitto (Debian/Ubuntu)
sudo apt install mosquitto mosquitto-clients
mosquitto -v -p 1883            # foreground, verbose

# watch what the bridge publishes:
mosquitto_sub -h localhost -t 'robot/#' -v
```

Point the ESP32 at the laptop's LAN IP and `.env`'s `BRIDGE_MQTT_HOST=localhost`.
For zero install, use the public `broker.hivemq.com:1883` on both sides instead.

## Safety

- `BRIDGE_MAX_DURATION` clamps every step's `seconds` before publishing.
- `/stop` publishes an E-STOP the ESP32 should honor immediately.
- The ESP32 must keep its **own** watchdog/max-runtime guard — never trust the
  network to stop a moving robot.
