// Building/zone data has moved to the unified, data-driven tile registry. This module is
// kept as a thin compatibility surface: it re-exports the same names (Build, STRUCTURES,
// zoneCapacity, getStructure, tileOccupancy, tilePowerDemand, and the StructureDef /
// ZoneCapacity types) so existing importers keep working unchanged. New code should import
// from ./tiles/registry.js directly and prefer the TILES registry as the source of truth.

export * from "./tiles/registry.js";
