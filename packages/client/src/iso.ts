// Isometric projection math. Classic 2:1 diamond tiles. Altitude raises a tile on
// screen so elevation reads visually. Tile picking ignores altitude (projects onto the
// flat ground plane) — good enough for Phase 0; refined when buildings/slopes land.

export const TILE_W = 32; // diamond width in px
export const TILE_H = 16; // diamond height in px
export const ALT_STEP = 4; // px lift per altitude level

export function tileToScreen(x: number, y: number, altitude = 0): { sx: number; sy: number } {
  const sx = (x - y) * (TILE_W / 2);
  const sy = (x + y) * (TILE_H / 2) - altitude * ALT_STEP;
  return { sx, sy };
}

// Inverse of tileToScreen on the flat plane (altitude = 0).
export function screenToTile(sx: number, sy: number): { x: number; y: number } {
  const a = sx / (TILE_W / 2);
  const b = sy / (TILE_H / 2);
  const x = (a + b) / 2;
  const y = (b - a) / 2;
  return { x: Math.floor(x), y: Math.floor(y) };
}
