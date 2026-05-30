import { describe, it, expect } from "vitest";
import { Build, TILES, getStructure, availableBuildings, isPowerPlant } from "./registry.js";

describe("power-plant catalogue", () => {
  it("makes a nuclear plant supply more power than a coal plant", () => {
    const nuclear = TILES[Build.NuclearPlant]!;
    const coal = TILES[Build.CoalPlant]!;
    expect(nuclear.power.output).toBeGreaterThan(coal.power.output);
    // and the legacy structure view agrees
    expect(getStructure(Build.NuclearPlant).powerOutput).toBeGreaterThan(getStructure(Build.CoalPlant).powerOutput);
  });

  it("classifies every new plant as a registry-driven power source", () => {
    for (const id of [Build.HydroPlant, Build.WindTurbine, Build.SolarPlant, Build.NuclearPlant, Build.MicrowavePlant]) {
      expect(isPowerPlant(id)).toBe(true);
      expect(getStructure(id).kind).toBe("power");
    }
    expect(isPowerPlant(Build.Park)).toBe(false);
    expect(isPowerPlant(Build.None)).toBe(false);
  });

  it("keeps renewables clean and fossil plants polluting", () => {
    expect(TILES[Build.WindTurbine]!.pollution).toBe(0);
    expect(TILES[Build.SolarPlant]!.pollution).toBe(0);
    expect(TILES[Build.HydroPlant]!.pollution).toBe(0);
    expect(TILES[Build.CoalPlant]!.pollution).toBeGreaterThan(TILES[Build.NuclearPlant]!.pollution);
  });
});

describe("availableBuildings(year)", () => {
  it("hides wind turbines before their unlock year and reveals them after", () => {
    const ids1979 = availableBuildings(1979).map((t) => t.id);
    const ids1980 = availableBuildings(1980).map((t) => t.id);
    expect(ids1979).not.toContain(Build.WindTurbine);
    expect(ids1980).toContain(Build.WindTurbine);
  });

  it("gates each plant on its historical introduction year", () => {
    expect(availableBuildings(1900).map((t) => t.id)).not.toContain(Build.NuclearPlant);
    expect(availableBuildings(1955).map((t) => t.id)).toContain(Build.NuclearPlant);
    expect(availableBuildings(1990).map((t) => t.id)).toContain(Build.SolarPlant);
    expect(availableBuildings(2019).map((t) => t.id)).not.toContain(Build.MicrowavePlant);
    expect(availableBuildings(2020).map((t) => t.id)).toContain(Build.MicrowavePlant);
  });

  it("always offers the game-start plants and never the empty tile", () => {
    const ids = availableBuildings(1900).map((t) => t.id);
    expect(ids).toContain(Build.CoalPlant);
    expect(ids).toContain(Build.GasPlant);
    expect(ids).toContain(Build.HydroPlant);
    expect(ids).not.toContain(Build.None);
  });
});
