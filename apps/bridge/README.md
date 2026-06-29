# Robot Bridge · DJI RoboMaster S1

The physical-execution layer. A **standalone Python service**, fully decoupled
from the backend (`apps/api`). The backend stays platform-neutral and only emits
abstract JSON commands; this bridge translates them into DJI SDK calls over Wi-Fi.

```
NestJS API ─JSON─▶ Web client ─POST /execute─▶ Bridge (this) ─Wi-Fi─▶ RoboMaster S1
(platform-neutral)  (forwards)                 (robomaster SDK)
```

The **client** forwards the JSON — the backend never calls the bridge (low coupling).

## Run

```bash
cd apps/bridge
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # defaults to BRIDGE_DRY_RUN=1 (no hardware needed)
uvicorn main:app --port 8000 --env-file .env
```

### Try it (dry-run, no robot)

```bash
curl -X POST http://localhost:8000/execute \
  -H 'Content-Type: application/json' \
  -d '{"commands":[{"action":"forward","duration":2},{"action":"right","duration":1}]}'
# -> 202 {"status":"accepted","steps":2}; watch the server log for drive_speed lines

curl -X POST http://localhost:8000/stop    # E-STOP
curl http://localhost:8000/health
```

## Endpoints

| Method | Path       | Purpose                                                        |
|--------|------------|---------------------------------------------------------------|
| POST   | `/execute` | Run a command sequence. Fire-and-forget → `202` immediately. `409` if busy. |
| POST   | `/stop`    | Independent E-STOP: abort the sequence + halt wheels.         |
| GET    | `/health`  | `{ connected, busy }`.                                        |

Request body matches the API response (`§4` of the plan):

```json
{ "commands": [ { "action": "forward", "duration": 2 }, { "action": "right", "duration": 1 } ] }
```

## Action mapping (time-based)

| action     | chassis call                          |
|------------|---------------------------------------|
| `forward`  | `drive_speed(x=+SPEED, y=0, z=0)`     |
| `backward` | `drive_speed(x=-SPEED, y=0, z=0)`     |
| `left`     | `drive_speed(x=0, y=0, z=-TURN)`      |
| `right`    | `drive_speed(x=0, y=0, z=+TURN)`      |
| `stop`     | `drive_speed(0, 0, 0)`                |

Unsupported actions are **skipped + logged**, never fatal (shared vocabulary).

## ⚠️ RoboMaster S1 + SDK caveat

The `robomaster` Python SDK officially targets the **RoboMaster EP**. The **S1**
does not expose the SDK out of the box — you typically must **enable SDK mode**
(e.g. via the RoboMaster app's Lab / a connection-mode unlock) before
`robot.initialize()` will connect. **Validate connectivity first (milestone E1).**
Until then, develop everything else with `BRIDGE_DRY_RUN=1`.

## Safety

- `BRIDGE_MAX_DURATION` caps every step (default 10s).
- The robot stops between every step and always ends stopped.
- `/stop` interrupts a running sequence within milliseconds (interruptible wait).
- Sequences are serialized; a second `/execute` while busy returns `409`.
