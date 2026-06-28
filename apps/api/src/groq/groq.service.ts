import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq, { toFile } from 'groq-sdk';

@Injectable()
export class GroqService {
  private readonly logger = new Logger(GroqService.name);
  private readonly client: Groq;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('groq.apiKey');
    if (!apiKey) {
      this.logger.warn('GROQ_API_KEY is not set — Groq calls will fail until configured');
    }
    this.client = new Groq({ apiKey });
  }

  /** Speech-to-text: audio buffer → Vietnamese transcript. */
  async transcribe(file: Buffer, filename: string): Promise<string> {
    const model = this.config.get<string>('groq.sttModel')!;
    const res = await this.client.audio.transcriptions.create({
      file: await toFile(file, filename),
      model,
      language: 'vi',
      temperature: 0,
      response_format: 'json',
    });
    return res.text.trim();
  }

  /** Chat completion forced to a JSON object. */
  async complete(system: string, user: string): Promise<string> {
    const model = this.config.get<string>('groq.llmModel')!;
    const res = await this.client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return res.choices[0]?.message?.content ?? '';
  }
}
