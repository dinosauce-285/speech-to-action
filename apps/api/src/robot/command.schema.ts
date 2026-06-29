import { z } from 'zod';

/** Closed set of allowed robot actions — the LLM may not invent new ones. */
export const ACTIONS = ['forward', 'backward', 'left', 'right', 'stop'] as const;

/** The three interchangeable ways to say "how much" — at most one per command. */
export const MEASURES = ['seconds', 'degrees', 'rotations'] as const;

/**
 * A robot step: an action, an optional speed, and at most ONE measure of how far
 * to run it. `degrees`/`rotations` are WHEEL (motor) travel — 360° = 1 wheel turn —
 * NOT the car's heading. `stop` carries no speed/measure.
 */
export const commandSchema = z
  .object({
    action: z.enum(ACTIONS),
    /** Motor power as percent of max (0–100). Omit to use the hardware default. */
    speed: z.number().min(0).max(100).optional(),
    /** Run for this many seconds. */
    seconds: z.number().positive().optional(),
    /** Run until the wheels rotate this many degrees (360 = one wheel turn). */
    degrees: z.number().positive().optional(),
    /** Run until the wheels complete this many rotations (1 = 360 degrees). */
    rotations: z.number().positive().optional(),
  })
  .refine((c) => MEASURES.filter((m) => c[m] !== undefined).length <= 1, {
    message: 'Chỉ được dùng một trong: seconds, degrees, rotations',
  });

export const commandsSchema = z.array(commandSchema);

/**
 * Shape the LLM is asked to return: the executable steps, plus any movement
 * intents it could NOT express with the closed set (e.g. "quay đầu"/U-turn).
 * Out-of-set intents go to `unsupported` verbatim — never coerced into a
 * different action.
 */
export const llmOutputSchema = z.object({
  commands: commandsSchema,
  unsupported: z.array(z.string()).optional(),
});

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
  /** Movement intents that exist in the speech but can't be done with the 5 actions. */
  unsupported?: string[];
  reason?: string;
}
