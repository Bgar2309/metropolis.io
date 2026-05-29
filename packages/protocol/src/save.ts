// Versioned save-file + action-log schemas, shared by client (local + cloud saves) and
// server (cloud storage + ranked verification). The tile buffers are stored base64 so a
// save round-trips through JSON; a binary codec can replace this later without changing
// the logical shape.

import { z } from "zod";

// Bump when the on-disk shape changes; the loader migrates older versions forward.
export const SAVE_VERSION = 1;

// A single packed tile layer: a name + base64-encoded typed-array bytes.
export const TileLayer = z.object({
  name: z.string(),
  // "u8" | "u16" — element width so the loader rebuilds the right TypedArray.
  dtype: z.enum(["u8", "u16"]),
  base64: z.string(),
});
export type TileLayer = z.infer<typeof TileLayer>;

export const CityStats = z.object({
  population: z.number().int(),
  funds: z.number().int(),
  rDemand: z.number(),
  cDemand: z.number(),
  iDemand: z.number(),
});
export type CityStats = z.infer<typeof CityStats>;

export const Policy = z.object({
  taxR: z.number(),
  taxC: z.number(),
  taxI: z.number(),
  fundPolice: z.number(),
  fundFire: z.number(),
});
export type Policy = z.infer<typeof Policy>;

export const SaveFile = z.object({
  version: z.literal(SAVE_VERSION),
  simVersion: z.string(), // sim-core semver; guards replay compatibility
  name: z.string(),
  seed: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  tick: z.number().int().nonnegative(),
  rngState: z.number().int(),
  stats: CityStats,
  policy: Policy,
  layers: z.array(TileLayer),
});
export type SaveFile = z.infer<typeof SaveFile>;

// --- Action log (replay / ranked verification) ---

// Mirror of sim-core's Command union. Kept structurally identical; a test in sim-core
// (added later) asserts the two stay in sync.
export const Command = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("zone"), x: z.number().int(), y: z.number().int(), zone: z.number().int() }),
  z.object({ kind: z.literal("bulldoze"), x: z.number().int(), y: z.number().int() }),
  z.object({ kind: z.literal("road"), x: z.number().int(), y: z.number().int() }),
  z.object({ kind: z.literal("powerline"), x: z.number().int(), y: z.number().int() }),
  z.object({ kind: z.literal("placeBuilding"), x: z.number().int(), y: z.number().int(), build: z.number().int() }),
  z.object({ kind: z.literal("setTax"), cat: z.enum(["R", "C", "I"]), rate: z.number() }),
  z.object({ kind: z.literal("setFunding"), service: z.enum(["police", "fire"]), level: z.number() }),
  z.object({ kind: z.literal("setSpeed"), speed: z.number().int() }),
]);
export type Command = z.infer<typeof Command>;

export const LoggedCommand = z.object({
  tick: z.number().int().nonnegative(),
  cmd: Command,
});
export type LoggedCommand = z.infer<typeof LoggedCommand>;

export const ActionLog = z.object({
  version: z.literal(SAVE_VERSION),
  simVersion: z.string(),
  seed: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  commands: z.array(LoggedCommand),
  // Claimed final-state hash; the server recomputes it by replaying `commands`.
  finalHash: z.number().int(),
});
export type ActionLog = z.infer<typeof ActionLog>;
