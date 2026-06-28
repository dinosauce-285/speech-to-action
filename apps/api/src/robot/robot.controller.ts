import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  textCommandRequestSchema,
  type CommandResult,
  type TextCommandRequest,
} from './command.schema';
import { RobotService } from './robot.service';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Groq free-tier limit

/** Minimal shape of a multer upload — avoids depending on global type augmentation. */
interface UploadedAudio {
  buffer: Buffer;
  originalname: string;
}

@Controller('robot')
@UseGuards(ApiKeyGuard)
export class RobotController {
  constructor(private readonly robot: RobotService) {}

  /** Request B — send text directly (quick test). */
  @Post('command')
  command(
    @Body(new ZodValidationPipe(textCommandRequestSchema)) body: TextCommandRequest,
  ): Promise<CommandResult> {
    return this.robot.fromText(body.text);
  }

  /** Request A — send recorded audio; backend transcribes via Groq Whisper. */
  @Post('command/audio')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_AUDIO_BYTES } }))
  commandAudio(@UploadedFile() file?: UploadedAudio): Promise<CommandResult> {
    if (!file) {
      throw new BadRequestException('Missing audio file in form field "file"');
    }
    return this.robot.fromAudio(file.buffer, file.originalname || 'audio.webm');
  }
}
