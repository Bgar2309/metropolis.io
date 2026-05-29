// Enumerations and tunables shared across the simulation. Kept as plain const objects
// (not TS enums) so they erase cleanly under verbatimModuleSyntax and pack into bytes.

export const Terrain = {
  Land: 0,
  Water: 1,
  Shore: 2,
  Forest: 3,
} as const;
export type TerrainType = (typeof Terrain)[keyof typeof Terrain];

export const Zone = {
  None: 0,
  ResLight: 1,
  ResDense: 2,
  ComLight: 3,
  ComDense: 4,
  IndLight: 5,
  IndDense: 6,
} as const;
export type ZoneType = (typeof Zone)[keyof typeof Zone];

// Surface network is a bitfield so a tile can carry several pieces (e.g. road + power
// line crossing, or a zone tile that also conducts power).
export const Net = {
  None: 0,
  Road: 1 << 0,
  Rail: 1 << 1,
  PowerLine: 1 << 2,
} as const;

// Underground layer (separate from the surface): water pipes and subway.
export const Under = {
  None: 0,
  Pipe: 1 << 0,
  Subway: 1 << 1,
} as const;

export const ALTITUDE_MAX = 31;
export const SEA_LEVEL = 4;

// Game speed -> simulation ticks per real second (the render loop drives wall-clock;
// the engine itself counts only ticks, never real time).
export const Speed = {
  Paused: 0,
  Slow: 1,
  Medium: 4,
  Fast: 16,
} as const;
export type SpeedType = (typeof Speed)[keyof typeof Speed];

// One in-game day per tick; 30 ticks = a month, 360 = a year (simplified calendar).
export const TICKS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const TICKS_PER_YEAR = TICKS_PER_MONTH * MONTHS_PER_YEAR;

export const START_YEAR = 1900;
export const START_FUNDS = 20000;
