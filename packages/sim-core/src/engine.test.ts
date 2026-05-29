import { describe, it, expect } from "vitest";
import { Engine } from "./engine.js";
import { generateTerrain, hashWorld } from "./world.js";
import { Rng } from "./rng.js";
import { Zone, Net } from "./constants.js";
import type { Command } from "./commands.js";

// A fixed script of commands we can replay against two independent engines.
function script(): Command[] {
  return [
    { kind: "setSpeed", speed: 4 },
    { kind: "road", x: 5, y: 5 },
    { kind: "road", x: 6, y: 5 },
    { kind: "zone", x: 5, y: 6, zone: Zone.ResLight },
    { kind: "zone", x: 6, y: 6, zone: Zone.ComLight },
    { kind: "powerline", x: 5, y: 7 },
    { kind: "bulldoze", x: 6, y: 5 },
  ];
}

function buildAndRun(seed: number): number {
  const engine = new Engine({ width: 32, height: 32, seed });
  generateTerrain(engine.world, seed);
  for (const cmd of script()) {
    engine.enqueue(cmd);
    engine.tick();
  }
  engine.run(50);
  return hashWorld(engine.world);
}

describe("determinism", () => {
  it("identical seed + command stream produces identical world hash", () => {
    expect(buildAndRun(12345)).toBe(buildAndRun(12345));
  });

  it("different seeds produce different terrain", () => {
    expect(buildAndRun(1)).not.toBe(buildAndRun(2));
  });
});

describe("rng", () => {
  it("is reproducible from a seed", () => {
    const a = new Rng(99);
    const b = new Rng(99);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it("restores from saved state", () => {
    const a = new Rng(7);
    a.next();
    a.next();
    const state = a.getState();
    const b = new Rng(0);
    b.setState(state);
    expect(b.next()).toBe(a.next());
  });
});

describe("commands", () => {
  it("applies road and zone bits to the grid", () => {
    const engine = new Engine({ width: 16, height: 16, seed: 1 });
    generateTerrain(engine.world, 1);
    engine.enqueue({ kind: "road", x: 2, y: 2 });
    engine.enqueue({ kind: "zone", x: 3, y: 3, zone: Zone.IndLight });
    engine.tick();
    expect(engine.world.net[engine.world.idx(2, 2)]! & Net.Road).toBe(Net.Road);
    expect(engine.world.zone[engine.world.idx(3, 3)]).toBe(Zone.IndLight);
  });

  it("records every command to the action log with its tick", () => {
    const engine = new Engine({ width: 16, height: 16, seed: 1 });
    engine.enqueue({ kind: "road", x: 1, y: 1 });
    engine.tick();
    engine.enqueue({ kind: "road", x: 2, y: 1 });
    engine.tick();
    const log = engine.getLog();
    expect(log).toHaveLength(2);
    expect(log[0]!.tick).toBe(1);
    expect(log[1]!.tick).toBe(2);
  });
});
