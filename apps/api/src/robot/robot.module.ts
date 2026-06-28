import { Module } from '@nestjs/common';
import { GroqModule } from '../groq/groq.module';
import { RobotController } from './robot.controller';
import { RobotService } from './robot.service';

@Module({
  imports: [GroqModule],
  controllers: [RobotController],
  providers: [RobotService],
})
export class RobotModule {}
