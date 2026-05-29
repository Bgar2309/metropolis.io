import { describe, it, expect } from "vitest";
import { Engine } from "./engine.js";
import { createDefaultPasses } from "./systems/index.js";
import { generateTerrain, hashWorld, Terrain } from "./world.js";
import { toSave, fromSave } from "./serialize.js";
import { Build } from "./buildings.js";
import { Zone } from "./constants.js";
import type { Command } from "./commands.js";

// Build a small powered, road-served residential block on guaranteed-land tiles, then
// run the sim and assert the city actually develops.
function foundCity(seed: number): Engine {
  const engine = new Engine({ width: 32, height: 32, seed, passes: createDefaultPasses() });
  generateTerrain(engine.world, seed);

  // Find a 6x6 patch of non-water land to build on (terrain gen is seed-dependent).
  const w = engine.world;
  let ox = -1;
  let oy = -1;
  for (let y = 2; y < w.height - 8 && oy < 0; y++) {
    for (let x = 2; x < w.width - 8; x++) {
      let ok = true;
      for (let dy = 0; dy < 6 && ok; dy++)
        for (let dx = 0; dx < 6; dx++)
          if (w.terrain[w.idx(x + dx, y + dy)] === Terrain.Water) ok = false;
      if (ok) {
        ox = x;
        oy = y;
        break;
      }
    }
  }
  expect(ox).toBeGreaterThanOrEqual(0);

  // Power path: plant -> line -> line, the second line sits next to the zone block so
  // power conducts through the contiguous zoned tiles.
  const cmds: Command[] = [
    { kind: "placeBuilding", x: ox, y: oy, build: Build.CoalPlant },
    { kind: "powerline", x: ox + 1, y: oy },
    { kind: "powerline", x: ox + 1, y: oy + 1 },
  ];
  // A row of road + residential/commercial lots beside it.
  for (let k = 0; k < 4; k++) {
    cmds.push({ kind: "road", x: ox + 1 + k, y: oy + 1 });
    cmds.push({ kind: "zone", x: ox + 1 + k, y: oy + 2, zone: Zone.ResLight });
    cmds.push({ kind: "zone", x: ox + 1 + k, y: oy + 3, zone: Zone.ComLight });
  }
  for (const c of cmds) engine.enqueue(c);
  engine.tick();
  return engine;
}

describe("simulation", () => {
  it("grows population when zoned land is powered and road-served", () => {
    const engine = foundCity(42);
    expect(engine.world.stats.population).toBe(0);
    engine.run(400);
    expect(engine.world.stats.population).toBeGreaterThan(0);
  });

  it("reports power supply from the coal plant", () => {
    const engine = foundCity(42);
    engine.run(5);
    expect(engine.world.stats.powerSupply).toBeGreaterThan(0);
  });

  it("stays deterministic with the full pass pipeline", () => {
    const a = foundCity(7);
    const b = foundCity(7);
    a.run(200);
    b.run(200);
    expect(hashWorld(a.world)).toBe(hashWorld(b.world));
  });
});

describe("save/load", () => {
  it("round-trips a simulated world to an identical hash", () => {
    const engine = foundCity(99);
    engine.run(150);
    const before = hashWorld(engine.world);

    const save = toSave(engine.world, "Testville", engine.seed);
    const { world } = fromSave(save);

    expect(hashWorld(world)).toBe(before);
  });
});
