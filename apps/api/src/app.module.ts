import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { GroqModule } from './groq/groq.module';
import { RobotModule } from './robot/robot.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    GroqModule,
    RobotModule,
  ],
})
export class AppModule {}
