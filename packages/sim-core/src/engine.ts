// Fixed-timestep, deterministic simulation engine. The engine owns the world, a queue
// of pending commands, and an ordered list of subsystem "passes". Each tick it drains
// the command queue (recording to the action log) then runs every pass in order.
//
// Phase 0 ships the orchestration + the calendar pass only. Phase 1+ register the real
// passes (power, water, traffic, zone growth, RCI demand, land value, budget, ...).

import type { Command, LoggedCommand } from "./commands.js";
import { applyCommand } from "./commands.js";
import { World } from "./world.js";
import { Speed, TICKS_PER_MONTH, TICKS_PER_YEAR, START_YEAR } from "./constants.js";

export interface SimContext {
  world: World;
  tick: number;
}

export interface SimPass {
  readonly name: string;
  update(ctx: SimContext): void;
}

export interface EngineOptions {
  width: number;
  height: number;
  seed: number;
  passes?: SimPass[];
}

export class Engine {
  readonly world: World;
  readonly seed: number;
  private readonly passes: SimPass[];
  private readonly pending: Command[] = [];
  private readonly log: LoggedCommand[] = [];
  private speed: number = Speed.Paused;

  constructor(opts: EngineOptions) {
    this.world = new World(opts.width, opts.height, opts.seed);
    this.seed = opts.seed;
    this.passes = opts.passes ?? [];
  }

  getSpeed(): number {
    return this.speed;
  }

  /** Queue a command to be consumed on the next tick. Recorded to the action log. */
  enqueue(cmd: Command): void {
    if (cmd.kind === "setSpeed") {
      this.speed = cmd.speed;
    }
    this.pending.push(cmd);
  }

  /** The recorded action log (source of truth for save/replay/verification). */
  getLog(): readonly LoggedCommand[] {
    return this.log;
  }

  /** Advance the simulation by exactly one tick. */
  tick(): void {
    const t = ++this.world.clock.tick;

    // 1) Drain queued commands, applying + logging each.
    for (const cmd of this.pending) {
      this.log.push({ tick: t, cmd });
      applyCommand(this.world, cmd);
    }
    this.pending.length = 0;

    // 2) Run subsystem passes in registration order.
    const ctx: SimContext = { world: this.world, tick: t };
    for (const pass of this.passes) pass.update(ctx);
  }

  /**
   * Advance by N ticks (used by the worker loop and by server-side verification, which
   * re-runs a saved action log through a fresh engine).
   */
  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.tick();
  }

  /** How many ticks to advance this real-time frame, given current speed. */
  ticksForFrame(): number {
    return this.speed;
  }
}

// Convenience: derive a human calendar from the tick count (simplified 360-day year).
export function calendar(tick: number): { year: number; month: number; day: number } {
  const year = START_YEAR + Math.floor(tick / TICKS_PER_YEAR);
  const intoYear = tick % TICKS_PER_YEAR;
  const month = Math.floor(intoYear / TICKS_PER_MONTH) + 1;
  const day = (intoYear % TICKS_PER_MONTH) + 1;
  return { year, month, day };
}
