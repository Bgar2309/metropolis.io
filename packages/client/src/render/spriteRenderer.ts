// PixiJS isometric renderer, Sprite-based. Drop-in replacement for IsoRenderer with the
// same public surface (init, setSnapshot, update, highlight, onHover, onPaintTile) plus
// loadAtlas(). Layers (back to front):
//   terrain (sprite grid, rebuilt on snapshot) -> surface (pooled sprites, re-sorted
//   back-to-front each tick) -> overlay heatmap (Graphics) -> hover highlight (Graphics).
//
// Why sprites: this is the seam for real pixel-art. Today the textures are flat-colour
// placeholders synthesized via RenderTexture (see textures.ts); loadAtlas() swaps in a
// packed atlas (terrain_<mask> + building_<...> frames) without touching the scene-graph
// plumbing. When the atlas ships stage art, a growing zone shows a *different* sprite per
// stage; without it the procedural box (taller per stage) stands in.
//
// GROWTH FEEL: each zone lot remembers its previous growth stage (render-side only — the
// sim is never touched). When the stage changes, the lot plays a short scale+fade "pop" so
// the city visibly grows. Two discreet markers read trouble at a glance: a brownout chip
// when a developed lot has no power, and a derelict chip when a lot has decayed to empty
// (abandonment, inferred from the stage dropping to 0 while still zoned).
//
// CRUCIAL: surface sprites are drawn back-to-front by (x+y) then footprint so that
// rising buildings correctly occlude the tiles behind them in iso. The render order is
// the child order of surfaceLayer, and we keep pool slot i == sorted item i, so child
// order == sort order with no per-frame reparenting. The pop animation only touches a
// sprite's alpha/scale — never its position or child index — so the iso sort is preserved.

import { Application, Assets, Container, Graphics, Rectangle, Sprite, Texture, type Ticker } from "pixi.js";
import { TILE_W, TILE_H, tileToScreen, screenToTile } from "../iso.js";
import { PlaceholderTextures } from "./textures.js";
import { TerrainPainter } from "./terrain.js";
import type { OverlayKind } from "../worker/messages.js";

const Net = { Road: 1 << 0, Rail: 1 << 1, PowerLine: 1 << 2 } as const;
const Build = { None: 0, CoalPlant: 1, GasPlant: 2, Police: 3, Fire: 4, Park: 5 } as const;

const STAGE_LIFT = 5; // px of height per growth stage (procedural box fallback)

// Stage-change "pop": a short scale-up + fade-in driven off Pixi's frame clock, so it stays
// smooth at any game speed and is independent of the sim tick rate.
const POP_MS = 320; // duration of the grow/transition animation
const POP_SCALE_FROM = 0.82; // start scale (eases to 1)
const POP_ALPHA_FROM = 0.35; // start alpha factor (eases to the item's base alpha)

// Discreet trouble chips: a small tinted diamond, not a full-tile flash.
const MARKER_SCALE = 0.42;
const BROWNOUT_TINT = 0x8f8f8f; // developed-but-unpowered building, dimmed toward grey
const BROWNOUT_CHIP = 0xffb020; // amber "no power" chip floating over the dark building
const ABANDON_LOT = 0x6b5e52; // derelict empty lot — muted brown, not the live zone colour
const ABANDON_CHIP = 0x4a4038; // dark derelict chip on the vacant lot

type U8 = Uint8Array<ArrayBufferLike>;
type U16 = Uint16Array<ArrayBufferLike>;

// A single sprite to draw this frame. Collected, sorted back-to-front, then mapped onto
// the pool. `tex` items use a packed atlas frame (anchored by its baked ground diamond);
// `box` items use a baked-colour box texture; flat items use the white diamond texture with
// a per-sprite tint. `anim` items (zone buildings) are eligible for the stage-change pop and
// carry their tile index so the per-frame animator can find them after the sort.
interface DrawItem {
  sortA: number; // x + y (iso depth)
  foot: number; // footprint size — tiebreak so larger lots sort after their neighbours
  sub: number; // intra-tile order: structure (0) before floating marker (1)
  tex: Texture | null; // atlas frame (anchored by ground diamond) — wins over box/flat
  box: boolean;
  color: number; // baked colour (box) — unused for tex/flat
  lift: number; // box lift — unused for tex/flat
  x: number;
  y: number;
  tint: number; // tex/box/flat tint
  alpha: number;
  scale: number; // base scale (markers shrink; buildings are 1 and may pop on top)
  tile: number; // source tile index, or -1 if not pop-eligible
  anim: boolean; // eligible for the stage-change pop
}

export class SpriteRenderer {
  readonly app = new Application();
  private readonly world = new Container();
  private readonly terrainLayer = new Container();
  private readonly surfaceLayer = new Container();
  private readonly overlayG = new Graphics();
  private readonly hoverG = new Graphics();

  private tex!: PlaceholderTextures;
  private terrainPainter!: TerrainPainter;
  private readonly surfacePool: Sprite[] = [];
  private readonly items: DrawItem[] = [];

  // Per-pool-slot bookkeeping for the pop animator (parallel to surfacePool, valid for the
  // first `items.length` slots after each drawSurface).
  private readonly slotTile: number[] = []; // tile index of an animatable slot, else -1
  private readonly slotBaseAlpha: number[] = []; // alpha to settle back to when the pop ends
  private readonly slotBaseScale: number[] = []; // scale to settle back to when the pop ends

  // Packed building frames, keyed by atlas frame name (e.g. building_res_dense_s5). Empty
  // until loadAtlas() finds any; absent frames fall back to the procedural box.
  private buildingFrames: Map<string, Texture> | null = null;

  private width = 0;
  private height = 0;
  private terrain: U8 = new Uint8Array(0);
  private altitude: U8 = new Uint8Array(0);
  private zone: U8 = new Uint8Array(0);
  private stage: U8 = new Uint8Array(0);
  private net: U8 = new Uint8Array(0);
  private building: U16 = new Uint16Array(0);
  private power: U8 = new Uint8Array(0);
  private overlay: OverlayKind = "none";
  private overlayField: U8 | null = null;

  // Render-side growth memory (never fed back to the sim). prevStage drives pop detection;
  // abandoned marks lots that decayed from developed to empty while still zoned; popStart is
  // the frame-clock timestamp (ms) a tile's pop began, or -1 for none.
  private prevStage: U8 = new Uint8Array(0);
  private abandoned: U8 = new Uint8Array(0);
  private popStart: Float64Array = new Float64Array(0);
  private seeded = false; // first update seeds prevStage without animating the whole map

  // camera
  private camX = 0;
  private camY = 0;
  private scale = 1;
  private panning = false;
  private painting = false;
  private lastPX = 0;
  private lastPY = 0;
  private lastPaintTile = -1;

  onHover: ((tx: number, ty: number) => void) | null = null;
  onPaintTile: ((tx: number, ty: number) => void) | null = null;

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: window, background: 0x0b1d2a, antialias: true });
    host.appendChild(this.app.canvas);
    this.tex = new PlaceholderTextures(this.app.renderer);
    this.terrainPainter = new TerrainPainter(this.terrainLayer);
    this.world.addChild(this.terrainLayer, this.surfaceLayer, this.overlayG, this.hoverG);
    this.app.stage.addChild(this.world);
    this.installInput();
    this.centerCamera();
    // Drive the water shimmer and the growth pops off Pixi's own frame clock — independent of
    // the sim tick, so they stay smooth at any game speed and touch nothing in the simulation.
    this.app.ticker.add((tk: Ticker) => {
      this.terrainPainter.animate(tk.lastTime);
      this.animateSurface(tk.lastTime);
    });
    // Use packed terrain/building art if the atlas ships any; otherwise the procedural paths
    // stand. Self-contained so main.ts needn't wire it.
    void this.loadAtlas("atlas.json");
  }

  // Load packed frames from the atlas, if present: `terrain_<mask>` coast tiles go to the
  // terrain painter; `building_*` frames are kept here for the surface layer. Safe to call
  // before or after the first snapshot — a snapshot already drawn is rebuilt with the new
  // art. A missing/empty atlas leaves the procedural paths untouched.
  async loadAtlas(atlasUrl: string): Promise<void> {
    try {
      const meta = (await (await fetch(atlasUrl)).json()) as {
        frames?: Record<string, { x: number; y: number; w: number; h: number }>;
      };
      const frames = meta.frames ?? {};
      const keys = Object.keys(frames);
      const terrainKeys = keys.filter((k) => /^terrain_\d+$/.test(k));
      const buildingKeys = keys.filter((k) => k.startsWith("building_"));
      if (terrainKeys.length === 0 && buildingKeys.length === 0) return;

      const pngUrl = atlasUrl.replace(/atlas\.json$/, "atlas.png").replace(/\.json$/, ".png");
      const sheet = (await Assets.load(pngUrl)) as Texture;
      const cut = (key: string): Texture => {
        const r = frames[key]!;
        return new Texture({ source: sheet.source, frame: new Rectangle(r.x, r.y, r.w, r.h) });
      };

      if (terrainKeys.length > 0) {
        const map = new Map<number, Texture>();
        for (const key of terrainKeys) map.set(Number(key.slice("terrain_".length)), cut(key));
        this.terrainPainter.setAtlasFrames(map);
      }
      if (buildingKeys.length > 0) {
        const map = new Map<string, Texture>();
        for (const key of buildingKeys) map.set(key, cut(key));
        this.buildingFrames = map;
      }

      if (this.width > 0) {
        this.terrainPainter.build(this.width, this.height, this.terrain, this.altitude);
        if (this.zone.length > 0) this.drawSurface();
      }
    } catch {
      // No atlas served (or malformed) — procedural terrain + boxes stand.
    }
  }

  setSnapshot(width: number, height: number, terrain: U8, altitude: U8): void {
    this.width = width;
    this.height = height;
    this.terrain = terrain;
    this.altitude = altitude;
    const n = width * height;
    this.zone = new Uint8Array(n);
    this.stage = new Uint8Array(n);
    this.net = new Uint8Array(n);
    this.building = new Uint16Array(n);
    this.power = new Uint8Array(n);
    this.prevStage = new Uint8Array(n);
    this.abandoned = new Uint8Array(n);
    this.popStart = new Float64Array(n).fill(-1);
    this.seeded = false;
    this.terrainPainter.build(width, height, terrain, altitude);
    this.drawSurface();
    this.centerCamera();
  }

  update(
    zone: U8,
    stage: U8,
    net: U8,
    building: U16,
    power: U8,
    overlay: OverlayKind,
    overlayField: U8 | null,
  ): void {
    this.zone = zone;
    this.stage = stage;
    this.net = net;
    this.building = building;
    this.power = power;
    this.overlay = overlay;
    this.overlayField = overlayField;
    this.trackGrowth();
    this.drawSurface();
    this.drawOverlay();
  }

  // Diff this tick's stages against the last to drive pops + abandonment, reading only the
  // existing zone/stage arrays. The first update after a snapshot just seeds the memory so a
  // loaded city doesn't pop its whole skyline at once.
  private trackGrowth(): void {
    const now = this.app.ticker.lastTime;
    const n = this.stage.length;
    for (let i = 0; i < n; i++) {
      const st = this.stage[i]!;
      const z = this.zone[i]!;
      if (this.seeded && st !== this.prevStage[i]!) this.popStart[i] = now;

      // Abandonment: a lot that fell from developed to empty while still zoned reads as
      // derelict until it redevelops (stage > 0) or is rezoned/bulldozed (zone === 0).
      if (z === 0 || st > 0) this.abandoned[i] = 0;
      else if (this.prevStage[i]! > 0) this.abandoned[i] = 1;

      this.prevStage[i] = st;
    }
    this.seeded = true;
  }

  // --- pooling ---

  private surfaceSprite(i: number): Sprite {
    let s = this.surfacePool[i];
    if (!s) {
      s = new Sprite(this.tex.diamond());
      this.surfaceLayer.addChild(s); // appended -> child index === pool index === sort order
      this.surfacePool[i] = s;
    }
    return s;
  }

  // --- surface (pooled, re-sorted back-to-front every tick) ---

  private drawSurface(): void {
    const items = this.items;
    items.length = 0;
    if (this.zone.length === 0) {
      for (const s of this.surfacePool) s.visible = false;
      return;
    }

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        const z = this.zone[i]!;
        const n = this.net[i]!;
        const b = this.building[i]!;
        const st = this.stage[i]!;
        if (z === 0 && n === 0 && b === 0) continue;
        const alt = this.altitude[i]!;
        const { sx, sy } = tileToScreen(x, y, alt);
        const depth = x + y;

        // Network first (flat), so lots/buildings sit on top.
        if (n & Net.Road) this.pushFlat(depth, sx, sy, 0x35373b, 0.95);
        if (n & Net.PowerLine && b === 0 && z === 0) this.pushFlat(depth, sx, sy, 0xffe066, 0.6);

        if (b !== Build.None) {
          this.pushStructure(depth, sx, sy, b);
        } else if (z !== 0) {
          if (st > 0) {
            this.pushZoneBuilding(depth, sx, sy, i, z, st);
          } else if (this.abandoned[i]) {
            // Decayed to an empty lot: muted derelict ground + a discreet dark chip.
            this.pushFlat(depth, sx, sy, ABANDON_LOT, 0.55);
            this.pushMarker(depth, sx, sy, ABANDON_CHIP, 0.75);
          } else {
            this.pushFlat(depth, sx, sy, zoneColor(z), 0.4); // zoned but undeveloped
          }
        }
      }
    }

    // Back-to-front: primary iso depth (x+y), then footprint, then intra-tile sub-order.
    items.sort((a, c) => a.sortA - c.sortA || a.foot - c.foot || a.sub - c.sub);

    const diamond = this.tex.diamond();
    for (let k = 0; k < items.length; k++) {
      const it = items[k]!;
      const s = this.surfaceSprite(k);
      if (it.tex) {
        s.texture = it.tex;
        s.anchor.set(0.5, spriteAnchorY(it.tex));
        s.tint = it.tint;
      } else if (it.box) {
        s.texture = this.tex.box(it.color, it.lift);
        s.anchor.set(0.5, PlaceholderTextures.boxAnchorY(it.lift));
        s.tint = it.tint;
      } else {
        s.texture = diamond;
        s.anchor.set(0.5, 0.5);
        s.tint = it.tint;
      }
      s.position.set(it.x, it.y);
      s.alpha = it.alpha;
      s.scale.set(it.scale);
      s.visible = true;
      // Record pop bookkeeping for this slot; the per-frame animator reads it back.
      this.slotTile[k] = it.anim ? it.tile : -1;
      this.slotBaseAlpha[k] = it.alpha;
      this.slotBaseScale[k] = it.scale;
    }
    for (let k = items.length; k < this.surfacePool.length; k++) this.surfacePool[k]!.visible = false;
  }

  // Per-frame growth pop: scale up + fade in over POP_MS for any lot whose stage just
  // changed. Touches only alpha/scale (never position or child order) so the iso sort holds.
  private animateSurface(now: number): void {
    const count = this.items.length;
    for (let k = 0; k < count; k++) {
      const tile = this.slotTile[k]!;
      if (tile < 0) continue;
      const start = this.popStart[tile]!;
      if (start < 0) continue;
      const s = this.surfacePool[k]!;
      const p = (now - start) / POP_MS;
      if (p >= 1) {
        this.popStart[tile] = -1; // settle and stop
        s.scale.set(this.slotBaseScale[k]!);
        s.alpha = this.slotBaseAlpha[k]!;
        continue;
      }
      const e = 1 - (1 - p) ** 3; // easeOutCubic
      s.scale.set(POP_SCALE_FROM + (this.slotBaseScale[k]! - POP_SCALE_FROM) * e);
      s.alpha = this.slotBaseAlpha[k]! * (POP_ALPHA_FROM + (1 - POP_ALPHA_FROM) * e);
    }
  }

  // A developed zone lot: a stage-specific atlas sprite if the art is loaded, else the
  // procedural box (taller per stage). Either way the lot is pop-eligible, dims toward grey
  // when unpowered, and floats an amber brownout chip above its roof.
  private pushZoneBuilding(depth: number, sx: number, sy: number, i: number, z: number, st: number): void {
    const unpowered = this.power[i] === 0;
    const tint = unpowered ? BROWNOUT_TINT : 0xffffff;
    const frame = this.buildingFrames?.get(zoneFrameKey(z, st));
    let lift: number;
    if (frame) {
      lift = Math.max(0, frame.height - TILE_H);
      this.pushSprite(depth, sx, sy, i, frame, tint);
    } else {
      lift = st * STAGE_LIFT;
      this.pushBox(depth, sx, sy, i, zoneColor(z), lift, tint);
    }
    if (unpowered) this.pushMarker(depth, sx, sy - lift - TILE_H * 0.35, BROWNOUT_CHIP, 0.9);
  }

  private pushFlat(depth: number, x: number, y: number, tint: number, alpha: number, sub = 0): void {
    this.items.push({ sortA: depth, foot: 1, sub, tex: null, box: false, color: 0, lift: 0, x, y, tint, alpha, scale: 1, tile: -1, anim: false });
  }

  // Small tinted diamond chip (brownout / abandonment). Drawn after the structure (sub = 1).
  private pushMarker(depth: number, x: number, y: number, tint: number, alpha: number): void {
    this.items.push({ sortA: depth, foot: 1, sub: 1, tex: null, box: false, color: 0, lift: 0, x, y, tint, alpha, scale: MARKER_SCALE, tile: -1, anim: false });
  }

  private pushBox(depth: number, x: number, y: number, tile: number, color: number, lift: number, tint = 0xffffff): void {
    this.items.push({ sortA: depth, foot: 1, sub: 0, tex: null, box: true, color, lift, x, y, tint, alpha: 1, scale: 1, tile, anim: tile >= 0 });
  }

  private pushSprite(depth: number, x: number, y: number, tile: number, tex: Texture, tint = 0xffffff): void {
    this.items.push({ sortA: depth, foot: 1, sub: 0, tex, box: false, color: 0, lift: 0, x, y, tint, alpha: 1, scale: 1, tile, anim: tile >= 0 });
  }

  private pushStructure(depth: number, sx: number, sy: number, b: number): void {
    // Prefer packed building art when the atlas ships it; standalone buildings don't grow, so
    // they aren't pop-eligible (tile = -1).
    const frame = this.buildingFrames?.get(buildingFrameKey(b));
    if (frame) {
      this.pushSprite(depth, sx, sy, -1, frame);
      return;
    }
    switch (b) {
      case Build.CoalPlant:
        this.pushBox(depth, sx, sy, -1, 0x6b5b4a, 14);
        break;
      case Build.GasPlant:
        this.pushBox(depth, sx, sy, -1, 0x7a7a55, 10);
        break;
      case Build.Police:
        this.pushBox(depth, sx, sy, -1, 0x2f6fd0, 8);
        break;
      case Build.Fire:
        this.pushBox(depth, sx, sy, -1, 0xd0392f, 8);
        break;
      case Build.Park:
        this.pushFlat(depth, sx, sy, 0x3fae54, 0.9);
        break;
      default:
        this.pushBox(depth, sx, sy, -1, 0x888888, 6);
    }
  }

  // --- overlay + hover (Graphics, above the sprite layers) ---

  private diamond(g: Graphics, cx: number, cy: number, color: number, alpha = 1): void {
    g.poly([cx, cy - TILE_H / 2, cx + TILE_W / 2, cy, cx, cy + TILE_H / 2, cx - TILE_W / 2, cy]).fill({
      color,
      alpha,
    });
  }

  private drawOverlay(): void {
    const g = this.overlayG;
    g.clear();
    if (this.overlay === "none" || !this.overlayField) return;
    const f = this.overlayField;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        const v = f[i]!;
        if (v === 0) continue;
        const alt = this.altitude[i]!;
        const { sx, sy } = tileToScreen(x, y, alt);
        this.diamond(g, sx, sy, heatColor(v), 0.55);
      }
    }
  }

  highlight(tx: number, ty: number): void {
    const g = this.hoverG;
    g.clear();
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return;
    const alt = this.altitude[ty * this.width + tx] ?? 0;
    const { sx, sy } = tileToScreen(tx, ty, alt);
    g.poly([sx, sy - TILE_H / 2, sx + TILE_W / 2, sy, sx, sy + TILE_H / 2, sx - TILE_W / 2, sy]).stroke({
      color: 0xffffff,
      width: 1.5,
      alpha: 0.9,
    });
  }

  // --- camera + input ---

  private applyCamera(): void {
    this.world.x = this.camX;
    this.world.y = this.camY;
    this.world.scale.set(this.scale);
  }

  private centerCamera(): void {
    this.camX = this.app.renderer.width / 2;
    this.camY = this.app.renderer.height / 3;
    this.scale = 1;
    this.applyCamera();
  }

  private pointerToTile(clientX: number, clientY: number): { x: number; y: number } {
    const wx = (clientX - this.camX) / this.scale;
    const wy = (clientY - this.camY) / this.scale;
    return screenToTile(wx, wy);
  }

  private emitPaint(clientX: number, clientY: number): void {
    const t = this.pointerToTile(clientX, clientY);
    if (t.x < 0 || t.y < 0 || t.x >= this.width || t.y >= this.height) return;
    const i = t.y * this.width + t.x;
    if (i === this.lastPaintTile) return;
    this.lastPaintTile = i;
    this.onPaintTile?.(t.x, t.y);
  }

  private installInput(): void {
    const c = this.app.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("pointerdown", (e) => {
      if (e.button === 2 || e.button === 1) {
        this.panning = true;
      } else {
        this.painting = true;
        this.lastPaintTile = -1;
        this.emitPaint(e.clientX, e.clientY);
      }
      this.lastPX = e.clientX;
      this.lastPY = e.clientY;
    });
    window.addEventListener("pointerup", () => {
      this.panning = false;
      this.painting = false;
      this.lastPaintTile = -1;
    });
    c.addEventListener("pointermove", (e) => {
      if (this.panning) {
        this.camX += e.clientX - this.lastPX;
        this.camY += e.clientY - this.lastPY;
        this.lastPX = e.clientX;
        this.lastPY = e.clientY;
        this.applyCamera();
      } else if (this.painting) {
        this.emitPaint(e.clientX, e.clientY);
      }
      const t = this.pointerToTile(e.clientX, e.clientY);
      this.highlight(t.x, t.y);
      this.onHover?.(t.x, t.y);
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const ns = Math.max(0.3, Math.min(4, this.scale * factor));
        this.camX = e.clientX - (e.clientX - this.camX) * (ns / this.scale);
        this.camY = e.clientY - (e.clientY - this.camY) * (ns / this.scale);
        this.scale = ns;
        this.applyCamera();
      },
      { passive: false },
    );
  }
}

function zoneColor(z: number): number {
  if (z === 1 || z === 2) return 0x33cc66; // R green
  if (z === 3 || z === 4) return 0x3399ff; // C blue
  return 0xffcc33; // I yellow
}

// Atlas frame key for a developed zone lot: building_<cat>_<density>_s<stage>. Mirrors the
// zone byte layout (1/2 R, 3/4 C, 5/6 I; even = dense) and the asset naming in
// assets/README.md §3.3.
function zoneFrameKey(z: number, stage: number): string {
  const cat = z <= 2 ? "res" : z <= 4 ? "com" : "ind";
  const density = z % 2 === 0 ? "dense" : "light";
  return `building_${cat}_${density}_s${stage}`;
}

// Atlas frame key for a standalone building (registry sprite key with a building_ prefix).
function buildingFrameKey(b: number): string {
  switch (b) {
    case Build.CoalPlant:
      return "building_coal_plant";
    case Build.GasPlant:
      return "building_gas_plant";
    case Build.Police:
      return "building_police";
    case Build.Fire:
      return "building_fire";
    case Build.Park:
      return "building_park";
    default:
      return "building_none";
  }
}

// Vertical anchor for an atlas building sprite: its ground diamond is bottom-flush in the
// frame (assets/README.md §1.1), so the diamond centre sits TILE_H/2 above the bottom edge.
function spriteAnchorY(tex: Texture): number {
  const h = tex.height;
  return h > 0 ? (h - TILE_H / 2) / h : 1;
}

// Blue -> green -> yellow -> red ramp for heatmap overlays (value 0..255).
function heatColor(v: number): number {
  const t = v / 255;
  if (t < 0.5) {
    const k = t / 0.5;
    return (Math.round(k * 255) << 8) | Math.round((1 - k) * 200 + 55); // green up, blue down
  }
  const k = (t - 0.5) / 0.5;
  return (Math.round(255) << 16) | (Math.round((1 - k) * 255) << 8);
}
