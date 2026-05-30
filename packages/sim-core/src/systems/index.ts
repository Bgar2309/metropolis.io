import type { SimPass } from "../engine.js";
import { PowerSystem } from "./power.js";
import { FieldsSystem } from "./fields.js";
import { DemandSystem } from "./demand.js";
import { TrafficSystem } from "./traffic.js";
import { GrowthSystem } from "./growth.js";
import { BudgetSystem } from "./budget.js";

export { PowerSystem, FieldsSystem, DemandSystem, TrafficSystem, GrowthSystem, BudgetSystem };

// The Phase-1 simulation pipeline, in dependency order:
//   power -> fields -> demand -> traffic -> growth -> budget
// Traffic runs before growth so each tile sees the current tick's congestion, which the
// growth pass folds into its desirability score.
export function createDefaultPasses(): SimPass[] {
  return [
    new PowerSystem(),
    new FieldsSystem(),
    new DemandSystem(),
    new TrafficSystem(),
    new GrowthSystem(),
    new BudgetSystem(),
  ];
}
