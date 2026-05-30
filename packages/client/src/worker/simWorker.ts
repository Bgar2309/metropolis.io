// The simulation worker. Owns the deterministic Engine (with the full Phase-1 pass
// pipeline), runs the fixed-timestep loop on a wall-clock interval scaled by game speed,
// and ships the static terrain snapshot + per-tick surface state & stats to the render
// thread. Also handles overlay selection, tile queries, and save/load.

import {
  Engine,
  generateTerrain,
  calendar,
  createDefaultPasses,
  toSave,
  fromSave,
  Speed,
  type World,
} from "@metro/sim-core";
import type { ToWorker, FromWorker, OverlayKind, CityStatsMsg } from "./messages.js";

let engine: Engine | null = null;
let seed = 0;
let overlay: OverlayKind = "none";

const LOOP_MS = 125;

function post(msg: FromWorker, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

function start(width: number, height: number, s: number): void {
  seed = s;
  engine = new Engine({ width, height, seed: s, passes: createDefaultPasses() });
  generateTerrain(engine.world, s);
  sendSnapshot(engine.world);
  engine.enqueue({ kind: "setSpeed", speed: Speed.Medium });
}

function sendSnapshot(world: World): void {
  const terrain = world.terrain.slice();
  const altitude = world.altitude.slice();
  post({ type: "snapshot", width: world.width, height: world.height, terrain, altitude }, [
    terrain.buffer,
    altitude.buffer,
  ]);
}

function overlayFieldOf(world: World): Uint8Array | null {
  switch (overlay) {
    case "landvalue":
      return world.landValue;
    case "pollution":
      return world.pollution;
    case "crime":
      return world.crime;
    case "traffic":
      return world.traffic;
    case "power":
      return world.power;
    case "police":
      return world.policeCov;
    case "fire":
      return world.fireCov;
    default:
      return null;
  }
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init":
      start(msg.width, msg.height, msg.seed);
      break;
    case "command":
      engine?.enqueue(msg.cmd);
      break;
    case "setSpeed":
      engine?.enqueue({ kind: "setSpeed", speed: msg.speed });
      break;
    case "setOverlay":
      overlay = msg.overlay;
      break;
    case "query": {
      if (!engine) break;
      const w = engine.world;
      const i = w.idx(msg.x, msg.y);
      if (!w.inBounds(msg.x, msg.y)) break;
      post({
        type: "queryResult",
        result: {
          x: msg.x,
          y: msg.y,
          terrain: w.terrain[i]!,
          altitude: w.altitude[i]!,
          zone: w.zone[i]!,
          building: w.building[i]!,
          stage: w.stage[i]!,
          net: w.net[i]!,
          powered: w.power[i]! === 1,
          landValue: w.landValue[i]!,
          pollution: w.pollution[i]!,
          crime: w.crime[i]!,
          policeCov: w.policeCov[i]!,
          fireCov: w.fireCov[i]!,
        },
      });
      break;
    }
    case "save":
      if (engine) post({ type: "saved", save: toSave(engine.world, "My City", seed) });
      break;
    case "load": {
      const { world } = fromSave(msg.save);
      engine = new Engine({ width: world.width, height: world.height, seed: msg.save.seed, passes: createDefaultPasses() });
      // Replace the fresh engine's world contents with the loaded ones.
      copyWorld(world, engine.world);
      seed = msg.save.seed;
      sendSnapshot(engine.world);
      engine.enqueue({ kind: "setSpeed", speed: Speed.Medium });
      break;
    }
  }
};

function copyWorld(src: World, dst: World): void {
  dst.terrain.set(src.terrain);
  dst.altitude.set(src.altitude);
  dst.zone.set(src.zone);
  dst.building.set(src.building);
  dst.stage.set(src.stage);
  dst.net.set(src.net);
  dst.under.set(src.under);
  dst.landValue.set(src.landValue);
  dst.pollution.set(src.pollution);
  dst.crime.set(src.crime);
  dst.traffic.set(src.traffic);
  dst.power.set(src.power);
  dst.water.set(src.water);
  dst.policeCov.set(src.policeCov);
  dst.fireCov.set(src.fireCov);
  dst.clock.tick = src.clock.tick;
  dst.rng.setState(src.rng.getState());
  Object.assign(dst.stats, src.stats);
  Object.assign(dst.policy, src.policy);
}

setInterval(() => {
  if (!engine) return;
  const speed = engine.getSpeed();
  if (speed > 0) engine.run(speed);

  const w = engine.world;
  const cal = calendar(w.clock.tick);
  const stats: CityStatsMsg = {
    tick: w.clock.tick,
    year: cal.year,
    month: cal.month,
    population: w.stats.population,
    jobs: w.stats.jobs,
    funds: w.stats.funds,
    rDemand: w.stats.rDemand,
    cDemand: w.stats.cDemand,
    iDemand: w.stats.iDemand,
    powerSupply: w.stats.powerSupply,
    powerDemand: w.stats.powerDemand,
    brownout: w.stats.brownout,
    lastIncome: w.stats.lastIncome,
    lastExpense: w.stats.lastExpense,
    taxR: w.policy.taxR,
    taxC: w.policy.taxC,
    taxI: w.policy.taxI,
    fundPolice: w.policy.fundPolice,
    fundFire: w.policy.fundFire,
  };

  // Copy surface arrays (transferred zero-copy; sim keeps its own buffers).
  const zone = w.zone.slice();
  const stage = w.stage.slice();
  const net = w.net.slice();
  const building = w.building.slice();
  const power = w.power.slice();
  const field = overlayFieldOf(w);
  const overlayField = field ? field.slice() : null;

  const transfer: Transferable[] = [
    zone.buffer,
    stage.buffer,
    net.buffer,
    building.buffer,
    power.buffer,
  ];
  if (overlayField) transfer.push(overlayField.buffer);

  post({ type: "tick", stats, zone, stage, net, building, power, overlay, overlayField }, transfer);
}, LOOP_MS);
