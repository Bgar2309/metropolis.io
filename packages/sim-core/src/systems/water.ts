// Water distribution. The exact analog of PowerSystem, but on the underground pipe layer
// instead of the surface power network. A tile conducts water if it carries a pipe, holds
// a building, or is zoned (so a pipe touching a zone block irrigates it). We flood from
// every pump/water tower/treatment plant across the conductive network, sum source output
// as supply, then walk connected consumers in index order spending the supply budget —
// anything past the budget runs dry (water = 0). Deterministic: BFS order is index order.

import type { SimPass, SimContext } from "../engine.js";
import { Under } from "../constants.js";
import { Build, getStructure, tileWaterDemand, isWaterSource } from "../buildings.js";

export class WaterSystem implements SimPass {
  readonly name = "water";

  update({ world }: SimContext): void {
    const { size, width } = world;
    const conductive = (i: number): boolean =>
      (world.under[i]! & Under.Pipe) !== 0 ||
      world.building[i]! !== Build.None ||
      world.zone[i]! !== 0;

    const visited = new Uint8Array(size);
    const queue: number[] = [];
    let supply = 0;

    // Seed BFS from every water-source tile.
    for (let i = 0; i < size; i++) {
      const b = world.building[i]!;
      if (isWaterSource(b)) {
        supply += getStructure(b).waterOutput;
        if (!visited[i]) {
          visited[i] = 1;
          queue.push(i);
        }
      }
    }

    // Flood across 4-connected conductive tiles.
    while (queue.length) {
      const i = queue.pop()!;
      const x = i % width;
      const y = (i / width) | 0;
      const tryNeighbor = (nx: number, ny: number): void => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= world.height) return;
        const ni = ny * width + nx;
        if (visited[ni] || !conductive(ni)) return;
        visited[ni] = 1;
        queue.push(ni);
      };
      tryNeighbor(x - 1, y);
      tryNeighbor(x + 1, y);
      tryNeighbor(x, y - 1);
      tryNeighbor(x, y + 1);
    }

    // Allocate supply to connected consumers in index order.
    let demand = 0;
    let spent = 0;
    for (let i = 0; i < size; i++) {
      if (!visited[i]) {
        world.water[i] = 0;
        continue;
      }
      let d = tileWaterDemand(world.zone[i]!, world.stage[i]!);
      const b = world.building[i]!;
      if (b !== Build.None) d += getStructure(b).waterDemand;
      demand += d;
      if (d === 0) {
        world.water[i] = 1; // conductive but not a consumer (pipe / source / empty zone)
      } else if (spent + d <= supply) {
        spent += d;
        world.water[i] = 1;
      } else {
        world.water[i] = 0; // ran dry
      }
    }

    world.stats.waterSupply = supply;
    world.stats.waterDemand = demand;
    world.stats.drought = demand > supply;
  }
}
