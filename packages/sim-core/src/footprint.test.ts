import { describe, it, expect } from "vitest";
import { World, hashWorld, TILE_FREE } from "./world.js";
import { toSave, fromSave } from "./serialize.js";
import { Build } from "./buildings.js";
import { Terrain } from "./constants.js";

// A synthetic 4x4 power plant. The shipped registry entries are all 1x1, so we exercise
// the footprint machinery directly with a def whose footprint matches SC2K's big plants.
const PLANT_4X4 = { id: Build.CoalPlant, footprint: { w: 4, h: 4 } };

// Fresh world starts as flat, dry land (terrain 0 = Land, altitude 0) with every tile free.
function flatWorld(size = 8): World {
  return new World(size, size, 1);
}

function occupiedCount(world: World): number {
  let n = 0;
  for (let i = 0; i < world.size; i++) if (world.buildingOrigin[i] !== TILE_FREE) n++;
  return n;
}

describe("multi-tile footprints", () => {
  it("stamps a 4x4 plant over exactly 16 tiles, id on the origin only", () => {
    const world = flatWorld();
    expect(world.canPlace(2, 2, PLANT_4X4.footprint)).toBe(true);
    world.stampBuilding(2, 2, PLANT_4X4);

    const origin = world.idx(2, 2);
    expect(occupiedCount(world)).toBe(16);
    // Every covered tile points back to the origin; only the origin carries the catalog id.
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        const i = world.idx(2 + dx, 2 + dy);
        expect(world.buildingOrigin[i]).toBe(origin);
        expect(world.building[i]).toBe(dx === 0 && dy === 0 ? Build.CoalPlant : 0);
      }
    }
  });

  it("bulldozing from any tile of the footprint frees all 16", () => {
    const world = flatWorld();
    world.stampBuilding(2, 2, PLANT_4X4);
    expect(occupiedCount(world)).toBe(16);

    // Clear from an interior, non-origin tile.
    expect(world.clearBuilding(4, 5)).toBe(true);
    expect(occupiedCount(world)).toBe(0);
    for (let i = 0; i < world.size; i++) {
      expect(world.buildingOrigin[i]).toBe(TILE_FREE);
      expect(world.building[i]).toBe(0);
    }
    // Nothing left to clear.
    expect(world.clearBuilding(2, 2)).toBe(false);
  });

  it("refuses placement that overlaps an existing footprint", () => {
    const world = flatWorld();
    world.stampBuilding(0, 0, PLANT_4X4);
    // (2,2) overlaps the (0,0)-(3,3) plant.
    expect(world.canPlace(2, 2, PLANT_4X4.footprint)).toBe(false);
    // A clear, non-overlapping spot is still allowed.
    expect(world.canPlace(4, 4, PLANT_4X4.footprint)).toBe(true);
  });

  it("refuses placement on uneven altitude", () => {
    const world = flatWorld();
    // Raise one tile inside the would-be footprint.
    world.altitude[world.idx(3, 3)] = 5;
    expect(world.canPlace(2, 2, PLANT_4X4.footprint)).toBe(false);
    // Leveling it back makes the patch buildable again.
    world.altitude[world.idx(3, 3)] = 0;
    expect(world.canPlace(2, 2, PLANT_4X4.footprint)).toBe(true);
  });

  it("refuses placement on water or out of bounds", () => {
    const world = flatWorld();
    world.terrain[world.idx(3, 2)] = Terrain.Water;
    expect(world.canPlace(2, 2, PLANT_4X4.footprint)).toBe(false);
    // Off the edge.
    expect(world.canPlace(6, 6, PLANT_4X4.footprint)).toBe(false);
  });

  it("survives a save/load round-trip with an identical hash", () => {
    const world = flatWorld();
    world.stampBuilding(1, 1, PLANT_4X4);
    const before = hashWorld(world);

    const save = toSave(world, "Footprintville", 1);
    const { world: loaded } = fromSave(save);

    expect(hashWorld(loaded)).toBe(before);
    expect(occupiedCount(loaded)).toBe(16);
    expect(loaded.building[loaded.idx(1, 1)]).toBe(Build.CoalPlant);
  });
});
