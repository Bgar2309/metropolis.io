// Aggregate, deterministic traffic model. No individual agents: every developed
// residential lot routes a single commute "flux" to its nearest reachable employment
// zone (commercial or industrial) over the road network, and that flow loads every road
// tile along the shortest path. The accumulated load lands in world.traffic[] (0..255),
// which the growth pass reads so congested corridors throttle the zones they serve.
//
// Determinism: the road graph is unweighted, so a breadth-first search yields shortest
// paths; every loop (commute sources, BFS frontier, neighbour expansion, tie-breaks)
// follows tile-index order, and every accumulated quantity is an integer. Same world in
// => same traffic out, with no floating-point dependence.

import type { SimPass, SimContext } from "../engine.js";
import { Net } from "../constants.js";
import { zoneCapacity } from "../buildings.js";

// How far (in road tiles) a commuter will search for a job before giving up. Bounds each
// per-source BFS so the whole pass stays cheap on small maps; a lot that finds no job
// within range simply contributes no traffic.
const MAX_RANGE = 30;

// Raw path load (the sum of residential stages whose commute crosses a tile) is scaled by
// this before being clamped into the 0..255 traffic byte. Tuned so ordinary corridors
// read low and only genuinely overloaded ones approach saturation.
const TRAFFIC_SCALE = 4;

// Neighbour offsets in a fixed order (W, E, N, S) so BFS discovery is reproducible.
const DX = [-1, 1, 0, 0];
const DY = [0, 0, -1, 1];

export class TrafficSystem implements SimPass {
  readonly name = "traffic";

  // BFS scratch reused across ticks, sized lazily to the world. `stamp` marks tiles
  // visited in the current search via a monotonically increasing generation counter, so
  // we never have to clear the visited/dist/prev arrays between sources.
  private gen = 0;
  private stamp = new Int32Array(0);
  private dist = new Int32Array(0);
  private prev = new Int32Array(0);
  private queue = new Int32Array(0);
  private load = new Uint32Array(0);

  update({ world }: SimContext): void {
    const { size, width, height } = world;
    if (this.stamp.length !== size) {
      this.stamp = new Int32Array(size);
      this.dist = new Int32Array(size);
      this.prev = new Int32Array(size);
      this.queue = new Int32Array(size);
      this.load = new Uint32Array(size);
    }
    const { stamp, dist, prev, queue, load } = this;
    load.fill(0);

    const isRoad = (i: number): boolean => (world.net[i]! & Net.Road) !== 0;

    // A developed employment lot: a commercial or industrial zone past stage 0.
    const isJob = (i: number): boolean => {
      const z = zoneCapacity(world.zone[i]!);
      return !!z && z.cat !== "R" && world.stage[i]! > 0;
    };

    // Route one commute flow per developed residential lot, in tile-index order.
    for (let ri = 0; ri < size; ri++) {
      const z = zoneCapacity(world.zone[ri]!);
      if (!z || z.cat !== "R") continue;
      const trips = world.stage[ri]!; // denser lots send proportionally more commuters
      if (trips === 0) continue;

      const rx = ri % width;
      const ry = (ri / width) | 0;

      // Seed a multi-source BFS from every road tile touching this lot — its access
      // points onto the network — each at distance 0.
      this.gen++;
      let head = 0;
      let tail = 0;
      for (let d = 0; d < 4; d++) {
        const nx = rx + DX[d]!;
        const ny = ry + DY[d]!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (!isRoad(ni) || stamp[ni] === this.gen) continue;
        stamp[ni] = this.gen;
        dist[ni] = 0;
        prev[ni] = -1;
        queue[tail++] = ni;
      }

      // Expand outward over road tiles to the nearest one adjacent to a job lot. BFS over
      // an unweighted graph dequeues in nondecreasing distance, with insertion (hence
      // index) order breaking ties, so the first qualifying tile is the deterministic
      // nearest commute destination.
      let dest = -1;
      while (head < tail) {
        const cur = queue[head++]!;
        const cx = cur % width;
        const cy = (cur / width) | 0;

        let reachesJob = false;
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d]!;
          const ny = cy + DY[d]!;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (isJob(ny * width + nx)) {
            reachesJob = true;
            break;
          }
        }
        if (reachesJob) {
          dest = cur;
          break;
        }

        if (dist[cur]! >= MAX_RANGE) continue; // do not expand past the search radius
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d]!;
          const ny = cy + DY[d]!;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (!isRoad(ni) || stamp[ni] === this.gen) continue;
          stamp[ni] = this.gen;
          dist[ni] = dist[cur]! + 1;
          prev[ni] = cur;
          queue[tail++] = ni;
        }
      }

      // Walk the predecessor chain from the destination back to an access point, loading
      // every road tile on the commute path with this lot's trips.
      for (let node = dest; node !== -1; node = prev[node]!) {
        load[node]! += trips;
      }
    }

    // Publish the accumulated load into the traffic field. Only road tiles ever carry
    // load, so every other tile resets to 0. Integer math keeps it reproducible.
    for (let i = 0; i < size; i++) {
      const v = load[i]! * TRAFFIC_SCALE;
      world.traffic[i] = v > 255 ? 255 : v;
    }
  }
}
