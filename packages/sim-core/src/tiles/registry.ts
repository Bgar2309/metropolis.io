// Data-driven tile registry: the single source of truth for every placeable thing in
// the game — zones, surface networks, and standalone buildings. Anything that needs to
// know a tile's cost, power balance, footprint, sprite, etc. reads it from TILES instead
// of hard-coding values in a switch. Numeric values here mirror the legacy STRUCTURES /
// ZONE_CAP tables exactly so existing behaviour (and tests) are unchanged.

import { Net, Zone, type ZoneType } from "../constants.js";

// A single placeable tile definition. Stable `id` is what gets (or will get) serialized.
export interface TileDef {
  id: number; // stable, serialized
  kind: "zone" | "net" | "building";
  name: string;
  footprint: { w: number; h: number };
  cost: number;
  maintenance: number; // $/month at 100% funding
  power: { output: number; demand: number }; // units supplied / consumed
  water: { demand: number }; // 0 everywhere for now (water sim is Phase 2)
  pollution: number; // emitted at the source tile
  coverage: number; // effect radius in tiles (services/amenities)
  sprite: string; // atlas key (logical name)
  unlockPop?: number; // population gate, if any
}

// --- id namespaces -------------------------------------------------------------------
// Buildings keep their legacy Build byte (0-5) so World.building bytes map straight to a
// tile id. Zones and nets live in separate high ranges so the three layers never collide
// inside the single TILES map.
export const Build = {
  None: 0,
  CoalPlant: 1,
  GasPlant: 2,
  Police: 3,
  Fire: 4,
  Park: 5,
} as const;
export type BuildType = (typeof Build)[keyof typeof Build];

const ZONE_ID_BASE = 0x100; // zone tile id = ZONE_ID_BASE + zone byte
const NET_ID_BASE = 0x200; // net tile id = NET_ID_BASE + net bit

const zoneTileId = (zone: ZoneType): number => ZONE_ID_BASE + zone;
const netTileId = (bit: number): number => NET_ID_BASE + bit;

// --- the registry --------------------------------------------------------------------
export const TILES: Record<number, TileDef> = {
  // Buildings (values identical to the former STRUCTURES table).
  [Build.None]: { id: Build.None, kind: "building", name: "—", footprint: { w: 1, h: 1 }, cost: 0, maintenance: 0, power: { output: 0, demand: 0 }, water: { demand: 0 }, pollution: 0, coverage: 0, sprite: "none" },
  [Build.CoalPlant]: { id: Build.CoalPlant, kind: "building", name: "Coal Power Plant", footprint: { w: 1, h: 1 }, cost: 4000, maintenance: 100, power: { output: 2000, demand: 0 }, water: { demand: 0 }, pollution: 60, coverage: 0, sprite: "coal_plant" },
  [Build.GasPlant]: { id: Build.GasPlant, kind: "building", name: "Gas Turbine", footprint: { w: 1, h: 1 }, cost: 2000, maintenance: 50, power: { output: 500, demand: 0 }, water: { demand: 0 }, pollution: 18, coverage: 0, sprite: "gas_plant" },
  [Build.Police]: { id: Build.Police, kind: "building", name: "Police Station", footprint: { w: 1, h: 1 }, cost: 500, maintenance: 100, power: { output: 0, demand: 8 }, water: { demand: 0 }, pollution: 0, coverage: 12, sprite: "police" },
  [Build.Fire]: { id: Build.Fire, kind: "building", name: "Fire Station", footprint: { w: 1, h: 1 }, cost: 500, maintenance: 100, power: { output: 0, demand: 8 }, water: { demand: 0 }, pollution: 0, coverage: 12, sprite: "fire" },
  [Build.Park]: { id: Build.Park, kind: "building", name: "Park", footprint: { w: 1, h: 1 }, cost: 150, maintenance: 5, power: { output: 0, demand: 0 }, water: { demand: 0 }, pollution: 0, coverage: 5, sprite: "park" },

  // Zones. Placement cost mirrors commands' COST_ZONE; growth-driven power/occupancy is
  // tracked per stage in ZONE_GROWTH below, so the base power demand here is 0.
  [zoneTileId(Zone.ResLight)]: { id: zoneTileId(Zone.ResLight), kind: "zone", name: "Light Residential", footprint: { w: 1, h: 1 }, cost: 10, maintenance: 0, power: { output: 0, demand: 0 }, water: { demand: 0 }, pollution: 0, coverage: 0, sprite: "zone_res_light" },
  [zoneTileId(Zone.ResDense)]: { id: zoneTileId(Zone.ResDense), kind: "zone", name: "Dense Residential", footprint: { w: 1, h: 1 }, cost: 10, maintenance: 0, power: { output: 0, demand: 0 }, water: { demand: 0 }, pollution: 0, coverage: 0, sprite: "zone_res_dense" },
  [zoneTileId(Zone.ComLight)]: { id: zoneTileId(Zone.ComLight), kind: "zone", name: "Light Commercial", footprint: { w: 1, h: 1 }, cost: 10, maintenance: 0, power: { output: 0, demand: 0 }, water: { demand: 0 }, pollution: 0, coverage: 0, sprite: "zone_com_light" },
  [zoneTileId(Zone.ComDense)]: { id: zoneTileId(Zone.ComDense), kind: "zone", name: "Dense Commercial", footprint: { w: 1, h: 1 }, cost: 10, maintenance: 0, power: { output: 0, demand: 0 }, water: { demand: 0 }, pollution: 0, coverage: 0, sprite: "zone_com_dense" },
  [zoneTileId(Zone.IndLight)]: { id: zoneTileId(Zone.IndLight), kind: "zone", name: "Light Industrial", footprint: { w: 1, h: 1 }, cost: 10, maintenance: 0, power: { output: 0, demand: 0 }, water: { demand: 0 }, pollution: 0, coverage: 0, sprite: "zone_ind_light" },
  [zoneTileId(Zone.IndDense)]: { id: zoneTileId(Zone.IndDense), kind: "zone", name: "Dense Industrial", footprint: { w: 1, h: 1 }, cost: 10, maintenance: 0, power: { output: 0, demand: 0 }, water: { demand: 0 }, pollution: 0, coverage: 0, sprite: "zone_ind_dense" },

  // Surface networks. Costs mirror commands' COST_ROAD / COST_POWERLINE.
  [netTileId(Net.Road)]: { id: netTileId(Net.Road), kind: "net", name: "Road", footprint: { w: 1, h: 1 }, cost: 10, maintenance: 0, power: { output: 0, demand: 0 }, water: { demand: 0 }, pollution: 0, coverage: 0, sprite: "road" },
  [netTileId(Net.Rail)]: { id: netTileId(Net.Rail), kind: "net", name: "Rail", footprint: { w: 1, h: 1 }, cost: 20, maintenance: 0, power: { output: 0, demand: 0 }, water: { demand: 0 }, pollution: 0, coverage: 0, sprite: "rail" },
  [netTileId(Net.PowerLine)]: { id: netTileId(Net.PowerLine), kind: "net", name: "Power Line", footprint: { w: 1, h: 1 }, cost: 5, maintenance: 0, power: { output: 0, demand: 0 }, water: { demand: 0 }, pollution: 0, coverage: 0, sprite: "power_line" },
};

// Lookup a tile by id. Undefined for unknown ids (callers decide on a fallback).
export function getTile(id: number): TileDef | undefined {
  return TILES[id];
}

// All tiles of a given kind, in registry order.
export function tilesByCategory(cat: TileDef["kind"]): TileDef[] {
  return Object.values(TILES).filter((t) => t.kind === cat);
}

// --- zone growth metadata ------------------------------------------------------------
// Per-stage residents/jobs and power demand for auto-developing zones. This lives next to
// the registry (rather than in TileDef) because it describes growth dynamics, not a fixed
// tile property; values are identical to the former ZONE_CAP table.
export interface ZoneCapacity {
  cat: "R" | "C" | "I";
  dense: boolean;
  maxStage: number; // top growth stage
  capPerStage: number; // residents (R) or jobs (C/I) added per stage
  powerPerStage: number; // power units demanded per stage
}

const ZONE_GROWTH: Record<number, ZoneCapacity> = {
  [zoneTileId(Zone.ResLight)]: { cat: "R", dense: false, maxStage: 4, capPerStage: 16, powerPerStage: 4 },
  [zoneTileId(Zone.ResDense)]: { cat: "R", dense: true, maxStage: 8, capPerStage: 40, powerPerStage: 6 },
  [zoneTileId(Zone.ComLight)]: { cat: "C", dense: false, maxStage: 4, capPerStage: 12, powerPerStage: 5 },
  [zoneTileId(Zone.ComDense)]: { cat: "C", dense: true, maxStage: 8, capPerStage: 30, powerPerStage: 8 },
  [zoneTileId(Zone.IndLight)]: { cat: "I", dense: false, maxStage: 4, capPerStage: 14, powerPerStage: 6 },
  [zoneTileId(Zone.IndDense)]: { cat: "I", dense: true, maxStage: 8, capPerStage: 35, powerPerStage: 10 },
};

// --- legacy structure view -----------------------------------------------------------
// The pre-registry StructureDef shape, kept so existing callers (commands, budget, power,
// fields) keep compiling. It is a flattened projection of the building TileDefs plus the
// old service/power/amenity categorisation, which is purely a building classification and
// has no place on the unified TileDef.
export interface StructureDef {
  id: BuildType;
  name: string;
  kind: "power" | "service" | "amenity";
  cost: number;
  maintenance: number;
  powerOutput: number;
  powerDemand: number;
  pollution: number;
  coverage: number;
}

const STRUCTURE_KIND: Record<BuildType, StructureDef["kind"]> = {
  [Build.None]: "amenity",
  [Build.CoalPlant]: "power",
  [Build.GasPlant]: "power",
  [Build.Police]: "service",
  [Build.Fire]: "service",
  [Build.Park]: "amenity",
};

function toStructure(id: BuildType): StructureDef {
  const t = TILES[id]!;
  return {
    id,
    name: t.name,
    kind: STRUCTURE_KIND[id],
    cost: t.cost,
    maintenance: t.maintenance,
    powerOutput: t.power.output,
    powerDemand: t.power.demand,
    pollution: t.pollution,
    coverage: t.coverage,
  };
}

export const STRUCTURES: Record<BuildType, StructureDef> = {
  [Build.None]: toStructure(Build.None),
  [Build.CoalPlant]: toStructure(Build.CoalPlant),
  [Build.GasPlant]: toStructure(Build.GasPlant),
  [Build.Police]: toStructure(Build.Police),
  [Build.Fire]: toStructure(Build.Fire),
  [Build.Park]: toStructure(Build.Park),
};

// --- compatibility helpers (now backed by the registry) ------------------------------

// Growth metadata for a developed zone tile, keyed by raw zone byte.
export function zoneCapacity(zone: number): ZoneCapacity | undefined {
  return ZONE_GROWTH[ZONE_ID_BASE + zone];
}

// Safe lookup from a raw building byte (typed as number, not BuildType).
export function getStructure(id: number): StructureDef {
  return STRUCTURES[id as BuildType] ?? STRUCTURES[Build.None];
}

// Population (R) or jobs (C/I) currently provided by a developed zone tile.
export function tileOccupancy(zone: number, stage: number): number {
  const z = zoneCapacity(zone);
  return z ? stage * z.capPerStage : 0;
}

// Power demanded by a developed zone tile this tick.
export function tilePowerDemand(zone: number, stage: number): number {
  const z = zoneCapacity(zone);
  return z ? stage * z.powerPerStage : 0;
}
