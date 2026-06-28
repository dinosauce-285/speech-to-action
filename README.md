# speech-to-action

Voice → JSON command system. Speaks Vietnamese → returns a validated JSON array of robot
movement commands. **The product is the API**; the web app is just a test client.

```
voice → (MediaRecorder) → API → Groq Whisper (STT) → Groq Llama (intent) → Zod validate → JSON
```

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

## Layout

```
apps/
  api/   NestJS API — the product
  web/   Next.js test client
```

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
  "original_text": "cho xe chạy tới một đoạn rồi quẹo phải",
  "commands": [
    { "action": "forward", "duration": 2 },
    { "action": "right", "duration": 1 }
  ]
}
```

Allowed actions (closed set): `forward`, `backward`, `left`, `right`, `stop`.
Out-of-scope or unparseable input returns `{ "status": "error", "commands": [], "reason": ... }`.
