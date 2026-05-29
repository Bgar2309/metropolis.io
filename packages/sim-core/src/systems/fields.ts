// Spatial fields: pollution, police/fire coverage, land value, crime. Computed once per
// tick in dependency order (pollution -> coverage -> land value -> crime). Land value
// reads this tick's pollution + last tick's crime (a one-tick lag, which is fine and
// keeps the pass single-sweep and deterministic).

import type { SimPass, SimContext } from "../engine.js";
import type { World } from "../world.js";
import { Terrain } from "../constants.js";
import { Build, getStructure, zoneCapacity } from "../buildings.js";

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
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

  private pollutionSrc = new Float32Array(0);
  private pollutionBuf = new Float32Array(0);
  private amenity = new Float32Array(0);

  private ensure(size: number): void {
    if (this.pollutionSrc.length !== size) {
      this.pollutionSrc = new Float32Array(size);
      this.pollutionBuf = new Float32Array(size);
      this.amenity = new Float32Array(size);
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
    // diffuse: two 3x3 box-blur iterations
    let a = this.pollutionSrc;
    let b = this.pollutionBuf;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let sum = 0;
          let cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              sum += a[ny * width + nx]!;
              cnt++;
            }
          }
          b[y * width + x] = (sum / cnt) * 0.92;
        }
      }
      const t = a;
      a = b;
      b = t;
    }
    for (let i = 0; i < size; i++) world.pollution[i] = clamp255(a[i]!);

    // --- coverage (police, fire) + amenity (parks) ---
    const polF = new Float32Array(size);
    const fireF = new Float32Array(size);
    this.amenity.fill(0);
    const fp = world.policy.fundPolice / 100;
    const ff = world.policy.fundFire / 100;
    for (let i = 0; i < size; i++) {
      const bld = world.building[i]!;
      if (bld === Build.None) continue;
      const def = getStructure(bld);
      const cx = i % width;
      const cy = (i / width) | 0;
      if (bld === Build.Police) stamp(polF, world, cx, cy, def.coverage, fp);
      else if (bld === Build.Fire) stamp(fireF, world, cx, cy, def.coverage, ff);
      else if (bld === Build.Park) stamp(this.amenity, world, cx, cy, def.coverage, 1);
    }
    for (let i = 0; i < size; i++) {
      world.policeCov[i] = clamp255(polF[i]!);
      world.fireCov[i] = clamp255(fireF[i]!);
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
        let v = 110 * (1 - (dist / maxDist) * 0.55);
        if (this.nearWater(world, x, y)) v += 28;
        v += this.amenity[i]! * 0.4;
        v += (world.policeCov[i]! + world.fireCov[i]!) * 0.05;
        v -= world.pollution[i]! * 0.5;
        v -= world.crime[i]! * 0.25;
        world.landValue[i] = clamp255(v);
      }
    }

    // --- crime ---
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
