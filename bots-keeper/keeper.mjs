// HMH.Zerox bots keeper — keeps N public bot lobbies alive around the clock.
//
// How it works:
//   Every POLL_INTERVAL_MS it checks the lobbies it created (tracked in a small
//   state file) with GET /{workerPath}/api/game/:id on the game server. If fewer
//   than TARGET_LOBBIES are still alive and listed, it creates replacements with
//   POST /api/adminbot/create_game.
//
// Why it does NOT read the public lobby list: the browser's lobby feed is a
// binary Zbin websocket (PublicLobbySocket in src/client/LobbySocket.ts) with
// no HTTP equivalent. Checking our own lobbies directly is simpler and exact.
//
// Why create_game and not create_pool: a pool lists only its FIRST member — the
// other members are unlisted siblings. Three visible public rows need three
// separate create_game calls.
//
// Auto-start delay is NOT settable here: the admin-bot route calls
// setListed(true) with no options (src/server/AdminBotRoutes.ts applyListing),
// so the server default applies — 10 minutes for a featured lobby
// (FEATURED_LOBBY_AUTO_START_MS, packages/shared/src/WireSchemas.ts:187),
// 5 minutes otherwise. Featured also shows our label as the row title in the
// browser (src/client/components/LobbyCard.ts:199-200), which is how humans
// recognise the bot lobbies.
//
// Zero dependencies, plain Node >= 22 (global fetch). Reads its secrets only
// from the environment — never logs the key, never writes it to disk.

import { readFile, writeFile } from "node:fs/promises";

// ---------------------------------------------------------------- config ---

const GAME_SERVER_URL = (process.env.GAME_SERVER_URL ?? "https://hmh-zerox.onrender.com").replace(/\/+$/, "");
const TARGET_LOBBIES = Number(process.env.TARGET_LOBBIES ?? 3);
const BOTS_PER_GAME = Number(process.env.BOTS_PER_GAME ?? 15);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 15_000);
const STATE_FILE = process.env.STATE_FILE ?? new URL("./keeper-state.json", import.meta.url);

// One row in the public list. The label is what players see as the lobby
// title, and the accent colours the row (blue matches the HMH.Zerox logo).
const LOBBY_LABEL = "HMH.Zerox • Bots";
const LOBBY_ACCENT = "blue";

// The create payload is FLAT: AdminBotRoutes.parseCreateGameRequest runs
// GameConfigSchema.partial() over the whole body (src/server/AdminBotRoutes.ts:77),
// so game config fields sit at the top level next to listed/featured/label —
// they are NOT nested under a `config` key.
// gameType is omitted on purpose: it defaults to Private
// (src/server/GameManager.ts:98) and the admin-bot route rejects anything but
// Private-or-omitted (AdminBotRoutes.ts:193-196). nations/maxPlayers are left
// to the server defaults.
function createPayload() {
  return {
    gameMap: "World",
    gameMode: "Free For All",
    difficulty: "Medium",
    bots: BOTS_PER_GAME,
    listed: true,
    featured: true,
    label: LOBBY_LABEL,
    accent: LOBBY_ACCENT,
  };
}

// ------------------------------------------------------------------ state ---

// [{ id, workerPath, createdAt }] — workerPath comes back in the create
// response (lobbyResponse, AdminBotRoutes.ts) and pins the liveness check to
// the worker that owns the lobby: GET /{workerPath}/api/game/:id.
// The file survives keeper restarts but NOT a Render redeploy (ephemeral disk):
// after a redeploy the keeper starts from zero and creates fresh lobbies while
// any pre-redeploy ones are still alive. Those auto-start within 10 minutes
// and end on their own, so the overshoot is transient and self-healing.
async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.lobbies)) return parsed.lobbies;
  } catch {
    // Missing or corrupt state: start fresh (see note above).
  }
  return [];
}

async function saveState(lobbies) {
  try {
    await writeFile(STATE_FILE, JSON.stringify({ lobbies }, null, 2) + "\n", "utf8");
  } catch (err) {
    log(`WARN could not save state file: ${err.message}`);
  }
}

// ------------------------------------------------------------------ http ---

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body };
}

// A known lobby is alive only if the owning worker still has it AND it is
// still listed AND it still looks like ours (bots + label fingerprint —
// guards against a stale/corrupt state file or an id being reused).
async function isAlive(lobby) {
  const url = `${GAME_SERVER_URL}/${lobby.workerPath}/api/game/${lobby.id}`;
  try {
    const { status, ok, body } = await fetchJson(url);
    if (!ok) {
      if (status === 404) return { alive: false, reason: "gone (404)" };
      return { alive: false, reason: `lobby check HTTP ${status}` };
    }
    if (body?.listed !== true) return { alive: false, reason: "no longer listed (started or delisted)" };
    if (body?.gameConfig?.bots !== BOTS_PER_GAME) return { alive: false, reason: "config mismatch (not ours)" };
    if (body?.label !== LOBBY_LABEL) return { alive: false, reason: "label mismatch (not ours)" };
    const players = Array.isArray(body?.clients) ? body.clients.length : "?";
    const autoStart = body?.autoStartAt ? new Date(body.autoStartAt).toISOString() : "n/a";
    return { alive: true, reason: `listed, ${players} player(s), auto-starts ${autoStart}` };
  } catch (err) {
    // Server asleep / network blip / timeout: do NOT declare it dead on a
    // failed probe — keep it and re-check next cycle.
    return { alive: true, reason: `check failed (${err.message}) — kept, will re-check`, uncertain: true };
  }
}

async function createLobby(apiKey) {
  const { status, ok, body } = await fetchJson(`${GAME_SERVER_URL}/api/adminbot/create_game`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-bot-key": apiKey,
    },
    body: JSON.stringify(createPayload()),
  });
  if (!ok) {
    throw new Error(`create_game HTTP ${status}: ${JSON.stringify(body)}`);
  }
  const id = body?.gameID;
  const workerPath = body?.workerPath ?? (typeof body?.workerIndex === "number" ? `w${body.workerIndex}` : undefined);
  if (!id || !workerPath) {
    throw new Error(`create_game response missing gameID/workerPath: ${JSON.stringify(body)}`);
  }
  return { id, workerPath, createdAt: Date.now() };
}

// ------------------------------------------------------------------ loop ---

let inCycle = false;

async function cycle() {
  if (inCycle) {
    log("cycle skipped: previous cycle still running");
    return;
  }
  inCycle = true;
  try {
    const apiKey = process.env.ADMIN_BOT_API_KEY;
    let known = await loadState();

    // 1. Liveness check for every lobby we track.
    const alive = [];
    for (const lobby of known) {
      const check = await isAlive(lobby);
      log(`lobby ${lobby.id} (${lobby.workerPath}): ${check.alive ? "alive" : "dead"} — ${check.reason}`);
      if (check.alive) alive.push(lobby);
    }
    if (alive.length !== known.length) {
      await saveState(alive);
      known = alive;
    }

    // 2. Top up to the target.
    const deficit = TARGET_LOBBIES - alive.length;
    if (deficit <= 0) {
      log(`check done: ${alive.length}/${TARGET_LOBBIES} keeper lobbies alive, nothing to do`);
      return;
    }
    if (!apiKey) {
      log(`WARN ADMIN_BOT_API_KEY is not set — cannot create ${deficit} missing lobby(ies). Set the same key on the game server and on this keeper, then restart.`);
      return;
    }
    for (let i = 0; i < deficit; i++) {
      try {
        const lobby = await createLobby(apiKey);
        alive.push(lobby);
        await saveState(alive);
        log(`created lobby ${lobby.id} (${lobby.workerPath}) — ${alive.length}/${TARGET_LOBBIES} alive`);
      } catch (err) {
        // Never crash the loop: log and retry next cycle.
        log(`ERROR failed to create a lobby: ${err.message}`);
        break;
      }
    }
    log(`check done: ${alive.length}/${TARGET_LOBBIES} keeper lobbies alive`);
  } catch (err) {
    log(`ERROR cycle failed: ${err?.message ?? err}`);
  } finally {
    inCycle = false;
  }
}

function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

log(`bots keeper starting: server=${GAME_SERVER_URL} target=${TARGET_LOBBIES} lobbies, ${BOTS_PER_GAME} bots each, poll every ${POLL_INTERVAL_MS / 1000}s, label="${LOBBY_LABEL}"`);
if (!process.env.ADMIN_BOT_API_KEY) {
  log("WARN ADMIN_BOT_API_KEY is not set — lobbies cannot be created until it is set (same value as on the game server)");
}
await cycle();
setInterval(() => void cycle(), POLL_INTERVAL_MS);
