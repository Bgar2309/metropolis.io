import type { SimPass } from "../engine.js";
import { PowerSystem } from "./power.js";
import { FieldsSystem } from "./fields.js";
import { DemandSystem } from "./demand.js";
import { GrowthSystem } from "./growth.js";
import { BudgetSystem } from "./budget.js";

export { PowerSystem, FieldsSystem, DemandSystem, GrowthSystem, BudgetSystem };

// The Phase-1 simulation pipeline, in dependency order:
//   power -> fields -> demand -> growth -> budget
export function createDefaultPasses(): SimPass[] {
  return [new PowerSystem(), new FieldsSystem(), new DemandSystem(), new GrowthSystem(), new BudgetSystem()];
}
