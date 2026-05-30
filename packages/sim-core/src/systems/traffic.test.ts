import { describe, it, expect } from "vitest";
import { World } from "../world.js";
import { Zone, Net } from "../constants.js";
import { TrafficSystem } from "./traffic.js";
import { GrowthSystem } from "./growth.js";

// Lay a straight road and call TrafficSystem once. Returns the world so tests can read
// the resulting traffic field. Layout (y grows downward):
//
//   row 3:  R . . . J      <- residential lot (left), job lot (right)
//   row 4:  = = = = =      <- road corridor connecting their access points
//
function commuteWorld(seed: number): { world: World; road: number[] } {
  const world = new World(8, 8, seed);
  const road: number[] = [];
  for (let x = 1; x <= 5; x++) {
    const i = world.idx(x, 4);
    world.net[i] = Net.Road;
    road.push(i);
  }
  // Developed residential lot beside the left end of the road.
  const r = world.idx(1, 3);
  world.zone[r] = Zone.ResLight;
  world.stage[r] = 2;
  // Developed commercial (employment) lot beside the right end.
  const j = world.idx(5, 3);
  world.zone[j] = Zone.ComLight;
  world.stage[j] = 2;
  return { world, road };
}

describe("traffic", () => {
  it("loads the road corridor that links homes to jobs", () => {
    const { world, road } = commuteWorld(1);
    new TrafficSystem().update({ world, tick: 1 });

    // Every road tile on the only path between the two lots carries traffic.
    for (const i of road) expect(world.traffic[i]!).toBeGreaterThan(0);
    // Non-road tiles (the zoned lots themselves) carry none.
    expect(world.traffic[world.idx(1, 3)]!).toBe(0);
    expect(world.traffic[world.idx(5, 3)]!).toBe(0);
  });

  it("produces no traffic when no job is reachable", () => {
    const { world } = commuteWorld(1);
    // Demote the employer back to vacant land: nothing to commute to.
    world.zone[world.idx(5, 3)] = Zone.None;
    world.stage[world.idx(5, 3)] = 0;
    new TrafficSystem().update({ world, tick: 1 });
    for (let i = 0; i < world.size; i++) expect(world.traffic[i]!).toBe(0);
  });

  it("is deterministic for an identical world", () => {
    const a = commuteWorld(7);
    const b = commuteWorld(7);
    new TrafficSystem().update({ world: a.world, tick: 1 });
    new TrafficSystem().update({ world: b.world, tick: 1 });
    expect([...a.world.traffic]).toEqual([...b.world.traffic]);
  });
});

// Build a single residential lot that is powered, road-served, and in demand — primed to
// grow — then run only the growth pass with a chosen congestion level baked into the road.
function growableLot(seed: number, roadTraffic: number): { world: World; lot: number } {
  const world = new World(8, 8, seed);
  const lot = world.idx(2, 2);
  world.zone[lot] = Zone.ResLight;
  world.stage[lot] = 0;
  world.power[lot] = 1;
  world.landValue[lot] = 120;

  // Surround the lot with roads carrying the requested traffic level.
  for (const [dx, dy] of [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ] as const) {
    const i = world.idx(2 + dx, 2 + dy);
    world.net[i] = Net.Road;
    world.traffic[i] = roadTraffic;
  }

  // Modest, fixed demand so a clear road grows the lot while a saturated one cannot.
  world.stats.rDemand = 0.3;
  return { world, lot };
}

describe("growth vs congestion", () => {
  it("freezes growth on a saturated road but lets a clear one develop", () => {
    const growth = new GrowthSystem();

    const clear = growableLot(123, 0);
    const jammed = growableLot(123, 255);
    for (let t = 0; t < 300; t++) {
      growth.update({ world: clear.world, tick: t });
      growth.update({ world: jammed.world, tick: t });
    }

    const clearStage = clear.world.stage[clear.lot]!;
    const jammedStage = jammed.world.stage[jammed.lot]!;

    // The free-flowing lot develops; the gridlocked one is held back.
    expect(clearStage).toBeGreaterThan(0);
    expect(jammedStage).toBeLessThan(clearStage);
    // Saturation here is total, so the jammed lot never gets off the ground.
    expect(jammedStage).toBe(0);
  });
});
