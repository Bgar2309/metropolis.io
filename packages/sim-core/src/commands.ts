// Typed player commands. Every mutation to the world flows through a command so the
// ordered stream of commands (the "action log") is the single source of truth for
// save/replay/verification. Commands that cost money deduct from funds here and are
// rejected (no-op) when unaffordable, so the action log stays internally consistent.

import type { World } from "./world.js";
import { TILE_FREE } from "./world.js";
import { Net, Terrain, Under, Zone } from "./constants.js";
import { Build, getTile } from "./buildings.js";

export type TaxCat = "R" | "C" | "I";
export type ServiceKind = "police" | "fire";

export type Command =
  | { kind: "zone"; x: number; y: number; zone: number }
  | { kind: "bulldoze"; x: number; y: number }
  | { kind: "road"; x: number; y: number }
  | { kind: "powerline"; x: number; y: number }
  | { kind: "pipe"; x: number; y: number }
  | { kind: "placeBuilding"; x: number; y: number; build: number }
  | { kind: "setTax"; cat: TaxCat; rate: number }
  | { kind: "setFunding"; service: ServiceKind; level: number }
  | { kind: "setSpeed"; speed: number };

export interface LoggedCommand {
  tick: number;
  cmd: Command;
}

const COST_ZONE = 10;
const COST_ROAD = 10;
const COST_POWERLINE = 5;
const COST_PIPE = 5;
const COST_BULLDOZE = 1;

function afford(world: World, cost: number): boolean {
  if (world.stats.funds < cost) return false;
  world.stats.funds -= cost;
  return true;
}

// Apply a single command to the world. Pure with respect to wall-clock; only touches
// world state + the seeded rng. Returns true if the command changed anything.
export function applyCommand(world: World, cmd: Command): boolean {
  switch (cmd.kind) {
    case "zone": {
      if (!world.inBounds(cmd.x, cmd.y)) return false;
      const i = world.idx(cmd.x, cmd.y);
      if (world.terrain[i] === Terrain.Water) return false;
      if (world.zone[i] === cmd.zone || world.building[i] !== Build.None) return false;
      if (!afford(world, COST_ZONE)) return false;
      world.zone[i] = cmd.zone;
      world.stage[i] = 0;
      return true;
    }
    case "bulldoze": {
      if (!world.inBounds(cmd.x, cmd.y)) return false;
      const i = world.idx(cmd.x, cmd.y);
      const occupied = world.buildingOrigin[i] !== TILE_FREE;
      if (
        world.zone[i] === 0 &&
        world.building[i] === 0 &&
        world.net[i] === 0 &&
        world.under[i] === 0 &&
        !occupied
      )
        return false;
      if (!afford(world, COST_BULLDOZE)) return false;
      // A building footprint is cleared whole (from any of its tiles); everything else is a
      // plain single-tile clear.
      if (occupied) {
        world.clearBuilding(cmd.x, cmd.y);
      } else {
        world.zone[i] = Zone.None;
        world.building[i] = 0;
        world.stage[i] = 0;
      }
      world.net[i] = Net.None;
      world.under[i] = Under.None;
      return true;
    }
    case "road": {
      if (!world.inBounds(cmd.x, cmd.y)) return false;
      const i = world.idx(cmd.x, cmd.y);
      if (world.terrain[i] === Terrain.Water) return false;
      if (world.net[i]! & Net.Road) return false;
      if (!afford(world, COST_ROAD)) return false;
      world.net[i] = (world.net[i]! | Net.Road) & 0xff;
      return true;
    }
    case "powerline": {
      if (!world.inBounds(cmd.x, cmd.y)) return false;
      const i = world.idx(cmd.x, cmd.y);
      if (world.terrain[i] === Terrain.Water) return false;
      if (world.net[i]! & Net.PowerLine) return false;
      if (!afford(world, COST_POWERLINE)) return false;
      world.net[i] = (world.net[i]! | Net.PowerLine) & 0xff;
      return true;
    }
    case "pipe": {
      // Underground water main. Lives on the `under` layer (separate from the surface), so
      // it can coexist with a road or zone on the same tile. Mirrors powerline placement.
      if (!world.inBounds(cmd.x, cmd.y)) return false;
      const i = world.idx(cmd.x, cmd.y);
      if (world.terrain[i] === Terrain.Water) return false;
      if (world.under[i]! & Under.Pipe) return false;
      if (!afford(world, COST_PIPE)) return false;
      world.under[i] = (world.under[i]! | Under.Pipe) & 0xff;
      return true;
    }
    case "placeBuilding": {
      const def = getTile(cmd.build);
      if (!def || def.kind !== "building" || def.id === Build.None) return false;
      // canPlace enforces in-bounds, non-water, free, and flat across the whole footprint.
      if (!world.canPlace(cmd.x, cmd.y, def.footprint)) return false;
      if (!afford(world, def.cost)) return false;
      world.stampBuilding(cmd.x, cmd.y, def);
      return true;
    }
    case "setTax": {
      const r = Math.max(0, Math.min(20, cmd.rate)) | 0;
      if (cmd.cat === "R") world.policy.taxR = r;
      else if (cmd.cat === "C") world.policy.taxC = r;
      else world.policy.taxI = r;
      return true;
    }
    case "setFunding": {
      const l = Math.max(0, Math.min(100, cmd.level)) | 0;
      if (cmd.service === "police") world.policy.fundPolice = l;
      else world.policy.fundFire = l;
      return true;
    }
    case "setSpeed":
      // Engine-level; does not affect deterministic world state.
      return false;
  }
}
