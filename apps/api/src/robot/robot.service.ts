import { Injectable, Logger } from '@nestjs/common';
import { GroqService } from '../groq/groq.service';
import { llmOutputSchema, type Command, type CommandResult } from './command.schema';

const SYSTEM_PROMPT = `Bạn là bộ điều khiển một robot xe có bánh. Nhiệm vụ: HIỂU Ý NGHĨA câu nói tiếng Việt của người dùng (suy luận theo ngữ nghĩa, KHÔNG dò từ khóa cố định) rồi diễn đạt thành chuỗi hành động vật lý mà robot làm được.

Khả năng vật lý của robot — chỉ có 5 hành động cơ bản:
- "forward": chạy thẳng về phía trước.
- "backward": chạy thẳng về phía sau (lùi).
- "left": xoay tại chỗ sang trái.
- "right": xoay tại chỗ sang phải.
- "stop": dừng lại.
Chuyển động tính bằng THỜI GIAN (giây). Robot KHÔNG có cảm biến, KHÔNG đo được góc hay khoảng cách chính xác, KHÔNG đi đường cong, KHÔNG làm hai chuyển động cùng lúc.

Mỗi bước có thể kèm các tham số tùy chọn:
- "speed": tốc độ, số phần trăm 0–100. Nếu người dùng nói chung chung như "chậm/từ từ" → ~30, "vừa" → ~60, "nhanh/hết ga" → ~90; nói rõ phần trăm thì dùng đúng số đó. Không nhắc gì về tốc độ thì BỎ "speed".
- Lượng di chuyển "bao nhiêu" chỉ được dùng ĐÚNG MỘT trong ba (loại trừ nhau):
  • "seconds": chạy trong N giây — "trong 2 giây" → seconds: 2.
  • "degrees": BÁNH XE quay N độ (360 = 1 vòng bánh) — "đi tới 360 độ" → degrees: 360.
  • "rotations": BÁNH XE quay N vòng (1 vòng = 360 độ) — "tới 2 vòng" → rotations: 2.
  TUYỆT ĐỐI không set quá một trong ba. Với "stop" thì bỏ cả ba và "speed". Nếu người dùng không nói thời lượng/quãng nào thì mặc định seconds: 1.

Cách làm:
- Với mỗi ý định của người dùng, hãy suy nghĩ xem họ THỰC SỰ muốn xe làm gì, rồi quy về các hành động cơ bản trên THEO Ý NGHĨA — bất kể họ dùng từ ngữ hay cách diễn đạt nào (ví dụ "nhích lên", "bò tới trước", "tiến" đều là forward; "đảo người qua bên phải", "vòng sang phải" đều là right). Đừng phụ thuộc vào một danh sách từ có sẵn.
- Lặp "N lần" thì bung thành N bước tương ứng. Ví dụ "xoay trái xoay phải 3 lần" = [left, right, left, right, left, right].
- LƯU Ý: "degrees" và "rotations" là độ quay của BÁNH XE (động cơ), KHÔNG phải hướng/góc quay của thân xe. Vì vậy KHÔNG suy ra được độ/vòng bánh xe từ một góc QUAY THÂN XE.
- Các cụm yêu cầu xe XOAY THÂN tới một hướng/góc cụ thể — như "quay đầu", "quay lại", "quay xe lại", "đổi hướng", "đánh lái", "quay 180 độ" — PHẢI cho vào "unsupported". TUYỆT ĐỐI không được map chúng thành left/right (kể cả kèm degrees/rotations). Ngược lại "xoay trái/phải" kèm số độ/vòng/giây của bánh xe (vd "xoay phải 90 độ") thì LÀM ĐƯỢC.
- Chỉ đưa vào "unsupported" khi ý định KHÔNG THỂ đạt được bằng bất kỳ chuỗi hành động cơ bản nào — tức là cần thứ robot không có:
  • xoay thân xe theo một góc/hướng cụ thể (ví dụ "quay đầu" = quay xe 180 độ, "đánh lái 45 độ", "quay xe sang hướng đông");
  • khoảng cách tuyệt đối (ví dụ "đi đúng 2 mét");
  • đường cong / quỹ đạo vòng (ví dụ "đi vòng tròn", "chạy hình số 8", "rẽ vòng cung");
  • hành vi không phải lái xe (ví dụ "bấm còi", "nhảy", "bật đèn").
  Ghi nguyên văn cụm không làm được vào "unsupported".
- Đừng bao giờ bỏ một động tác hợp lệ (tiến/lùi/xoay trái/xoay phải/dừng) vào "unsupported".
- Nếu câu nói không chứa lệnh di chuyển nào, trả {"commands": [], "unsupported": []}.
- KHÔNG giải thích, CHỈ trả JSON đúng dạng:
  {"commands": [{"action": "forward", "speed": 60, "seconds": 2}, {"action": "right", "rotations": 1}], "unsupported": []}`;

type ParseResult =
  | { ok: true; commands: Command[]; unsupported: string[] }
  | { ok: false; error: string };

@Injectable()
export class RobotService {
  private readonly logger = new Logger(RobotService.name);

  constructor(private readonly groq: GroqService) {}

  /** Transcribe audio (Groq Whisper) then run the text pipeline. */
  async fromAudio(file: Buffer, filename: string): Promise<CommandResult> {
    const text = await this.groq.transcribe(file, filename);
    this.logger.log(`Transcribed: "${text}"`);
    if (!text) {
      return {
        status: 'error',
        original_text: '',
        commands: [],
        reason: 'Không nghe được giọng nói (audio im lặng hoặc không rõ). Hãy thử nói lại rõ hơn.',
      };
    }
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

    const { commands, unsupported } = parsed;

    // All-or-nothing: if any part is beyond the robot's 5 actions, reject the
    // WHOLE command — don't run the earlier steps and leave the robot mid-task.
    if (unsupported.length > 0) {
      return {
        status: 'error',
        original_text: text,
        commands: [],
        unsupported,
        reason: `Robot không làm được "${unsupported.join('", "')}" nên không thực hiện câu lệnh này.`,
      };
    }

    if (commands.length === 0) {
      return {
        status: 'error',
        original_text: text,
        commands: [],
        reason: 'Không nhận diện được hành động hợp lệ',
      };
    }

    return { status: 'success', original_text: text, commands };
  }

  private tryParse(raw: string): ParseResult {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'Output không phải JSON hợp lệ' };
    }

    // Accept { commands, unsupported? }, or a bare [...] array (legacy/lenient).
    const candidate = Array.isArray(json) ? { commands: json } : json;

    const result = llmOutputSchema.safeParse(candidate);
    if (!result.success) {
      return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
    }
    return { ok: true, commands: result.data.commands, unsupported: result.data.unsupported ?? [] };
  }
}
