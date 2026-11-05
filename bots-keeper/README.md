# HMH.Zerox bots keeper

Keeps **3 public lobbies** alive around the clock so the lobby list is never
empty. Each lobby: **World map, Free For All, 15 AI bots**, listed publicly
with the title **«HMH.Zerox • Bots»**. A listed lobby auto-starts on its own
after **10 minutes** (the server's featured-lobby default), so humans have
time to join before the bots start playing.

The keeper is a tiny zero-dependency Node script (`keeper.mjs`). It does not
run any game code — it only calls the game server's built-in admin-bot API:

- Every 60 s it checks the lobbies it created with
  `GET /{workerPath}/api/game/:id` (a lobby counts as alive only while it is
  still listed and still has our bots count + label).
- If fewer than 3 are alive, it creates replacements with
  `POST /api/adminbot/create_game` (header `x-admin-bot-key`).
- It tracks its lobbies in `keeper-state.json` next to the script.

## Prerequisite: the key (do this first)

The game server and the keeper must share one secret, `ADMIN_BOT_API_KEY`.
It is not set anywhere yet.

1. Generate a random key, e.g. `openssl rand -hex 32`.
2. On the **game server** service in Render (`hmh-zerox`):
   Dashboard → Environment → add `ADMIN_BOT_API_KEY` = the key → Save
   (this redeploys the game server; until the key is set, the admin-bot API
   answers 404 and the keeper cannot create anything).
3. Use the **same** key for the keeper service below. Never put the key in
   git or in any file — dashboard only.

## Deploy on Render (dashboard)

1. Render → **New +** → **Background Worker** (not a Web Service — the
   keeper opens no port).
2. Connect the repo `amirabbas91a/HMH.Zerox`, branch **`hmh-zerox-render`**.
3. Settings:
   - Name: `hmh-zerox-bots-keeper`
   - Root Directory: `bots-keeper`
   - Build Command: `npm install`
   - Start Command: `node keeper.mjs`
   - Instance Type: **Free**
4. Environment variables:
   - `GAME_SERVER_URL` = `https://hmh-zerox.onrender.com`
   - `ADMIN_BOT_API_KEY` = the key from above
   - (optional) `TARGET_LOBBIES` = `3`, `BOTS_PER_GAME` = `15`,
     `POLL_INTERVAL_MS` = `60000`
5. Create the service. It starts creating lobbies within a minute.

(Alternative: deploy from `bots-keeper/render.yaml` as a Blueprint — same
values; `ADMIN_BOT_API_KEY` is `sync: false`, so Render still asks for it in
the dashboard.)

## Checking it works

- Keeper logs (Render → service → Logs): every minute a line like
  `check done: 3/3 keeper lobbies alive`, plus `created lobby <id> (w0)` when
  it tops up. `WARN ADMIN_BOT_API_KEY is not set` means step 2–3 above are
  still missing.
- In the game, open the lobby browser: three rows titled «HMH.Zerox • Bots»
  should be listed. Joining one plays against the bots plus whoever joins.

## Notes / limits

- **Auto-start is 10 minutes, fixed by the server.** The admin-bot create
  call cannot set a custom delay — the route lists the lobby with the server
  default (10 min featured, 5 min plain). No code change needed; 10 minutes
  is the intended window for humans to join.
- **Free-tier reality:** the games run on the game server, not here. Three
  concurrent bot games on the free game server (512 MB) is the realistic cap;
  more needs the Standard plan.
- **State file is ephemeral.** `keeper-state.json` survives keeper restarts
  but not a redeploy. After a redeploy the keeper starts from zero and
  creates 3 fresh lobbies while any pre-redeploy ones are still alive — those
  auto-start within 10 minutes and end on their own, so the overshoot heals
  itself.
- **One instance only.** Running two keepers would each create up to 3
  lobbies (up to 6 total).
- **If the game server sleeps** (free tier), probes fail and the keeper logs
  the error and retries next minute — it never crash-loops. UptimeRobot
  pinging `https://hmh-zerox.onrender.com/api/health` keeps the game server
  awake, as already set up.
- To stop the bots, suspend/delete the keeper service in Render — the
  lobbies it already created will auto-start and finish on their own.
