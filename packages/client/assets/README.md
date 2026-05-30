# Metropolis.io — Sprite Asset Pipeline

This folder is the **source** for all pixel-art tiles and buildings. Bruno generates the
PNGs with an image model (ChatGPT Image / nano-banana) using the **anchor prompt** below,
drops them in `sprites/`, then runs the packer:

```bash
pnpm build:atlas
```

…which writes `packages/client/public/atlas.png` + `atlas.json` consumed by the renderer
(`SpriteRenderer.loadAtlas()`).

> Claude does **not** generate the images. This doc + the anchor prompt + the packer are
> the tools; the art is produced by Bruno via the image model.

---

## 1. Isometric convention (EXACT — every sprite must obey)

These numbers are not negotiable: they mirror `packages/client/src/iso.ts` and the renderer
math. A sprite that breaks them will not line up on the grid.

| Property            | Value                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| Projection          | Classic **2:1 isometric diamond** (dimetric). NOT true 30° iso.       |
| Base tile diamond   | **32 px wide × 16 px tall** (`TILE_W=32`, `TILE_H=16`).               |
| Diamond corners     | top `(16,0)`, right `(32,8)`, bottom `(16,16)`, left `(0,8)`.          |
| Pixel ratio         | 2 horizontal : 1 vertical. Tile edges run at a 2:1 slope.             |
| Light source        | **Top-left**, fixed. Top faces brightest, left walls mid, right dark. |
| Altitude step       | **4 px** of vertical lift per altitude level (`ALT_STEP=4`).          |
| Palette             | **Limited** — see §1.2. No gradients, no anti-aliased soft edges.     |
| Background          | **Fully transparent** (alpha 0). No checkerboard, no matte, no halo.  |
| Outline             | None / minimal. Do NOT add a cartoon black keyline around tiles.      |

### 1.1 Anchoring — THE most important rule

Buildings are taller than one tile. They are composited so that the **bottom diamond of the
sprite sits on the target ground tile, and the building grows UPWARD** from there.

```
   sprite canvas (W × H)
  ┌───────────────────────┐
  │        (roof)         │   ← building rises toward the top of the canvas
  │      ▟███████▙        │
  │     ███████████       │
  │      ▜███████▛        │
  │ ─ ─ ─ ╱◆╲ ─ ─ ─ ─ ─   │   ← the GROUND DIAMOND. Its CENTER is the anchor.
  │      ╱ ◆ ╲            │      Ground diamond = bottom 32×16 of the footprint.
  └───────────────────────┘
            ▲
   anchor point = horizontal center, and vertically the center of the
   ground diamond (NOT the bottom edge of the canvas).
```

Rules for the generator output:

- The **ground footprint diamond must be flush with the BOTTOM of the image canvas.**
  For a 1×1 tile, the diamond occupies the bottom-most 32×16 region.
- Extra height for the building extends **upward** (toward y=0 / top of canvas).
- Horizontal center of the diamond = horizontal center of the canvas.
- A **1×N / N×N footprint** scales the base diamond: an `f`×`f` footprint has a ground
  diamond `32*f` wide × `16*f` tall. Keep it centered horizontally, flush to bottom.

The packer records each frame's rect; the renderer applies the anchor via
`PlaceholderTextures.boxAnchorY()`-style logic (ground-diamond center → screen position),
so **as long as the ground diamond is bottom-flush and centered, placement is automatic.**

### 1.2 Palette

Use a **limited, flat palette** (think SNES-era SC2K). Per material, pick **one base color +
two shades** (light top / dark right) — no smooth gradients.

- Grass/land: muted green `#5A8F4A`
- Water: blue `#2F6F9F`
- Shore/sand: tan `#C2B280`
- Forest: dark green `#2F6B34`
- Road: asphalt grey `#4A4A4A` with light markings
- Residential: warm greens/creams; Commercial: blues/teals; Industrial: ochre/grey
- Power lines/poles: dark grey

Keep colors consistent across stages of the same zone (a stage-4 res tower is a *taller*
version of the stage-1 house, not a different hue).

---

## 2. Anchor prompt (paste into the image generator)

Reuse this **verbatim** for every sprite, swapping only `{BUILDING_DESCRIPTION}`. The
constant preamble is what keeps angle, scale, palette, and lighting consistent across a
whole tileset. Generate **one sprite per image** on a transparent background.

```
Pixel-art sprite, single isometric tile, for a SimCity-2000-style city builder.

STRICT STYLE (identical for every sprite in this set):
- 2:1 isometric (dimetric) projection. The ground tile is a flat diamond exactly
  32 pixels wide and 16 pixels tall; tile edges run at a 2:1 slope. NOT a true 30-degree
  isometric, NOT a frontal view, NOT top-down.
- Crisp pixel art. Hard-edged pixels, NO anti-aliasing, NO blur, NO soft shadows,
  NO gradients. Flat color fills with at most one lighter and one darker shade per surface.
- Limited retro palette (SNES era). One base color plus a light and a dark shade per face.
- Light comes from the TOP-LEFT and is constant: top faces are brightest, left-facing
  walls are mid-tone, right-facing walls are darkest.
- Fully TRANSPARENT background (alpha). No ground plane outside the diamond, no drop
  shadow, no outline halo, no checkerboard, no border, no text, no UI.
- The footprint diamond sits FLUSH against the BOTTOM-CENTER of the image; any building
  mass rises UPWARD from that diamond. Horizontally centered.

SUBJECT: {BUILDING_DESCRIPTION}

OUTPUT: one single tile sprite, transparent PNG, centered, nothing else in frame.
```

Recommended generation size: render large (e.g. 512×512) for clean pixels, then downscale
with **nearest-neighbor** to the target tile size before saving (see §4 sizing). nano-banana
/ ChatGPT Image tend to add soft edges — downscaling nearest-neighbor and snapping the
background to full transparency cleans that up.

### Example fills for `{BUILDING_DESCRIPTION}`

- Terrain grass: `a flat diamond patch of short green grass, no objects on it`
- Road straight: `a flat asphalt road tile running straight, with faint dashed center line`
- Res light s1: `a single small suburban house with a pitched roof and a tiny front yard`
- Res light s4: `a cluster of two-story suburban townhouses filling the lot`
- Res dense s8: `a tall residential apartment tower, ~10 stories, flat roof with rooftop units`
- Com dense s8: `a glass commercial office skyscraper with a blue tinted curtain wall`
- Ind light s2: `a low industrial warehouse with a corrugated roof and a loading bay`
- Coal plant: `a coal power station with two cooling towers and a smokestack`
- Police: `a small police station, blue accents, with a flag and a squad car out front`
- Fire: `a fire station with a red engine bay door`
- Park: `a small green park with trees, a path, and a pond`

---

## 3. Sprite list (exhaustive)

Every file goes directly in `packages/client/assets/sprites/` as a transparent PNG. The
**file name (without `.png`) becomes the atlas frame key** in `atlas.json`. Frame keys are
what the renderer/registry look up.

### 3.1 Terrain transitions — **16 tiles**

A 4-bit edge mask describes which of the 4 diamond edges border **water** (used to blend
land→shore→water). Bit order: `N=1, E=2, S=4, W=8` (N = the top-right edge in screen space,
going clockwise). Value `0` = fully inland land, `15` = surrounded by water (full water).

```
terrain_0.png   terrain_1.png   terrain_2.png  ... terrain_15.png   (16 files)
```

### 3.2 Road connections — **16 tiles**

Auto-tiling mask of which neighbors a road connects to. Same bit order `N=1,E=2,S=4,W=8`.
`0` = isolated stub, `5` = straight N–S, `10` = straight E–W, `15` = 4-way crossroads, etc.

```
road_0.png   road_1.png  ... road_15.png   (16 files)
```

(Rail and power line reuse the same 16-mask convention if/when added: `rail_0..15`,
`power_line_0..15`. Not required for the first pass — road only.)

### 3.3 Zones R / C / I, light & dense, per growth stage

Light zones grow through **stages 1–4**; dense zones through **stages 1–8** (mirrors
`ZONE_GROWTH.maxStage` in `sim-core`). Naming: `building_<cat>_<density>_s<stage>`.

| Category        | density | stages | files                                            |
| --------------- | ------- | ------ | ------------------------------------------------ |
| Residential `res` | light   | 1–4    | `building_res_light_s1` … `building_res_light_s4` |
| Residential `res` | dense   | 1–8    | `building_res_dense_s1` … `building_res_dense_s8` |
| Commercial `com`  | light   | 1–4    | `building_com_light_s1` … `building_com_light_s4` |
| Commercial `com`  | dense   | 1–8    | `building_com_dense_s1` … `building_com_dense_s8` |
| Industrial `ind`  | light   | 1–4    | `building_ind_light_s1` … `building_ind_light_s4` |
| Industrial `ind`  | dense   | 1–8    | `building_ind_dense_s1` … `building_ind_dense_s8` |

= 4+8+4+8+4+8 = **36 zone-building tiles.** Higher stages are taller (more lift) — keep the
ground diamond bottom-flush so they grow upward.

Optional: a `building_<cat>_<density>_empty` plain dirt/graded-lot tile shown right after
zoning, before stage 1 develops. Nice-to-have, not required.

### 3.4 Power plants, services, amenities — **5 tiles**

Names match the registry `sprite` keys (`packages/sim-core/src/tiles/registry.ts`) with a
`building_` prefix for consistency with the zone files:

```
building_coal_plant.png    (Coal Power Plant,  1×1)
building_gas_plant.png      (Gas Turbine,       1×1)
building_police.png         (Police Station,    1×1)
building_fire.png           (Fire Station,      1×1)
building_park.png           (Park,              1×1)
```

### 3.5 Frame-key → registry mapping

The `sim-core` registry currently stores logical keys like `zone_res_light`, `coal_plant`,
`road`. The atlas frame keys above are the **rendered, stage-aware** names. Mapping the
renderer applies:

| Registry `sprite` | Atlas frame(s)                                      |
| ----------------- | --------------------------------------------------- |
| `zone_res_light`  | `building_res_light_s{stage}` (stage from tile data) |
| `zone_res_dense`  | `building_res_dense_s{stage}`                        |
| `zone_com_light`  | `building_com_light_s{stage}`                        |
| `zone_com_dense`  | `building_com_dense_s{stage}`                        |
| `zone_ind_light`  | `building_ind_light_s{stage}`                        |
| `zone_ind_dense`  | `building_ind_dense_s{stage}`                        |
| `coal_plant`      | `building_coal_plant`                                |
| `gas_plant`       | `building_gas_plant`                                 |
| `police`          | `building_police`                                    |
| `fire`            | `building_fire`                                      |
| `park`            | `building_park`                                      |
| `road`            | `road_{mask}`                                         |
| (terrain)         | `terrain_{mask}`                                      |

**Grand total: 16 terrain + 16 road + 36 zone + 5 building = 73 sprites** (plus optional
empty-lot / rail / power-line variants).

---

## 4. File format & naming

- **Format:** PNG, RGBA, 8-bit/channel, transparent background. Indexed (palette) PNG is
  fine — the packer decodes palette + truecolor + grayscale. **Interlaced PNG is rejected**
  (re-export non-interlaced).
- **Sizing:** the ground diamond must be 32 px wide × 16 px tall (×footprint). Building
  height is whatever the structure needs above that. Typical 1×1 tile canvas: 32 px wide,
  16–96 px tall. Downscale from the large generation to exact pixels with nearest-neighbor.
- **Naming:** lower snake_case, `.png` extension, **no spaces**. The stem is the atlas key.

```
<group>_<descriptor>[_s<stage>].png

terrain_0.png          terrain_15.png
road_0.png             road_15.png
building_res_light_s1.png   building_res_dense_s8.png
building_com_light_s3.png   building_ind_dense_s5.png
building_coal_plant.png     building_police.png
```

A file named `building_res_light_s3.png` produces atlas frame key `building_res_light_s3`.

---

## 5. Output (`pnpm build:atlas`)

`scripts/build-atlas.ts` packs every `sprites/*.png` into a single texture:

- `packages/client/public/atlas.png` — the packed sheet (transparent background preserved).
- `packages/client/public/atlas.json` — `{ "frames": { "<key>": { "x", "y", "w", "h" } }, "meta": {...} }`.

The packer has **no heavy dependencies** (pure Node built-ins: `node:fs`, `node:zlib`). It
runs cleanly on an empty `sprites/` folder (prints a warning and writes an empty atlas), so
`pnpm build:atlas` never crashes the build.
