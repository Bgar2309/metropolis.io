// Power distribution. A tile conducts power if it carries a power line, holds a power
// plant, or is zoned (so dragging a line to touch a zone block energises it). We flood
// from every plant across the conductive network, sum plant output as supply, then walk
// connected consumers in index order spending the supply budget — anything past the
// budget browns out (power = 0). Deterministic: BFS order is index order.

import type { SimPass, SimContext } from "../engine.js";
import { Net } from "../constants.js";
import { Build, getStructure, isPowerPlant, tilePowerDemand } from "../buildings.js";

export class PowerSystem implements SimPass {
  readonly name = "power";

  update({ world }: SimContext): void {
    const { size, width } = world;
    const conductive = (i: number): boolean =>
      (world.net[i]! & Net.PowerLine) !== 0 ||
      world.building[i]! !== Build.None ||
      world.zone[i]! !== 0;

    const visited = new Uint8Array(size);
    const queue: number[] = [];
    let supply = 0;

    // Seed BFS from every plant tile.
    for (let i = 0; i < size; i++) {
      const b = world.building[i]!;
      if (isPowerPlant(b)) {
        supply += getStructure(b).powerOutput;
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
        world.power[i] = 0;
        continue;
      }
      let d = tilePowerDemand(world.zone[i]!, world.stage[i]!);
      const b = world.building[i]!;
      if (b !== Build.None) d += getStructure(b).powerDemand;
      demand += d;
      if (d === 0) {
        world.power[i] = 1; // conductive but not a consumer (line / plant / empty zone)
      } else if (spent + d <= supply) {
        spent += d;
        world.power[i] = 1;
      } else {
        world.power[i] = 0; // brownout
      }
    }

    world.stats.powerSupply = supply;
    world.stats.powerDemand = demand;
    world.stats.brownout = demand > supply;
  }
}
