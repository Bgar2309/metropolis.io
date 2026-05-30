// Spatial fields: pollution, police/fire coverage, land value, crime. Computed once per
// tick in dependency order (pollution -> coverage -> downtown density -> land value ->
// crime). Land value reads this tick's pollution/coverage/density + last tick's crime (a
// one-tick lag on crime only, which keeps the pass single-sweep and deterministic).
//
// Refinements over the naive version:
//   (a) pollution diffuses with a gaussian-weighted 3x3 kernel (a smooth bell falloff)
//       rather than a flat box-blur, so plumes thin out realistically with distance.
//   (b) land value blends a weak geometric-center pull with the *emergent* downtown:
//       a diffused field of residential population density, so value rises where people
//       actually cluster, not just at the map's midpoint.
//   (c) crime feeds the fiscal loop. See the crime block at the bottom for the chain.
//
// All work reuses preallocated buffers (see `ensure`) — no per-tick allocation.

import type { SimPass, SimContext } from "../engine.js";
import type { World } from "../world.js";
import { Terrain } from "../constants.js";
import { Build, getStructure, zoneCapacity, tileOccupancy } from "../buildings.js";

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

// Separable 3x3 gaussian ([1,2,1] x [1,2,1]). Used for both pollution and population
// density so diffusion has a smooth bell shape instead of a flat box average.
const GAUSS_KERNEL = [1, 2, 1, 2, 4, 2, 1, 2, 1];

// One gaussian blur pass from `src` into `dst`, scaled by `decay` (1 = mass-fair spread,
// <1 = the field also fades each pass, e.g. pollution dissipating). Each cell is
// normalized by the in-bounds weight sum, so borders stay stable without wrap-around and
// the pass is fully deterministic.
function gaussianPass(
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  decay: number,
): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let wsum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const w = GAUSS_KERNEL[(dy + 1) * 3 + (dx + 1)]!;
          sum += src[ny * width + nx]! * w;
          wsum += w;
        }
      }
      dst[y * width + x] = (sum / wsum) * decay;
    }
  }
}

// Stamp a radial falloff (euclidean) into `field`, scaled 0..1 by `intensity`.
function stamp(field: Float32Array, world: World, cx: number, cy: number, radius: number, intensity: number): void {
  const r2 = radius * radius;
  const minX = Math.max(0, cx - radius);
  const maxX = Math.min(world.width - 1, cx + radius);
  const minY = Math.max(0, cy - radius);
  const maxY = Math.min(world.height - 1, cy + radius);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const f = (1 - Math.sqrt(d2) / radius) * intensity;
      field[y * world.width + x]! += f * 255;
    }
  }
}

export class FieldsSystem implements SimPass {
  readonly name = "fields";

  // All scratch buffers are allocated once (when the grid size changes) and reused every
  // tick, so the per-tick hot path never allocates.
  private pollutionSrc = new Float32Array(0);
  private pollutionBuf = new Float32Array(0);
  private amenity = new Float32Array(0);
  private polBuf = new Float32Array(0);
  private fireBuf = new Float32Array(0);
  private densitySrc = new Float32Array(0);
  private densityBuf = new Float32Array(0);

  private ensure(size: number): void {
    if (this.pollutionSrc.length !== size) {
      this.pollutionSrc = new Float32Array(size);
      this.pollutionBuf = new Float32Array(size);
      this.amenity = new Float32Array(size);
      this.polBuf = new Float32Array(size);
      this.fireBuf = new Float32Array(size);
      this.densitySrc = new Float32Array(size);
      this.densityBuf = new Float32Array(size);
    }
  }

  update({ world }: SimContext): void {
    const { size, width, height } = world;
    this.ensure(size);

    // --- pollution sources: industry buildings + power plants ---
    this.pollutionSrc.fill(0);
    for (let i = 0; i < size; i++) {
      const z = zoneCapacity(world.zone[i]!);
      if (z && z.cat === "I") this.pollutionSrc[i]! += world.stage[i]! * 6;
      const b = world.building[i]!;
      if (b !== Build.None) this.pollutionSrc[i]! += getStructure(b).pollution;
    }
    // diffuse: two gaussian passes that also fade (decay 0.92) as the plume spreads.
    let a = this.pollutionSrc;
    let b = this.pollutionBuf;
    for (let pass = 0; pass < 2; pass++) {
      gaussianPass(a, b, width, height, 0.92);
      const t = a;
      a = b;
      b = t;
    }
    for (let i = 0; i < size; i++) world.pollution[i] = clamp255(a[i]!);

    // --- coverage (police, fire) + amenity (parks) ---
    this.polBuf.fill(0);
    this.fireBuf.fill(0);
    this.amenity.fill(0);
    const fp = world.policy.fundPolice / 100;
    const ff = world.policy.fundFire / 100;
    for (let i = 0; i < size; i++) {
      const bld = world.building[i]!;
      if (bld === Build.None) continue;
      const def = getStructure(bld);
      const cx = i % width;
      const cy = (i / width) | 0;
      if (bld === Build.Police) stamp(this.polBuf, world, cx, cy, def.coverage, fp);
      else if (bld === Build.Fire) stamp(this.fireBuf, world, cx, cy, def.coverage, ff);
      else if (bld === Build.Park) stamp(this.amenity, world, cx, cy, def.coverage, 1);
    }
    for (let i = 0; i < size; i++) {
      world.policeCov[i] = clamp255(this.polBuf[i]!);
      world.fireCov[i] = clamp255(this.fireBuf[i]!);
    }

    // --- emergent downtown: diffused residential population density ---
    // Seed each tile with its residential occupancy, then diffuse it so a tile's value
    // reflects how much population clusters *around* it. The hottest spot of this field
    // is the city's organic center of gravity, wherever residents actually settled.
    this.densitySrc.fill(0);
    for (let i = 0; i < size; i++) {
      const z = zoneCapacity(world.zone[i]!);
      if (z && z.cat === "R" && world.stage[i]! > 0) {
        this.densitySrc[i] = tileOccupancy(world.zone[i]!, world.stage[i]!);
      }
    }
    // Mass-fair spread (decay 1): three passes give roughly a 3-tile neighborhood reach.
    let da = this.densitySrc;
    let db = this.densityBuf;
    for (let pass = 0; pass < 3; pass++) {
      gaussianPass(da, db, width, height, 1);
      const t = da;
      da = db;
      db = t;
    }

    // --- land value ---
    const cx = width / 2;
    const cy = height / 2;
    const maxDist = Math.sqrt(cx * cx + cy * cy);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (world.terrain[i] === Terrain.Water) {
          world.landValue[i] = 0;
          continue;
        }
        const dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
        // Geometric baseline: a mild pull toward the map center. Kept strong enough to
        // bootstrap an empty map (the first lots need *some* value to start developing)...
        let v = 110 * (1 - (dist / maxDist) * 0.55);
        // ...but the emergent downtown is layered on top: proximity to clustered
        // population raises value where the city actually grows, not just at the midpoint.
        v += Math.min(da[i]! * 0.5, 95);
        if (this.nearWater(world, x, y)) v += 28;
        v += this.amenity[i]! * 0.4;
        v += (world.policeCov[i]! + world.fireCov[i]!) * 0.05;
        v -= world.pollution[i]! * 0.5;
        // Crime drags value down (last tick's crime, one-tick lag). This is the head of
        // the fiscal chain documented in the crime block below.
        v -= world.crime[i]! * 0.3;
        world.landValue[i] = clamp255(v);
      }
    }

    // --- crime ---
    // Crime's fiscal effect (the requested "crime nuit à la fiscalité" / revenue drag) is
    // modeled as a feedback loop rather than a direct treasury hit, so it stays entirely
    // within the fields pass and remains deterministic:
    //
    //   crime ↑  ->  land value ↓ (the `v -= crime * 0.3` term above, one-tick lag)
    //           ->  growth score ↓ (GrowthSystem reads landValue)
    //           ->  development stage ↓  ->  tile occupancy ↓
    //           ->  taxable population/jobs ↓  ->  BudgetSystem income ↓.
    //
    // So a crime-ridden district slowly de-develops, shrinking the tax base and the
    // monthly income reported by the budget — without fields.ts ever touching funds.
    for (let i = 0; i < size; i++) {
      const z = zoneCapacity(world.zone[i]!);
      if (!z || world.stage[i]! === 0) {
        world.crime[i] = 0;
        continue;
      }
      let c = world.stage[i]! * 5;
      c += (255 - world.landValue[i]!) * 0.15;
      c -= world.policeCov[i]! * fp;
      world.crime[i] = clamp255(c);
    }
  }

  private nearWater(world: World, x: number, y: number): boolean {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= world.width || ny >= world.height) continue;
        if (world.terrain[ny * world.width + nx] === Terrain.Water) return true;
      }
    }
    return false;
  }
}
