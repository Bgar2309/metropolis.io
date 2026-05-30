// Message contract between the render thread and the simulation Web Worker.

import type { Command } from "@metro/sim-core";
import type { SaveFile } from "@metro/protocol";

export type OverlayKind =
  | "none"
  | "landvalue"
  | "pollution"
  | "crime"
  | "traffic"
  | "power"
  | "police"
  | "fire";

// main -> worker
export type ToWorker =
  | { type: "init"; width: number; height: number; seed: number }
  | { type: "command"; cmd: Command }
  | { type: "setSpeed"; speed: number }
  | { type: "setOverlay"; overlay: OverlayKind }
  | { type: "query"; x: number; y: number }
  | { type: "save" }
  | { type: "load"; save: SaveFile };

export interface CityStatsMsg {
  tick: number;
  year: number;
  month: number;
  population: number;
  jobs: number;
  funds: number;
  rDemand: number;
  cDemand: number;
  iDemand: number;
  powerSupply: number;
  powerDemand: number;
  brownout: boolean;
  lastIncome: number;
  lastExpense: number;
  taxR: number;
  taxC: number;
  taxI: number;
  fundPolice: number;
  fundFire: number;
}

export interface QueryResult {
  x: number;
  y: number;
  terrain: number;
  altitude: number;
  zone: number;
  building: number;
  stage: number;
  net: number;
  powered: boolean;
  landValue: number;
  pollution: number;
  crime: number;
  policeCov: number;
  fireCov: number;
}

// worker -> main
export type FromWorker =
  | {
      // Static terrain, sent once after init/load. Buffers transferred (zero-copy).
      type: "snapshot";
      width: number;
      height: number;
      terrain: Uint8Array;
      altitude: Uint8Array;
    }
  | {
      // Per-tick surface state + stats. Full surface arrays (simple + robust for Phase 1).
      type: "tick";
      stats: CityStatsMsg;
      zone: Uint8Array;
      stage: Uint8Array;
      net: Uint8Array;
      building: Uint16Array;
      power: Uint8Array;
      overlay: OverlayKind;
      overlayField: Uint8Array | null;
    }
  | { type: "queryResult"; result: QueryResult }
  | { type: "saved"; save: SaveFile };
