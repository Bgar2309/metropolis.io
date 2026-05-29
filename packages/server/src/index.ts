// Phase-0 server scaffold. The online meta layer (auth, cloud saves, leaderboards,
// social, ranked verification) is built out in Phase 4. For now this is a health-check
// endpoint plus a placeholder for the ranked-verification handler so the architecture
// (re-running an action log through sim-core) is documented and importable.

import Fastify from "fastify";
import { Engine, generateTerrain, hashWorld } from "@metro/sim-core";
import type { ActionLog } from "@metro/protocol";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true }));

// Deterministic re-simulation: rebuild a fresh engine from the log's seed/size, replay
// every command at its recorded tick, and return the final world hash. Phase 4 will
// compare this against the client's claimed `finalHash` to accept/reject ranked scores.
export function verifyActionLog(log: ActionLog): { hash: number; valid: boolean } {
  const engine = new Engine({ width: log.width, height: log.height, seed: log.seed });
  generateTerrain(engine.world, log.seed);
  let cursor = 0;
  const maxTick = log.commands.length ? log.commands[log.commands.length - 1]!.tick : 0;
  for (let t = 1; t <= maxTick; t++) {
    while (cursor < log.commands.length && log.commands[cursor]!.tick === t) {
      engine.enqueue(log.commands[cursor]!.cmd);
      cursor++;
    }
    engine.tick();
  }
  const hash = hashWorld(engine.world);
  return { hash, valid: hash === log.finalHash };
}

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`metro server on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
