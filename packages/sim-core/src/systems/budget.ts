// Monthly budget. Runs only on month boundaries. Income is per-capita/​per-job tax
// scaled by the relevant rate; expenses are service maintenance (scaled by funding) plus
// flat plant/amenity upkeep. Net is applied to funds and the last cycle is stored for
// the budget panel.

import type { SimPass, SimContext } from "../engine.js";
import { TICKS_PER_MONTH } from "../constants.js";
import { Build, getStructure, zoneCapacity, tileOccupancy } from "../buildings.js";

const PER_CAPITA = 4; // monthly tax dollars per resident/job at 100% rate

export class BudgetSystem implements SimPass {
  readonly name = "budget";

  update({ world, tick }: SimContext): void {
    if (tick % TICKS_PER_MONTH !== 0) return;

    let income = 0;
    let expense = 0;
    for (let i = 0; i < world.size; i++) {
      const z = zoneCapacity(world.zone[i]!);
      if (z && world.stage[i]! > 0) {
        const occ = tileOccupancy(world.zone[i]!, world.stage[i]!);
        const rate = z.cat === "R" ? world.policy.taxR : z.cat === "C" ? world.policy.taxC : world.policy.taxI;
        income += occ * (rate / 100) * PER_CAPITA;
      }
      const b = world.building[i]!;
      if (b !== Build.None) {
        const def = getStructure(b);
        if (b === Build.Police) expense += def.maintenance * (world.policy.fundPolice / 100);
        else if (b === Build.Fire) expense += def.maintenance * (world.policy.fundFire / 100);
        else expense += def.maintenance;
      }
    }

    income = Math.round(income);
    expense = Math.round(expense);
    world.stats.lastIncome = income;
    world.stats.lastExpense = expense;
    world.stats.funds += income - expense;
  }
}
