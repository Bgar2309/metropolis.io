// World <-> SaveFile (protocol) conversion. Tile buffers are base64-encoded so a save
// round-trips through plain JSON (cloud storage in Phase 4 can swap in a binary codec
// without changing the logical shape). Environment-neutral base64 (no btoa/Buffer) keeps
// sim-core runnable in both the browser worker and Node.

import { World } from "./world.js";
import { SAVE_VERSION, type SaveFile, type TileLayer } from "@metro/protocol";

export const SIM_VERSION = "0.1.0";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToB64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[b2 & 63] : "=";
  }
  return out;
}

function b64ToBytes(str: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) lookup[B64.charCodeAt(i)] = i;
  const clean = str.replace(/=+$/, "");
  const len = (clean.length * 3) >> 2;
  const out = new Uint8Array(len);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = lookup[clean.charCodeAt(i)]!;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

function u8Layer(name: string, arr: Uint8Array): TileLayer {
  return { name, dtype: "u8", base64: bytesToB64(arr) };
}

function u16Layer(name: string, arr: Uint16Array): TileLayer {
  return { name, dtype: "u16", base64: bytesToB64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)) };
}

// buildingOrigin is a Uint32Array. The save protocol's dtype enum only knows u8/u16, so we
// persist the raw little-endian bytes (4 per cell) and reconstruct the typed view by layer
// name in fromSave — the dtype tag is just transport metadata here.
function u32AsBytesLayer(name: string, arr: Uint32Array): TileLayer {
  return { name, dtype: "u8", base64: bytesToB64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)) };
}

const U8_FIELDS = [
  "terrain",
  "altitude",
  "zone",
  "stage",
  "net",
  "under",
  "landValue",
  "pollution",
  "crime",
  "traffic",
  "power",
  "water",
  "policeCov",
  "fireCov",
] as const;

export function toSave(world: World, name: string, seed: number): SaveFile {
  const layers: TileLayer[] = [];
  for (const f of U8_FIELDS) layers.push(u8Layer(f, world[f]));
  layers.push(u16Layer("building", world.building));
  layers.push(u32AsBytesLayer("buildingOrigin", world.buildingOrigin));

  return {
    version: SAVE_VERSION,
    simVersion: SIM_VERSION,
    name,
    seed,
    width: world.width,
    height: world.height,
    tick: world.clock.tick,
    rngState: world.rng.getState(),
    stats: {
      population: world.stats.population,
      funds: world.stats.funds,
      rDemand: world.stats.rDemand,
      cDemand: world.stats.cDemand,
      iDemand: world.stats.iDemand,
    },
    policy: { ...world.policy },
    layers,
  };
}

export function fromSave(save: SaveFile): { world: World; seed: number } {
  const world = new World(save.width, save.height, save.seed);
  const byName = new Map(save.layers.map((l) => [l.name, l]));

  for (const f of U8_FIELDS) {
    const layer = byName.get(f);
    if (layer) world[f].set(b64ToBytes(layer.base64).subarray(0, world.size));
  }
  const bld = byName.get("building");
  if (bld) {
    const bytes = b64ToBytes(bld.base64);
    const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, world.size);
    world.building.set(u16);
  }
  const bo = byName.get("buildingOrigin");
  if (bo) {
    const bytes = b64ToBytes(bo.base64);
    const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, world.size);
    world.buildingOrigin.set(u32);
  }

  world.clock.tick = save.tick;
  world.rng.setState(save.rngState);
  world.stats.funds = save.stats.funds;
  world.stats.population = save.stats.population;
  world.stats.rDemand = save.stats.rDemand;
  world.stats.cDemand = save.stats.cDemand;
  world.stats.iDemand = save.stats.iDemand;
  Object.assign(world.policy, save.policy);

  return { world, seed: save.seed };
}
