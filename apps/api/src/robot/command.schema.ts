import { z } from 'zod';

/** Closed set of allowed robot actions — the LLM may not invent new ones. */
export const ACTIONS = ['forward', 'backward', 'left', 'right', 'stop'] as const;

/**
 * MVP command: just `action` + `duration` (seconds, time-based, no sensors).
 * Advanced params (speed, angle, radius, distance, ...) are deferred — see plan.html §4b.
 */
export const commandSchema = z.object({
  action: z.enum(ACTIONS),
  duration: z.number().positive().optional(), // seconds; omitted for "stop"
});

export const commandsSchema = z.array(commandSchema);

/** Request body for the text endpoint. */
export const textCommandRequestSchema = z.object({
  text: z.string().trim().min(1).max(500),
});

export type Command = z.infer<typeof commandSchema>;
export type TextCommandRequest = z.infer<typeof textCommandRequestSchema>;

export interface CommandResult {
  status: 'success' | 'error';
  original_text: string;
  commands: Command[];
  reason?: string;
}
