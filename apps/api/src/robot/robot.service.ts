import { Injectable, Logger } from '@nestjs/common';
import { GroqService } from '../groq/groq.service';
import { commandsSchema, type Command, type CommandResult } from './command.schema';

const SYSTEM_PROMPT = `Bạn là bộ điều khiển robot xe. Phân tích câu nói tiếng Việt của người dùng và trả về JSON.
Chỉ được dùng đúng 5 action: "forward", "backward", "left", "right", "stop".
Trả về object dạng: {"commands": [{"action": "forward", "duration": 2}, {"action": "right", "duration": 1}]}.
- "duration" là số giây (number) cho mỗi bước; với action "stop" thì bỏ "duration".
- Nếu câu nói không chứa lệnh di chuyển hợp lệ, trả {"commands": []}.
- KHÔNG giải thích, KHÔNG thêm bất kỳ text nào ngoài JSON.`;

type ParseResult = { ok: true; commands: Command[] } | { ok: false; error: string };

@Injectable()
export class RobotService {
  private readonly logger = new Logger(RobotService.name);

  constructor(private readonly groq: GroqService) {}

  /** Transcribe audio (Groq Whisper) then run the text pipeline. */
  async fromAudio(file: Buffer, filename: string): Promise<CommandResult> {
    const text = await this.groq.transcribe(file, filename);
    this.logger.log(`Transcribed: "${text}"`);
    return this.fromText(text);
  }

  /** Core: Vietnamese text → validated JSON commands (with one self-correcting retry). */
  async fromText(text: string): Promise<CommandResult> {
    let raw = await this.groq.complete(SYSTEM_PROMPT, text);
    let parsed = this.tryParse(raw);

    if (!parsed.ok) {
      this.logger.warn(`Validation failed, retrying once: ${parsed.error}`);
      raw = await this.groq.complete(
        SYSTEM_PROMPT,
        `${text}\n\n(Lần trước bạn trả JSON sai: ${parsed.error}. Hãy trả ĐÚNG định dạng được yêu cầu.)`,
      );
      parsed = this.tryParse(raw);
    }

    if (!parsed.ok) {
      return { status: 'error', original_text: text, commands: [], reason: parsed.error };
    }
    if (parsed.commands.length === 0) {
      return {
        status: 'error',
        original_text: text,
        commands: [],
        reason: 'Không nhận diện được hành động hợp lệ',
      };
    }
    return { status: 'success', original_text: text, commands: parsed.commands };
  }

  private tryParse(raw: string): ParseResult {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'Output không phải JSON hợp lệ' };
    }

    // Accept either { commands: [...] } or a bare [...] array.
    const candidate =
      json && typeof json === 'object' && 'commands' in json
        ? (json as { commands: unknown }).commands
        : json;

    const result = commandsSchema.safeParse(candidate);
    if (!result.success) {
      return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
    }
    return { ok: true, commands: result.data };
  }
}
