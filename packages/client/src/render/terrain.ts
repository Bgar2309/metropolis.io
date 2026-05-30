// Terrain painter for the sprite renderer. Owns everything that draws the ground plane:
// slopes, coasts, and animated water. Split out of spriteRenderer.ts so the (static, rich)
// terrain logic doesn't crowd the per-tick surface/pooling code.
//
// Two render paths share one analysis pass:
//   - ATLAS: if `terrain_<mask>` frames are loaded (coast mask, N=1/E=2/S=4/W=8 — see
//     assets/README.md §3.1) we place one sprite per tile from the packed art.
//   - PROCEDURAL (default, since the shipped atlas is empty): we synthesize the ground as a
//     seamless mesh of shaded diamonds drawn into a few Graphics layers.
//
// SLOPES (the SC2K "16 cases"): altitude is per-tile, but a tile has four *corners*, each
// shared with its diagonal/orthogonal neighbours. We derive a per-vertex height field
// (average of the up-to-4 tiles meeting at that vertex) so adjacent tiles agree exactly on
// shared corners — the mesh is gap-free and slopes read continuously. Each tile's four
// corner heights (top/right/bottom/left) place its diamond; their relative ordering is the
// 4-corner case that drives slope shading under a fixed top-left light.
//
// COASTS: a land tile facing water on one of its four edges gets a sand/foam fringe along
// that edge; water shallows next to land are lightened. Because land and water sample the
// same vertex field, the shoreline is exact.
//
// WATER ANIMATION: water tiles are spread across a handful of diagonal "bands", each its own
// Graphics drawn once in greyscale (encoding depth). Per frame we only set each band's
// `tint` to a slowly phase-shifted blue — a gentle diagonal shimmer at O(bands) cost, no
// geometry rebuild and nothing touched in the simulation.

import { Container, Graphics, Sprite, type Texture } from "pixi.js";
import { TILE_W, TILE_H, ALT_STEP, tileToScreen } from "../iso.js";

const Terrain = { Land: 0, Water: 1, Shore: 2, Forest: 3 } as const;

const TERRAIN_COLOR: Record<number, number> = {
  [Terrain.Land]: 0x5a8f4a,
  [Terrain.Water]: 0x2f6f9f,
  [Terrain.Shore]: 0xc2b280,
  [Terrain.Forest]: 0x2f6b34,
};

const SEA_LEVEL = 4; // mirrors sim-core constants; tiles with alt <= SEA_LEVEL are water
const FOAM_COLOR = 0xe6dcae; // bright wet sand at the waterline
const SAND_COLOR = 0xcdbf8a; // drier sand just inland of the foam

// Water shimmer endpoints — kept close to TERRAIN_COLOR[Water] so the motion is subtle.
const WATER_DEEP = 0x29618f;
const WATER_BRIGHT = 0x3f86b3;
const WATER_BANDS = 6; // diagonal phase buckets; per-frame cost is one tint each
const WATER_SPEED = 0.0016; // radians/ms of the shimmer phase

type U8 = Uint8Array<ArrayBufferLike>;

function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.max(0, ((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.max(0, ((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.max(0, (color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff,
    ag = (a >> 8) & 0xff,
    ab = a & 0xff;
  const br = (b >> 16) & 0xff,
    bg = (b >> 8) & 0xff,
    bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

interface Pt {
  x: number;
  y: number;
}
const lerpPt = (p: Pt, q: Pt, t: number): Pt => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });

export class TerrainPainter {
  private readonly waterBands: Graphics[] = [];
  private readonly landG = new Graphics();
  private readonly atlasContainer = new Container();
  private readonly spritePool: Sprite[] = [];
  private readonly atlasWaterIdx: number[] = []; // sprite-pool indices of water tiles

  // coast-mask (0..15) -> atlas texture; null = procedural path.
  private atlasFrames: Map<number, Texture> | null = null;
  private hasWater = false;

  constructor(private readonly layer: Container) {
    // Water under land so beaches/foam composite on top of the sea; bands first.
    for (let b = 0; b < WATER_BANDS; b++) {
      const g = new Graphics();
      this.waterBands.push(g);
      this.layer.addChild(g);
    }
    this.layer.addChild(this.landG, this.atlasContainer);
  }

  // Swap in packed coast-mask art (or null to force the procedural path). Rebuild happens on
  // the next build() call.
  setAtlasFrames(frames: Map<number, Texture> | null): void {
    this.atlasFrames = frames && frames.size > 0 ? frames : null;
  }

  // (Re)build the static ground for a snapshot. Cheap enough to run once per snapshot.
  build(width: number, height: number, terrain: U8, altitude: U8): void {
    const vh = this.vertexHeights(width, height, altitude);
    if (this.atlasFrames) this.buildAtlas(width, height, terrain, altitude, vh);
    else this.buildProcedural(width, height, terrain, altitude, vh);
  }

  // Per-frame water shimmer: only band tints change (no geometry work). `t` is elapsed ms.
  animate(t: number): void {
    if (!this.hasWater || this.atlasFrames) {
      // Atlas water (if any) is animated per-sprite in animateAtlas instead.
      if (this.atlasFrames) this.animateAtlas(t);
      return;
    }
    for (let b = 0; b < WATER_BANDS; b++) {
      const m = 0.5 + 0.5 * Math.sin(t * WATER_SPEED + (b * (Math.PI * 2)) / WATER_BANDS);
      this.waterBands[b]!.tint = lerpColor(WATER_DEEP, WATER_BRIGHT, m);
    }
  }

  destroy(): void {
    for (const g of this.waterBands) g.destroy();
    this.landG.destroy();
    for (const s of this.spritePool) s.destroy();
    this.atlasContainer.destroy();
  }

  // --- analysis -----------------------------------------------------------------------

  // Per-vertex height field, (W+1)x(H+1). vh(vx,vy) = mean altitude of the up-to-4 tiles
  // meeting at that vertex, so neighbouring tiles agree on shared corners (seamless mesh).
  private vertexHeights(width: number, height: number, altitude: U8): Float32Array {
    const vw = width + 1;
    const vh = new Float32Array(vw * (height + 1));
    for (let vy = 0; vy <= height; vy++) {
      for (let vx = 0; vx <= width; vx++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 0; dy++) {
          for (let dx = -1; dx <= 0; dx++) {
            const tx = vx + dx;
            const ty = vy + dy;
            if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
            sum += altitude[ty * width + tx]!;
            n++;
          }
        }
        vh[vy * vw + vx] = n > 0 ? sum / n : 0;
      }
    }
    return vh;
  }

  // The four screen-space corners of tile (x,y), each lifted by its vertex height. Corner
  // order: top, right, bottom, left (clockwise from screen-up). Heights returned alongside.
  private corners(
    x: number,
    y: number,
    vh: Float32Array,
    vw: number,
  ): { pts: [Pt, Pt, Pt, Pt]; h: [number, number, number, number]; cx: number; cy: number } {
    const { sx, sy } = tileToScreen(x, y, 0);
    const hT = vh[y * vw + x]!;
    const hR = vh[y * vw + (x + 1)]!;
    const hB = vh[(y + 1) * vw + (x + 1)]!;
    const hL = vh[(y + 1) * vw + x]!;
    const top = { x: sx, y: sy - TILE_H / 2 - hT * ALT_STEP };
    const right = { x: sx + TILE_W / 2, y: sy - hR * ALT_STEP };
    const bottom = { x: sx, y: sy + TILE_H / 2 - hB * ALT_STEP };
    const left = { x: sx - TILE_W / 2, y: sy - hL * ALT_STEP };
    return {
      pts: [top, right, bottom, left],
      h: [hT, hR, hB, hL],
      cx: sx,
      cy: sy - ((hT + hR + hB + hL) / 4) * ALT_STEP,
    };
  }

  // Brightness for a tile from altitude + slope orientation under a fixed top-left light.
  // A face whose top/left corners sit above its bottom/right corners points at the light and
  // is brightened; the reverse is shadowed.
  private shadeFactor(h: [number, number, number, number]): number {
    const [hT, hR, hB, hL] = h;
    const center = (hT + hR + hB + hL) / 4;
    const altF = 0.62 + Math.min(15, Math.max(0, center)) / 22;
    let slopeF = 1 + 0.16 * (hT - hB + (hL - hR));
    if (slopeF < 0.55) slopeF = 0.55;
    else if (slopeF > 1.45) slopeF = 1.45;
    return altF * slopeF;
  }

  // 4-bit mask of which edges border water (N=1 NE-edge, E=2 SE, S=4 SW, W=8 NW).
  private coastMask(x: number, y: number, width: number, height: number, terrain: U8): number {
    const water = (tx: number, ty: number): boolean =>
      tx >= 0 && ty >= 0 && tx < width && ty < height && terrain[ty * width + tx] === Terrain.Water;
    let m = 0;
    if (water(x, y - 1)) m |= 1; // N — top-right edge
    if (water(x + 1, y)) m |= 2; // E — bottom-right edge
    if (water(x, y + 1)) m |= 4; // S — bottom-left edge
    if (water(x - 1, y)) m |= 8; // W — top-left edge
    return m;
  }

  // --- procedural path ----------------------------------------------------------------

  private buildProcedural(
    width: number,
    height: number,
    terrain: U8,
    altitude: U8,
    vh: Float32Array,
  ): void {
    const vw = width + 1;
    this.atlasContainer.visible = false;
    this.landG.clear();
    for (const g of this.waterBands) g.clear();
    this.hasWater = false;

    // Diamond-edge corner pairs for coast fringes, keyed by mask bit. Index into `pts`
    // (0=top,1=right,2=bottom,3=left).
    const EDGES: { bit: number; a: number; b: number }[] = [
      { bit: 1, a: 0, b: 1 }, // N : top->right
      { bit: 2, a: 1, b: 2 }, // E : right->bottom
      { bit: 4, a: 2, b: 3 }, // S : bottom->left
      { bit: 8, a: 3, b: 0 }, // W : left->top
    ];

    // Back-to-front by iso depth (x+y) so raised tiles correctly overlap those behind them.
    for (let d = 0; d <= width + height - 2; d++) {
      const xMin = Math.max(0, d - (height - 1));
      const xMax = Math.min(width - 1, d);
      for (let x = xMin; x <= xMax; x++) {
        const y = d - x;
        const i = y * width + x;
        const t = terrain[i]!;
        const { pts, h, cx, cy } = this.corners(x, y, vh, vw);
        const poly = [pts[0].x, pts[0].y, pts[1].x, pts[1].y, pts[2].x, pts[2].y, pts[3].x, pts[3].y];

        if (t === Terrain.Water) {
          this.hasWater = true;
          const alt = altitude[i]!;
          let depthF = 0.6 + (Math.min(SEA_LEVEL, alt) / SEA_LEVEL) * 0.4; // deeper = darker
          if (this.coastMask(x, y, width, height, terrain) !== (1 | 2 | 4 | 8)) {
            // touches non-water on some edge -> shallows, lift toward bright
            const touchesLand =
              !this.isWater(x, y - 1, width, height, terrain) ||
              !this.isWater(x + 1, y, width, height, terrain) ||
              !this.isWater(x, y + 1, width, height, terrain) ||
              !this.isWater(x - 1, y, width, height, terrain);
            if (touchesLand) depthF = Math.min(1, depthF + 0.16);
          }
          const band = Math.floor((x + y) / 2) % WATER_BANDS;
          this.waterBands[band]!.poly(poly).fill({ color: shade(0xffffff, depthF) });
          continue;
        }

        // Land / shore / forest: shaded diamond.
        const base = TERRAIN_COLOR[t] ?? 0xff00ff;
        this.landG.poly(poly).fill({ color: shade(base, this.shadeFactor(h)) });

        // Forest gets a darker inner mottle so canopies don't read as flat grass.
        if (t === Terrain.Forest) {
          const c = { x: cx, y: cy };
          const it = lerpPt(pts[0], c, 0.45);
          const ir = lerpPt(pts[1], c, 0.45);
          const ib = lerpPt(pts[2], c, 0.45);
          const il = lerpPt(pts[3], c, 0.45);
          this.landG
            .poly([it.x, it.y, ir.x, ir.y, ib.x, ib.y, il.x, il.y])
            .fill({ color: shade(base, this.shadeFactor(h) * 0.82) });
        }

        // Coast fringe on water-facing edges: foam at the waterline, sand just inland.
        const mask = this.coastMask(x, y, width, height, terrain);
        if (mask !== 0) {
          for (const e of EDGES) {
            if ((mask & e.bit) === 0) continue;
            const c1 = pts[e.a]!;
            const c2 = pts[e.b]!;
            const center = { x: cx, y: cy };
            const f1 = lerpPt(c1, center, 0.22);
            const f2 = lerpPt(c2, center, 0.22);
            this.landG.poly([c1.x, c1.y, c2.x, c2.y, f2.x, f2.y, f1.x, f1.y]).fill({ color: FOAM_COLOR });
            const s1 = lerpPt(c1, center, 0.42);
            const s2 = lerpPt(c2, center, 0.42);
            this.landG.poly([f1.x, f1.y, f2.x, f2.y, s2.x, s2.y, s1.x, s1.y]).fill({ color: SAND_COLOR });
          }
        }
      }
    }

    // Seed band tints so water is coloured before the first animate().
    this.animate(0);
  }

  private isWater(x: number, y: number, width: number, height: number, terrain: U8): boolean {
    return x >= 0 && y >= 0 && x < width && y < height && terrain[y * width + x] === Terrain.Water;
  }

  // --- atlas path ---------------------------------------------------------------------

  private buildAtlas(
    width: number,
    height: number,
    terrain: U8,
    altitude: U8,
    vh: Float32Array,
  ): void {
    const frames = this.atlasFrames!;
    const vw = width + 1;
    this.atlasContainer.visible = true;
    for (const g of this.waterBands) g.clear();
    this.landG.clear();
    this.hasWater = false;
    this.atlasWaterIdx.length = 0;

    let k = 0;
    for (let d = 0; d <= width + height - 2; d++) {
      const xMin = Math.max(0, d - (height - 1));
      const xMax = Math.min(width - 1, d);
      for (let x = xMin; x <= xMax; x++) {
        const y = d - x;
        const i = y * width + x;
        const t = terrain[i]!;
        const mask = t === Terrain.Water ? 15 : this.coastMask(x, y, width, height, terrain);
        const tex = frames.get(mask) ?? frames.get(0);
        if (!tex) continue;
        const { cx, cy } = this.corners(x, y, vh, vw);
        const s = this.sprite(k);
        s.texture = tex;
        s.anchor.set(0.5, 0.5);
        s.position.set(cx, cy);
        if (t === Terrain.Water) {
          this.hasWater = true;
          this.atlasWaterIdx.push(k);
          s.tint = 0xffffff;
        } else {
          s.tint = shade(0xffffff, this.shadeFactor(this.cornerHeights(x, y, vh, vw)));
        }
        s.visible = true;
        k++;
      }
    }
    for (let j = k; j < this.spritePool.length; j++) this.spritePool[j]!.visible = false;
  }

  private cornerHeights(x: number, y: number, vh: Float32Array, vw: number): [number, number, number, number] {
    return [
      vh[y * vw + x]!,
      vh[y * vw + (x + 1)]!,
      vh[(y + 1) * vw + (x + 1)]!,
      vh[(y + 1) * vw + x]!,
    ];
  }

  // Tint water sprites with the shimmer when running the atlas path. A small diagonal phase
  // offset (by iso depth) keeps it from flashing uniformly.
  private animateAtlas(t: number): void {
    if (!this.hasWater) return;
    for (let j = 0; j < this.atlasWaterIdx.length; j++) {
      const idx = this.atlasWaterIdx[j]!;
      const m = 0.5 + 0.5 * Math.sin(t * WATER_SPEED + (j % WATER_BANDS) * ((Math.PI * 2) / WATER_BANDS));
      this.spritePool[idx]!.tint = lerpColor(WATER_DEEP, WATER_BRIGHT, m);
    }
  }

  private sprite(i: number): Sprite {
    let s = this.spritePool[i];
    if (!s) {
      s = new Sprite();
      this.atlasContainer.addChild(s);
      this.spritePool[i] = s;
    }
    return s;
  }
}
