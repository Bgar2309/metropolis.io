// PixiJS isometric renderer, Sprite-based. Drop-in replacement for IsoRenderer with the
// same public surface (init, setSnapshot, update, highlight, onHover, onPaintTile) plus
// loadAtlas(). Layers (back to front):
//   terrain (sprite grid, rebuilt on snapshot) -> surface (pooled sprites, re-sorted
//   back-to-front each tick) -> overlay heatmap (Graphics) -> hover highlight (Graphics).
//
// Why sprites: this is the seam for real pixel-art. Today the textures are flat-colour
// placeholders synthesized via RenderTexture (see textures.ts); loadAtlas() will later
// swap in a packed atlas without touching the scene-graph plumbing.
//
// CRUCIAL: surface sprites are drawn back-to-front by (x+y) then footprint so that
// rising buildings correctly occlude the tiles behind them in iso. The render order is
// the child order of surfaceLayer, and we keep pool slot i == sorted item i, so child
// order == sort order with no per-frame reparenting.

import { Application, Assets, Container, Graphics, Rectangle, Sprite, Texture, type Ticker } from "pixi.js";
import { TILE_W, TILE_H, tileToScreen, screenToTile } from "../iso.js";
import { PlaceholderTextures } from "./textures.js";
import { TerrainPainter } from "./terrain.js";
import type { OverlayKind } from "../worker/messages.js";

const Net = { Road: 1 << 0, Rail: 1 << 1, PowerLine: 1 << 2 } as const;
const Build = { None: 0, CoalPlant: 1, GasPlant: 2, Police: 3, Fire: 4, Park: 5 } as const;

const STAGE_LIFT = 5; // px of height per growth stage

type U8 = Uint8Array<ArrayBufferLike>;
type U16 = Uint16Array<ArrayBufferLike>;

// A single sprite to draw this frame. Collected, sorted back-to-front, then mapped onto
// the pool. `box` items use a baked-colour box texture (tint stays white); flat items use
// the white diamond texture with a per-sprite tint.
interface DrawItem {
  sortA: number; // x + y (iso depth)
  foot: number; // footprint size — tiebreak so larger lots sort after their neighbours
  sub: number; // intra-tile order: structure (0) before floating marker (1)
  box: boolean;
  color: number; // baked colour (box) — unused for flat
  lift: number; // box lift — unused for flat
  x: number;
  y: number;
  tint: number; // flat tint (box uses 0xffffff)
  alpha: number;
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
    // Drive the water shimmer off Pixi's own frame clock — independent of the sim tick, so
    // it stays smooth at any game speed and touches nothing in the simulation.
    this.app.ticker.add((tk: Ticker) => this.terrainPainter.animate(tk.lastTime));
    // Use packed terrain art if the atlas ships any `terrain_*` frames; otherwise the
    // painter stays on its procedural path. Self-contained so main.ts needn't wire it.
    void this.loadAtlas("atlas.json");
  }

  // Load `terrain_<mask>` coast-mask frames from a packed atlas, if present, and hand them
  // to the terrain painter. Safe to call before or after the first snapshot — a snapshot
  // already drawn is rebuilt with the new art. A missing/empty atlas leaves the procedural
  // path untouched.
  async loadAtlas(atlasUrl: string): Promise<void> {
    try {
      const meta = (await (await fetch(atlasUrl)).json()) as {
        frames?: Record<string, { x: number; y: number; w: number; h: number }>;
      };
      const frames = meta.frames ?? {};
      const terrainKeys = Object.keys(frames).filter((k) => /^terrain_\d+$/.test(k));
      if (terrainKeys.length === 0) return;

      const pngUrl = atlasUrl.replace(/atlas\.json$/, "atlas.png").replace(/\.json$/, ".png");
      const sheet = (await Assets.load(pngUrl)) as Texture;
      const map = new Map<number, Texture>();
      for (const key of terrainKeys) {
        const mask = Number(key.slice("terrain_".length));
        const r = frames[key]!;
        map.set(mask, new Texture({ source: sheet.source, frame: new Rectangle(r.x, r.y, r.w, r.h) }));
      }
      this.terrainPainter.setAtlasFrames(map);
      if (this.width > 0) this.terrainPainter.build(this.width, this.height, this.terrain, this.altitude);
    } catch {
      // No atlas served (or malformed) — procedural terrain stands.
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
    this.drawSurface();
    this.drawOverlay();
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
            this.pushBox(depth, sx, sy, zoneColor(z), st * STAGE_LIFT);
            // brownout marker on a developed but unpowered lot — floats above the box
            if (this.power[i] === 0) {
              this.pushFlat(depth, sx, sy - st * STAGE_LIFT - TILE_H, 0xff3b30, 0.9, 1);
            }
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
      if (it.box) {
        s.texture = this.tex.box(it.color, it.lift);
        s.anchor.set(0.5, PlaceholderTextures.boxAnchorY(it.lift));
        s.tint = 0xffffff;
      } else {
        s.texture = diamond;
        s.anchor.set(0.5, 0.5);
        s.tint = it.tint;
      }
      s.position.set(it.x, it.y);
      s.alpha = it.alpha;
      s.visible = true;
    }
    for (let k = items.length; k < this.surfacePool.length; k++) this.surfacePool[k]!.visible = false;
  }

  private pushFlat(depth: number, x: number, y: number, tint: number, alpha: number, sub = 0): void {
    this.items.push({ sortA: depth, foot: 1, sub, box: false, color: 0, lift: 0, x, y, tint, alpha });
  }

  private pushBox(depth: number, x: number, y: number, color: number, lift: number): void {
    this.items.push({ sortA: depth, foot: 1, sub: 0, box: true, color, lift, x, y, tint: 0xffffff, alpha: 1 });
  }

  private pushStructure(depth: number, sx: number, sy: number, b: number): void {
    switch (b) {
      case Build.CoalPlant:
        this.pushBox(depth, sx, sy, 0x6b5b4a, 14);
        break;
      case Build.GasPlant:
        this.pushBox(depth, sx, sy, 0x7a7a55, 10);
        break;
      case Build.Police:
        this.pushBox(depth, sx, sy, 0x2f6fd0, 8);
        break;
      case Build.Fire:
        this.pushBox(depth, sx, sy, 0xd0392f, 8);
        break;
      case Build.Park:
        this.pushFlat(depth, sx, sy, 0x3fae54, 0.9);
        break;
      default:
        this.pushBox(depth, sx, sy, 0x888888, 6);
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
