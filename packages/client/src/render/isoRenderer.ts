// PixiJS isometric renderer. Layers (back to front):
//   terrain (static, redrawn on snapshot) -> surface (zones/roads/power/buildings, redrawn
//   each tick from the full surface arrays) -> overlay heatmap -> hover highlight.
// The render thread owns NO sim state; it only paints the arrays the worker ships each tick.
// Input: left-button drag = paint the active tool, right-button drag = pan, wheel = zoom.

import { Application, Container, Graphics } from "pixi.js";
import { TILE_W, TILE_H, ALT_STEP, tileToScreen, screenToTile } from "../iso.js";
import type { OverlayKind } from "../worker/messages.js";

const Terrain = { Land: 0, Water: 1, Shore: 2, Forest: 3 } as const;
const Net = { Road: 1 << 0, Rail: 1 << 1, PowerLine: 1 << 2 } as const;
const Build = { None: 0, CoalPlant: 1, GasPlant: 2, Police: 3, Fire: 4, Park: 5 } as const;

const TERRAIN_COLOR: Record<number, number> = {
  [Terrain.Land]: 0x5a8f4a,
  [Terrain.Water]: 0x2f6f9f,
  [Terrain.Shore]: 0xc2b280,
  [Terrain.Forest]: 0x2f6b34,
};

const STAGE_LIFT = 5; // px of height per growth stage

function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.max(0, ((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.max(0, ((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.max(0, (color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}

type U8 = Uint8Array<ArrayBufferLike>;
type U16 = Uint16Array<ArrayBufferLike>;

export class IsoRenderer {
  readonly app = new Application();
  private readonly world = new Container();
  private readonly terrainG = new Graphics();
  private readonly surfaceG = new Graphics();
  private readonly overlayG = new Graphics();
  private readonly hoverG = new Graphics();

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
    this.world.addChild(this.terrainG, this.surfaceG, this.overlayG, this.hoverG);
    this.app.stage.addChild(this.world);
    this.installInput();
    this.centerCamera();
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
    this.drawTerrain();
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

  // --- drawing primitives ---

  private diamond(g: Graphics, cx: number, cy: number, color: number, alpha = 1): void {
    g.poly([cx, cy - TILE_H / 2, cx + TILE_W / 2, cy, cx, cy + TILE_H / 2, cx - TILE_W / 2, cy]).fill({
      color,
      alpha,
    });
  }

  // A raised box rising `lift` px above the ground diamond at (cx, cy).
  private box(g: Graphics, cx: number, cy: number, lift: number, color: number): void {
    const hw = TILE_W / 2;
    const hh = TILE_H / 2;
    const top = cy - lift;
    // left wall
    g.poly([cx - hw, cy, cx, cy + hh, cx, top + hh, cx - hw, top]).fill({ color: shade(color, 0.65) });
    // right wall
    g.poly([cx + hw, cy, cx, cy + hh, cx, top + hh, cx + hw, top]).fill({ color: shade(color, 0.85) });
    // top face
    g.poly([cx, top - hh, cx + hw, top, cx, top + hh, cx - hw, top]).fill({ color: shade(color, 1.15) });
  }

  private drawTerrain(): void {
    const g = this.terrainG;
    g.clear();
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        const alt = this.altitude[i]!;
        const { sx, sy } = tileToScreen(x, y, alt);
        const base = TERRAIN_COLOR[this.terrain[i]!] ?? 0xff00ff;
        this.diamond(g, sx, sy, shade(base, 0.7 + alt / 40));
      }
    }
  }

  private drawSurface(): void {
    const g = this.surfaceG;
    g.clear();
    if (this.zone.length === 0) return;
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

        // Network first (flat), so lots/buildings sit on top.
        if (n & Net.Road) this.diamond(g, sx, sy, 0x35373b, 0.95);
        if (n & Net.PowerLine && b === 0 && z === 0) this.diamond(g, sx, sy, 0xffe066, 0.6);

        if (b !== Build.None) {
          this.drawStructure(g, sx, sy, b);
        } else if (z !== 0) {
          if (st > 0) {
            this.box(g, sx, sy, st * STAGE_LIFT, zoneColor(z));
            // brownout marker on a developed but unpowered lot
            if (this.power[i] === 0) this.diamond(g, sx, sy - st * STAGE_LIFT - TILE_H, 0xff3b30, 0.9);
          } else {
            this.diamond(g, sx, sy, zoneColor(z), 0.4); // zoned but undeveloped
          }
        }
      }
    }
  }

  private drawStructure(g: Graphics, sx: number, sy: number, b: number): void {
    switch (b) {
      case Build.CoalPlant:
        this.box(g, sx, sy, 14, 0x6b5b4a);
        break;
      case Build.GasPlant:
        this.box(g, sx, sy, 10, 0x7a7a55);
        break;
      case Build.Police:
        this.box(g, sx, sy, 8, 0x2f6fd0);
        break;
      case Build.Fire:
        this.box(g, sx, sy, 8, 0xd0392f);
        break;
      case Build.Park:
        this.diamond(g, sx, sy, 0x3fae54, 0.9);
        break;
      default:
        this.box(g, sx, sy, 6, 0x888888);
    }
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
