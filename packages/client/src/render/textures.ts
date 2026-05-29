// Placeholder texture factory for the sprite renderer. Until a real pixel-art atlas
// ships, we synthesize flat-colour textures on the GPU via RenderTexture (drawn once,
// then cached) so the renderer can stay 100% Sprite-based — no per-frame Graphics.
//
// Two primitives are baked:
//   - diamond: a white 2:1 ground tile. Tinted per-sprite at the use site so the
//     continuously-shaded terrain (altitude ramp) needs only ONE texture.
//   - box: a raised iso block whose three faces carry baked shading. Colour + lift are
//     a small discrete set (zone colours x growth stages, fixed building heights), so we
//     cache one texture per (colour, lift) pair instead of tinting.

import { RenderTexture, Graphics, type Renderer } from "pixi.js";
import { TILE_W, TILE_H } from "../iso.js";

function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.max(0, ((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.max(0, ((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.max(0, (color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}

// Draws a flat-shaded iso box rising `lift` px above the ground diamond centred at
// (cx, cy). Mirrors IsoRenderer.box so the placeholder look is identical.
function drawBox(g: Graphics, cx: number, cy: number, lift: number, color: number): void {
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

export class PlaceholderTextures {
  private readonly cache = new Map<string, RenderTexture>();

  constructor(private readonly renderer: Renderer) {}

  // White ground diamond (TILE_W x TILE_H), centred. Tint at the call site.
  diamond(): RenderTexture {
    return this.bake("diamond", TILE_W, TILE_H, (g) => {
      g.poly([TILE_W / 2, 0, TILE_W, TILE_H / 2, TILE_W / 2, TILE_H, 0, TILE_H / 2]).fill({
        color: 0xffffff,
      });
    });
  }

  // Raised box of the given baked colour, rising `lift` px. The texture is
  // (TILE_W x lift+TILE_H); its ground-diamond centre sits at (TILE_W/2, lift+TILE_H/2)
  // — see boxAnchorY() for the matching sprite anchor.
  box(color: number, lift: number): RenderTexture {
    return this.bake(`box:${color}:${lift}`, TILE_W, lift + TILE_H, (g) => {
      drawBox(g, TILE_W / 2, lift + TILE_H / 2, lift, color);
    });
  }

  // Vertical anchor that places a box sprite's ground-diamond centre at its screen pos.
  static boxAnchorY(lift: number): number {
    return (lift + TILE_H / 2) / (lift + TILE_H);
  }

  private bake(key: string, w: number, h: number, draw: (g: Graphics) => void): RenderTexture {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const g = new Graphics();
    draw(g);
    const tex = RenderTexture.create({ width: w, height: h, antialias: true });
    this.renderer.render({ container: g, target: tex, clear: true });
    g.destroy();
    this.cache.set(key, tex);
    return tex;
  }

  destroy(): void {
    for (const t of this.cache.values()) t.destroy(true);
    this.cache.clear();
  }
}
