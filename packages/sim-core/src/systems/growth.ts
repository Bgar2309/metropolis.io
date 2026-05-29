// Zone growth/decline. Every zoned tile scores its desirability from demand, land value,
// pollution (R/C only), power, and nearby road access, then probabilistically grows or
// shrinks a development stage. The probability scales with the score so good lots boom
// and bad lots decay. All randomness comes from the seeded world RNG (deterministic).

import type { SimPass, SimContext } from "../engine.js";
import type { World } from "../world.js";
import { Net } from "../constants.js";
import { zoneCapacity } from "../buildings.js";

const ROAD_REACH = 3;

function hasRoadNear(world: World, x: number, y: number): boolean {
  for (let dy = -ROAD_REACH; dy <= ROAD_REACH; dy++) {
    for (let dx = -ROAD_REACH; dx <= ROAD_REACH; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= world.width || ny >= world.height) continue;
      if (world.net[ny * world.width + nx]! & Net.Road) return true;
    }
  }
  return false;
}

export class GrowthSystem implements SimPass {
  readonly name = "growth";

  update({ world }: SimContext): void {
    const { width, height } = world;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const z = zoneCapacity(world.zone[i]!);
        if (!z) continue;

        const demand =
          z.cat === "R" ? world.stats.rDemand : z.cat === "C" ? world.stats.cDemand : world.stats.iDemand;
        const lv = world.landValue[i]! / 255;
        const powered = world.power[i]! === 1;
        const road = hasRoadNear(world, x, y);

        let score = demand * 0.6 + (lv - 0.35);
        if (z.cat !== "I") score -= (world.pollution[i]! / 255) * 0.5;
        if (!road) score -= 0.6;
        if (!powered) score -= 1.0;

        const stage = world.stage[i]!;
        if (score > 0.1 && stage < z.maxStage) {
          if (world.rng.chance(0.06 + score * 0.12)) world.stage[i] = stage + 1;
        } else if (score < -0.1 && stage > 0) {
          if (world.rng.chance(0.05 - score * 0.12)) world.stage[i] = stage - 1;
        }
      }
    }
  }
}
