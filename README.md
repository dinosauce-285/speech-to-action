# speech-to-action

Voice → JSON command system. Speaks Vietnamese → returns a validated JSON array of robot
movement commands. **The product is the API**; the web app is just a test client.

```
voice → (MediaRecorder) → API → Groq Whisper (STT) → Groq Llama (intent) → Zod validate → JSON
                                                                                   │
                                          client forwards JSON ──▶ Bridge ──Wi-Fi──▶ DJI RoboMaster S1
```

The API stays **platform-neutral** (just emits abstract JSON). A separate, decoupled
**bridge** (`apps/bridge`, Python) translates that JSON into DJI SDK calls — the client
forwards the JSON to it, so the backend never knows about the hardware.

See [plan.html](plan.html) for the full design and decisions.

## Stack

| Layer | Choice |
| ----- | ------ |
| API | NestJS (TypeScript) |
| STT | Groq Whisper `whisper-large-v3` (`language: vi`) |
| LLM | Groq `llama-3.3-70b-versatile` (JSON mode) |
| Validation | Zod |
| Auth (MVP) | `X-API-Key` header vs `API_KEY` env |
| Test client | Next.js + Tailwind |

## Cấu trúc thư mục

Monorepo dùng **pnpm workspaces**: 2 app độc lập trong `apps/`, chia sẻ cùng lockfile/cấu hình ở gốc.

```
speech-to-action/
├─ apps/
│  ├─ api/                       # NestJS API — đây là SẢN PHẨM chính
│  │  ├─ src/
│  │  │  ├─ main.ts              # bootstrap: prefix /api/v1, bật CORS, đọc PORT
│  │  │  ├─ app.module.ts        # module gốc, nạp ConfigModule + RobotModule
│  │  │  ├─ config/
│  │  │  │  └─ configuration.ts  # gom biến env (PORT, API_KEY, groq.*)
│  │  │  ├─ common/
│  │  │  │  ├─ guards/
│  │  │  │  │  └─ api-key.guard.ts      # chặn request thiếu/sai X-API-Key → 401
│  │  │  │  └─ zod-validation.pipe.ts   # validate body request bằng Zod
│  │  │  ├─ groq/
│  │  │  │  ├─ groq.module.ts
│  │  │  │  └─ groq.service.ts   # client Groq: transcribe() (STT) + complete() (LLM)
│  │  │  └─ robot/
│  │  │     ├─ robot.controller.ts  # 2 endpoint: /command (text) & /command/audio
│  │  │     ├─ robot.service.ts     # LÕI: text → LLM → Zod validate → JSON (+ retry)
│  │  │     ├─ robot.module.ts
│  │  │     └─ command.schema.ts    # Zod schema + types (action + duration)
│  │  └─ .env.example            # PORT, API_KEY, GROQ_API_KEY, model names
│  │
│  ├─ web/                       # Next.js — CHỈ là client để test API
│  │  ├─ app/
│  │  │  ├─ page.tsx             # UI: gửi text, ghi âm, visualizer, transcript + điều khiển robot
│  │  │  ├─ layout.tsx
│  │  │  └─ globals.css
│  │  └─ .env.example            # NEXT_PUBLIC_API_BASE_URL, _API_KEY, _BRIDGE_URL
│  │
│  └─ bridge/                    # Python — LỚP THỰC THI, tách rời backend (DJI RoboMaster S1)
│     ├─ main.py                 # FastAPI: POST /execute (202, fire-and-forget), /stop (E-STOP), /health
│     ├─ executor.py            # map action → robomaster chassis.drive_speed; trần duration; E-STOP
│     ├─ requirements.txt
│     ├─ .env.example            # BRIDGE_CONN_TYPE, SPEED/TURN/MAX_DURATION, BRIDGE_DRY_RUN
│     └─ README.md
│
├─ plan.html                     # bản thiết kế đầy đủ + các quyết định đã chốt
├─ pnpm-workspace.yaml           # khai báo apps/* là workspace
└─ package.json                  # script gốc: dev:api, dev:web, build
```

Nguyên tắc tách lớp trong `api/src/`: **controller** chỉ nhận request → **service** xử lý nghiệp vụ → **groq.service** là lớp gọi nhà cung cấp AI (bọc lại để sau đổi model/provider không ảnh hưởng chỗ khác).

## Vì sao có 2 endpoint? (không phải 2 API)

Thực ra chỉ có **1 API duy nhất** với **1 lõi xử lý chung** (`text → LLM → JSON`). Có 2 endpoint vì 2 cách *đưa input vào*:

| Endpoint | Input | Dùng khi |
| -------- | ----- | -------- |
| `POST /robot/command` | JSON `{ text }` | **Test nhanh**: gõ thẳng câu lệnh bằng text, không cần micro/ghi âm. Bỏ qua bước STT nên rẻ + nhanh, dễ debug prompt/LLM. |
| `POST /robot/command/audio` | file audio (multipart) | **Luồng thật**: người dùng nói → ghi âm → gửi lên. Backend chạy thêm bước Groq Whisper (STT) để ra text, rồi **tái dùng đúng lõi** của endpoint text. |

Nói cách khác: endpoint audio = endpoint text + **1 bước STT cắm ở đầu**. Tách ra giúp bạn kiểm thử phần "hiểu ngôn ngữ" (LLM) riêng biệt với phần "nghe" (STT) — nếu kết quả sai, biết ngay lỗi ở khâu nào.

## Flow hoạt động

```
[Web client]                    [NestJS API]                       [Groq]
   │  🎙️ MediaRecorder ghi audio
   │  (đồng thời vẽ visualizer)
   │ ── POST /command/audio (file + X-API-Key) ─▶
   │                          ① ApiKeyGuard: đúng key? sai → 401
   │                          ② groq.transcribe(audio) ───────────▶ Whisper (vi) → text
   │                          ③ groq.complete(system, text) ──────▶ Llama (JSON mode)
   │                          ④ Zod validate → sai thì retry 1 lần
   │                          ⑤ đóng gói { status, original_text, commands }
   │ ◀──────────────────────── JSON ──────────────────────────────
   │  hiện "câu vừa nói" (original_text) + JSON commands
```

Endpoint text (`/command`) đi đúng flow này nhưng **bỏ bước ②** — vì đã có text sẵn, vào thẳng bước ③. Đó chính là phần "lõi dùng chung".

Điểm thiết kế đáng chú ý:
- **Closed set 5 action** (`forward/backward/left/right/stop`) ép bằng `z.enum` → LLM không bịa được lệnh lạ, an toàn cho xe.
- **Retry 1 lần**: nếu LLM trả JSON sai schema, gọi lại Groq kèm thông báo lỗi để tự sửa; vẫn fail → trả `status: "error"` thay vì crash.
- **Tách "hiểu ngôn ngữ" khỏi "thực thi vật lý"**: API chỉ tạo JSON; sau này nối EV3/Arduino/MQTT không phải sửa luồng này.

## Setup

Requires Node ≥ 20 and pnpm.

```bash
pnpm install

# API env
cp apps/api/.env.example apps/api/.env
# set GROQ_API_KEY (https://console.groq.com) and API_KEY in apps/api/.env

# Web env (optional, for the test client)
cp apps/web/.env.example apps/web/.env.local
```

## Run

```bash
pnpm dev:api   # http://localhost:3001/api/v1
pnpm dev:web   # http://localhost:3000
```

### Full pipeline (voice → robot)

Start the bridge too (separate Python service). It defaults to `BRIDGE_DRY_RUN=1`,
so you can run the **whole pipeline without a robot** — commands are just logged.

```bash
cd apps/bridge
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                       # BRIDGE_DRY_RUN=1 by default
uvicorn main:app --port 8000 --env-file .env
```

Then open the web client: speak a command → it transcribes → returns JSON → the client
auto-forwards it to the bridge (toggle "Tự chạy") → bridge drives the robot. Use the
red **E-STOP** button to halt anytime. To drive a real **DJI RoboMaster S1**, set
`BRIDGE_DRY_RUN=0` and enable SDK mode on the robot — see [apps/bridge/README.md](apps/bridge/README.md).

## API

Both endpoints require the `X-API-Key` header.

### `POST /api/v1/robot/command` — text

```bash
curl -X POST http://localhost:3001/api/v1/robot/command \
  -H "Content-Type: application/json" \
  -H "X-API-Key: change-me-dev-key" \
  -d '{"text":"cho xe chạy tới một đoạn rồi quẹo phải"}'
```

### `POST /api/v1/robot/command/audio` — audio (multipart, field `file`)

```bash
curl -X POST http://localhost:3001/api/v1/robot/command/audio \
  -H "X-API-Key: change-me-dev-key" \
  -F "file=@command.webm"
```

### Response

```json
{
  "status": "success",
  "original_text": "chạy tới thật nhanh trong 3 giây rồi quẹo phải 90 độ",
  "commands": [
    { "action": "forward", "speed": 90, "seconds": 3 },
    { "action": "right", "degrees": 90 }
  ]
}
```

Allowed actions (closed set): `forward`, `backward`, `left`, `right`, `stop`.

Each command may carry optional parameters:

| Field | Meaning |
| ----- | ------- |
| `speed` | Motor power, percent `0–100`. Words like *nhanh/chậm* are mapped to a number. Omitted ⇒ hardware default. |
| `seconds` | Run for N seconds. |
| `degrees` | Run until the **wheels** rotate N degrees (`360` = one wheel turn). |
| `rotations` | Run until the **wheels** complete N rotations (`1` = `360` degrees). |

`seconds` / `degrees` / `rotations` are **mutually exclusive** — at most one per command (it's the "how much" measure). `degrees`/`rotations` are *wheel* travel, **not** the car's heading; `stop` carries no params. When no measure is given, `seconds: 1` is the default.

### Out of scope (all-or-nothing)

If **any** part of the utterance can't be done with the 5 actions — a body-heading turn (`quay đầu`, `đánh lái 45°`), a curved path (`đi vòng tròn`), an absolute distance (`đi 2 mét`), or a non-driving action (`bấm còi`) — the **whole** command is rejected (no partial execution), and the un-doable phrases are listed:

```json
{
  "status": "error",
  "original_text": "đi tới rồi quay đầu lại",
  "commands": [],
  "unsupported": ["quay đầu lại"],
  "reason": "Robot không làm được \"quay đầu lại\" nên không thực hiện câu lệnh này."
}
```
