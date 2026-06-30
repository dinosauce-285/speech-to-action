# Product

## Register

product

## Users

Two audiences share one surface:

- **Developers (primarily the author).** Use it daily while building the
  speech-to-action API: speak or type a command, watch it become validated JSON,
  optionally fire it at the robot. Their context is debugging — they need to see
  exactly what was heard, what the model returned, and whether the bridge accepted
  it.
- **Demo viewers (instructors, peers, conference audiences).** Watch a short
  live run: someone speaks Vietnamese, a robot moves. Their context is a first
  impression — the interface has to look credible and be legible to a stranger in
  seconds.

The same screen must serve both: a working debug tool that is also presentable.

## Product Purpose

A test client for the speech-to-action **API** (the real product). It exercises
the full voice pipeline end to end: record audio → transcribe (Whisper) →
intent JSON (Llama) → Zod-validated commands → forward to the robot bridge over
MQTT. Success is: a spoken Vietnamese command becomes correct JSON and, when a
robot is connected, real motion — with every stage visible so failures are easy
to locate. It is explicitly *not* a production app; clarity and trust beat
feature breadth.

## Brand Personality

Futuristic and robotic, but **restrained and precise** — the confidence of a
real control surface, not a neon toy. Three words: *technical, assured, calm.*
The machine feel comes from depth, motion, and typography used deliberately, not
from loud color. It should read as an instrument you trust to drive hardware.

## Anti-references

- **Garish / neon overload.** No rainbow gradients, no excess glow, no motion for
  motion's sake. Futuristic must not become a toy.
- **Raw-prototype look.** No unstyled HTML, no "draft" feel. Every state is
  finished and intentional.
- (Implied) Generic SaaS-landing scaffolding and metric-dashboard clutter — this
  is a single-purpose control surface, not a marketing page or an analytics board.

## Design Principles

1. **Clarity over decoration.** The recording flow and the resulting JSON are the
   center of gravity; every other element earns its place or goes.
2. **Always show system state.** Recording, transcribing, success, error, and
   robot-busy must each be unmistakable — this UI ultimately moves a physical
   robot, so ambiguity is a safety problem, not just a polish one.
3. **Safe by default.** Physical actions (run on robot, E-STOP) are visually
   distinct, obvious, and recoverable; the stop control is always reachable.
4. **Credible machine feel through restraint.** Signal precision with depth,
   motion, and type — not with saturation. Loud is the opposite of trustworthy
   here.
5. **Production-grade, never a prototype.** Finished empty/loading/error states;
   nothing ships looking like a draft.

## Accessibility & Inclusion

- Target **WCAG 2.1 AA**: body text ≥ 4.5:1 contrast, large text ≥ 3:1; this is
  the main risk given the dark, robotic palette — verify, don't assume.
- Fully **keyboard operable**: record/stop, run-on-robot, and E-STOP reachable
  and operable without a pointer; visible focus states.
- **Status changes announced** (aria-live) — "đang nghe", "đang xử lý", success,
  and errors must reach screen-reader users, not only sighted ones.
- **Reduced motion** honored: every animation has a `prefers-reduced-motion`
  alternative (crossfade or instant), including the audio visualizer's intensity.
- Don't rely on color alone to convey state (recording / busy / error also carry
  an icon, label, or shape).
