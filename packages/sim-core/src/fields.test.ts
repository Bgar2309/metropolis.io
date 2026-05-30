import { describe, it, expect } from "vitest";
import { World, hashWorld } from "./world.js";
import { FieldsSystem } from "./systems/fields.js";
import { Zone } from "./constants.js";
import { Build } from "./buildings.js";

// Run the fields pass once over a freshly-built world. Terrain defaults to all-land, so
// land value isn't perturbed by water unless a test adds some.
function runFields(world: World, tick = 1): void {
  new FieldsSystem().update({ world, tick });
}

describe("fields: pollution gaussian diffusion", () => {
  it("falls off with distance and weights orthogonal neighbors above diagonal ones", () => {
    const world = new World(21, 21, 1);
    const cx = 10;
    const cy = 10;
    // A single strong point source at the center (coal plant, pollution 60). The source
    // is deliberately large so the gaussian shape survives integer field quantization.
    world.building[world.idx(cx, cy)] = Build.CoalPlant;

    runFields(world);

    const at = (x: number, y: number): number => world.pollution[world.idx(x, y)]!;
    const center = at(cx, cy);
    const ortho = at(cx + 1, cy); // weight 2 in the [1,2,1]x[1,2,1] kernel
    const diag = at(cx + 1, cy + 1); // weight 1
    const far = at(cx + 4, cy);

    expect(center).toBeGreaterThan(0);
    // Monotone falloff away from the source.
    expect(center).toBeGreaterThan(ortho);
    expect(ortho).toBeGreaterThan(far);
    // The gaussian weighting is the whole point: an orthogonal neighbor receives more
    // than a diagonal one at the same chebyshev distance. A uniform box blur would tie.
    expect(ortho).toBeGreaterThan(diag);
  });
});

describe("fields: emergent downtown land value", () => {
  it("values a tile by clustered population, not just the geometric center", () => {
    const world = new World(40, 40, 2);

    // Dense residential cluster tucked into a corner, far from the map center.
    for (let y = 3; y < 9; y++) {
      for (let x = 3; x < 9; x++) {
        world.zone[world.idx(x, y)] = Zone.ResDense;
        world.stage[world.idx(x, y)] = 6;
      }
    }

    runFields(world);

    const nearDowntown = world.landValue[world.idx(6, 6)]!; // inside the cluster
    const geometricCenter = world.landValue[world.idx(20, 20)]!; // empty map midpoint

    // The organic downtown outvalues the bare geometric center.
    expect(nearDowntown).toBeGreaterThan(geometricCenter);
    expect(nearDowntown).toBeGreaterThan(100);
  });
});

describe("fields: crime fiscal drag", () => {
  it("drags land value down where crime is high (head of the revenue loop)", () => {
    const build = (crimeSeed: number): number => {
      const world = new World(20, 20, 3);
      // Two identical residential lots; one carries last tick's crime, the other none.
      world.zone[world.idx(5, 5)] = Zone.ResLight;
      world.stage[world.idx(5, 5)] = 3;
      world.crime[world.idx(5, 5)] = crimeSeed;
      runFields(world);
      return world.landValue[world.idx(5, 5)]!;
    };

    const clean = build(0);
    const criminal = build(200);

    // Higher inbound crime -> lower land value -> (downstream) less growth -> less tax.
    expect(criminal).toBeLessThan(clean);
  });
});

describe("fields: determinism", () => {
  it("produces an identical world hash for identical inputs", () => {
    const make = (): World => {
      const world = new World(24, 24, 9);
      for (let k = 0; k < 6; k++) {
        world.zone[world.idx(5 + k, 8)] = Zone.ResLight;
        world.stage[world.idx(5 + k, 8)] = 2;
        world.zone[world.idx(5 + k, 12)] = Zone.IndLight;
        world.stage[world.idx(5 + k, 12)] = 3;
      }
      runFields(world);
      return world;
    };
    expect(hashWorld(make())).toBe(hashWorld(make()));
  });

  it("reuses its scratch buffers across ticks without diverging between instances", () => {
    // Two independent system instances, each driven over the same multi-tick sequence on
    // an identical world, must agree tick-for-tick. (Crime carries a one-tick lag into
    // land value, so the world legitimately keeps evolving — the point is that buffer
    // reuse introduces no state leak: same inputs => same hash.)
    const drive = (): number => {
      const world = new World(16, 16, 4);
      world.zone[world.idx(8, 8)] = Zone.IndLight;
      world.stage[world.idx(8, 8)] = 2;
      world.zone[world.idx(4, 4)] = Zone.ResLight;
      world.stage[world.idx(4, 4)] = 3;
      const system = new FieldsSystem();
      for (let t = 1; t <= 5; t++) system.update({ world, tick: t });
      return hashWorld(world);
    };
    expect(drive()).toBe(drive());
  });
});
