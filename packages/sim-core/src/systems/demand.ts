// City-wide RCI demand + population/jobs aggregates. Demand is the classic feedback
// loop: residents want to move in when jobs outnumber them; commerce grows to serve
// residents; industry has a high external-market baseline early on. Taxes above the
// 7% neutral point dampen the matching demand. Scans the live grid each tick (cheap),
// so there is no lag between growth and the demand it feeds back into.

import type { SimPass, SimContext } from "../engine.js";
import { zoneCapacity, tileOccupancy } from "../buildings.js";

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

export class DemandSystem implements SimPass {
  readonly name = "demand";

  update({ world }: SimContext): void {
    let rPop = 0;
    let cJobs = 0;
    let iJobs = 0;
    for (let i = 0; i < world.size; i++) {
      const z = zoneCapacity(world.zone[i]!);
      if (!z || world.stage[i]! === 0) continue;
      const occ = tileOccupancy(world.zone[i]!, world.stage[i]!);
      if (z.cat === "R") rPop += occ;
      else if (z.cat === "C") cJobs += occ;
      else iJobs += occ;
    }

    const taxPen = (rate: number): number => (rate - 7) * 0.03;

    world.stats.rDemand = clamp1(
      0.45 + ((cJobs + iJobs - rPop) / Math.max(150, rPop + 50)) * 0.8 - taxPen(world.policy.taxR),
    );
    world.stats.cDemand = clamp1(
      0.35 + ((rPop * 0.5 - cJobs) / Math.max(150, cJobs + 50)) * 0.8 - taxPen(world.policy.taxC),
    );
    world.stats.iDemand = clamp1(
      0.55 + ((rPop * 0.5 - iJobs) / Math.max(150, iJobs + 50)) * 0.8 - taxPen(world.policy.taxI),
    );

    world.stats.population = rPop;
    world.stats.jobs = cJobs + iJobs;
  }
}
