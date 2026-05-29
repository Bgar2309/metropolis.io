// Structure-of-Arrays world model. Every per-tile field is its own flat typed array
// indexed by (y * width + x). SoA keeps each simulation pass cache-friendly and makes
// the whole world trivially serializable (just the buffers + a few scalars).

import { Rng } from "./rng.js";
import {
  Terrain,
  Zone,
  Net,
  Under,
  SEA_LEVEL,
  START_FUNDS,
  START_YEAR,
} from "./constants.js";

export interface WorldStats {
  population: number;
  jobs: number;
  funds: number;
  // City-wide aggregates surfaced to the UI; filled in by sim passes.
  rDemand: number; // -1..1
  cDemand: number;
  iDemand: number;
  powerSupply: number;
  powerDemand: number;
  brownout: boolean;
  lastIncome: number; // last monthly budget cycle
  lastExpense: number;
}

// Player-set policy that feeds the simulation, so it lives in the (serialized,
// deterministic) world state and every change flows through a logged command.
export interface Policy {
  taxR: number; // percent 0..20
  taxC: number;
  taxI: number;
  fundPolice: number; // percent 0..100
  fundFire: number;
}

export interface CityClock {
  tick: number; // monotonically increasing simulation tick
}

export class World {
  readonly width: number;
  readonly height: number;
  readonly size: number;

  // --- terrain layer ---
  readonly terrain: Uint8Array; // TerrainType
  readonly altitude: Uint8Array; // 0..ALTITUDE_MAX

  // --- surface layer ---
  readonly zone: Uint8Array; // ZoneType
  readonly building: Uint16Array; // building catalog id (0 = none)
  readonly stage: Uint8Array; // building growth stage 0..n
  readonly net: Uint8Array; // Net bitfield

  // --- underground layer ---
  readonly under: Uint8Array; // Under bitfield

  // --- simulation fields (0..255) ---
  readonly landValue: Uint8Array;
  readonly pollution: Uint8Array;
  readonly crime: Uint8Array;
  readonly traffic: Uint8Array;
  readonly power: Uint8Array; // powered level (0 = unpowered)
  readonly water: Uint8Array; // watered level
  readonly policeCov: Uint8Array; // police coverage field
  readonly fireCov: Uint8Array; // fire coverage field

  rng: Rng;
  readonly clock: CityClock;
  readonly stats: WorldStats;
  readonly policy: Policy;

  constructor(width: number, height: number, seed: number) {
    this.width = width;
    this.height = height;
    this.size = width * height;

    const n = this.size;
    this.terrain = new Uint8Array(n);
    this.altitude = new Uint8Array(n);
    this.zone = new Uint8Array(n);
    this.building = new Uint16Array(n);
    this.stage = new Uint8Array(n);
    this.net = new Uint8Array(n);
    this.under = new Uint8Array(n);
    this.landValue = new Uint8Array(n);
    this.pollution = new Uint8Array(n);
    this.crime = new Uint8Array(n);
    this.traffic = new Uint8Array(n);
    this.power = new Uint8Array(n);
    this.water = new Uint8Array(n);
    this.policeCov = new Uint8Array(n);
    this.fireCov = new Uint8Array(n);

    this.rng = new Rng(seed);
    this.clock = { tick: 0 };
    this.stats = {
      population: 0,
      jobs: 0,
      funds: START_FUNDS,
      rDemand: 0,
      cDemand: 0,
      iDemand: 0,
      powerSupply: 0,
      powerDemand: 0,
      brownout: false,
      lastIncome: 0,
      lastExpense: 0,
    };
    this.policy = { taxR: 7, taxC: 7, taxI: 7, fundPolice: 100, fundFire: 100 };
  }

  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }
}

// Phase-0 terrain generator: deterministic value-noise heightfield. Anything below
// SEA_LEVEL becomes water, the band just above becomes shore, a noise channel scatters
// forest. Replaced/augmented by the full terrain editor + generator in Phase 3.
export function generateTerrain(world: World, seed: number): void {
  const noise = makeValueNoise(seed);
  const { width, height } = world;
  const scale = 0.06;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = world.idx(x, y);
      const h = noise(x * scale, y * scale); // 0..1
      const alt = Math.round(h * 14) + 1; // keep most land low and buildable
      world.altitude[i] = alt;

      if (alt <= SEA_LEVEL) {
        world.terrain[i] = Terrain.Water;
      } else if (alt === SEA_LEVEL + 1) {
        world.terrain[i] = Terrain.Shore;
      } else {
        const forest = noise(x * 0.12 + 100, y * 0.12 + 100);
        world.terrain[i] = forest > 0.62 ? Terrain.Forest : Terrain.Land;
      }
    }
  }
}

// Tiny deterministic value-noise built on the seeded Rng. Precomputes a lattice of
// random values and bilinearly interpolates with a smoothstep fade.
function makeValueNoise(seed: number): (x: number, y: number) => number {
  const gridSize = 64;
  const rng = new Rng(seed ^ 0x1234567);
  const lattice = new Float64Array(gridSize * gridSize);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();

  const at = (xi: number, yi: number): number => {
    const xx = ((xi % gridSize) + gridSize) % gridSize;
    const yy = ((yi % gridSize) + gridSize) % gridSize;
    return lattice[yy * gridSize + xx]!;
  };
  const fade = (t: number): number => t * t * (3 - 2 * t);

  return (x: number, y: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = fade(x - x0);
    const fy = fade(y - y0);
    const v00 = at(x0, y0);
    const v10 = at(x0 + 1, y0);
    const v01 = at(x0, y0 + 1);
    const v11 = at(x0 + 1, y0 + 1);
    const top = v00 + (v10 - v00) * fx;
    const bottom = v01 + (v11 - v01) * fx;
    return top + (bottom - top) * fy;
  };
}

// FNV-1a hash over all packed buffers + scalar state. Used by determinism tests and as
// a cheap integrity check for saves / ranked verification.
export function hashWorld(world: World): number {
  let h = 0x811c9dc5;
  const mix = (arr: Uint8Array | Uint16Array): void => {
    for (let i = 0; i < arr.length; i++) {
      h ^= arr[i]!;
      h = Math.imul(h, 0x01000193);
    }
  };
  mix(world.terrain);
  mix(world.altitude);
  mix(world.zone);
  mix(world.building);
  mix(world.stage);
  mix(world.net);
  mix(world.under);
  mix(world.landValue);
  mix(world.pollution);
  mix(world.crime);
  mix(world.traffic);
  mix(world.power);
  mix(world.water);
  mix(world.policeCov);
  mix(world.fireCov);
  // Note: population/jobs/demands are derived caches recomputed every tick, so they are
  // intentionally excluded — the hash covers canonical state (grid + funds + policy +
  // tick + rng) only, which keeps save/load round-trips exact.
  for (const v of [
    world.clock.tick,
    world.stats.funds,
    world.policy.taxR,
    world.policy.taxC,
    world.policy.taxI,
    world.policy.fundPolice,
    world.policy.fundFire,
    world.rng.getState(),
  ]) {
    h ^= v | 0;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Re-export so callers can `import { Net, Under } from "./world.js"` conveniently.
export { Terrain, Zone, Net, Under, START_YEAR };
