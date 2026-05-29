// Catalog of placeable structures (power plants + civic services) and the capacity
// table for auto-developing zone buildings. Phase 1 keeps every structure single-tile;
// real SC2000 footprints (4x4 plants, etc.) arrive in Phase 2 alongside the art pass.

import { Zone, type ZoneType } from "./constants.js";

// Placeable structure ids stored in World.building (0 = none / zone building).
export const Build = {
  None: 0,
  CoalPlant: 1,
  GasPlant: 2,
  Police: 3,
  Fire: 4,
  Park: 5,
} as const;
export type BuildType = (typeof Build)[keyof typeof Build];

export interface StructureDef {
  id: BuildType;
  name: string;
  kind: "power" | "service" | "amenity";
  cost: number;
  maintenance: number; // $/month at 100% funding
  powerOutput: number; // power units supplied (plants)
  powerDemand: number; // power units consumed
  pollution: number; // emitted at the source tile
  coverage: number; // effect radius in tiles (services/amenities)
}

export const STRUCTURES: Record<BuildType, StructureDef> = {
  [Build.None]: { id: Build.None, name: "—", kind: "amenity", cost: 0, maintenance: 0, powerOutput: 0, powerDemand: 0, pollution: 0, coverage: 0 },
  [Build.CoalPlant]: { id: Build.CoalPlant, name: "Coal Power Plant", kind: "power", cost: 4000, maintenance: 100, powerOutput: 2000, powerDemand: 0, pollution: 60, coverage: 0 },
  [Build.GasPlant]: { id: Build.GasPlant, name: "Gas Turbine", kind: "power", cost: 2000, maintenance: 50, powerOutput: 500, powerDemand: 0, pollution: 18, coverage: 0 },
  [Build.Police]: { id: Build.Police, name: "Police Station", kind: "service", cost: 500, maintenance: 100, powerOutput: 0, powerDemand: 8, pollution: 0, coverage: 12 },
  [Build.Fire]: { id: Build.Fire, name: "Fire Station", kind: "service", cost: 500, maintenance: 100, powerOutput: 0, powerDemand: 8, pollution: 0, coverage: 12 },
  [Build.Park]: { id: Build.Park, name: "Park", kind: "amenity", cost: 150, maintenance: 5, powerOutput: 0, powerDemand: 0, pollution: 0, coverage: 5 },
};

export interface ZoneCapacity {
  cat: "R" | "C" | "I";
  dense: boolean;
  maxStage: number; // top growth stage
  capPerStage: number; // residents (R) or jobs (C/I) added per stage
  powerPerStage: number; // power units demanded per stage
}

const ZONE_CAP: Partial<Record<ZoneType, ZoneCapacity>> = {
  [Zone.ResLight]: { cat: "R", dense: false, maxStage: 4, capPerStage: 16, powerPerStage: 4 },
  [Zone.ResDense]: { cat: "R", dense: true, maxStage: 8, capPerStage: 40, powerPerStage: 6 },
  [Zone.ComLight]: { cat: "C", dense: false, maxStage: 4, capPerStage: 12, powerPerStage: 5 },
  [Zone.ComDense]: { cat: "C", dense: true, maxStage: 8, capPerStage: 30, powerPerStage: 8 },
  [Zone.IndLight]: { cat: "I", dense: false, maxStage: 4, capPerStage: 14, powerPerStage: 6 },
  [Zone.IndDense]: { cat: "I", dense: true, maxStage: 8, capPerStage: 35, powerPerStage: 10 },
};

export function zoneCapacity(zone: number): ZoneCapacity | undefined {
  return ZONE_CAP[zone as ZoneType];
}

// Safe lookup from a raw tile byte (which is typed as number, not BuildType).
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
