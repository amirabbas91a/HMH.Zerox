# HMH.Zerox — Dedicated game server (self-host runbook)

Date: 2026-11-05. Status: **prepared, not yet deployed** — needs the user's
Railway access + cost go-ahead (see "Still needed" at the bottom).

## Why a separate server

The Vercel page is static only. Online lobbies need a game server, and the
upstream API (`api.openfront.io`) refuses our site (404 "Unknown site" +
CORS allows only `openfront.io`). The upstream account/shop API service is a
separate private codebase ("infra") — it is NOT in this repo, so we do not
rebuild it. Instead we run the repo's own game server in **dev mode**, which
is upstream's documented no-API mode (`npm run dev`): persistent-ID auth
instead of JWT, Turnstile / join_verify skipped, fail-open joins, no
subscription/payment checks.

## Architecture (minimal)

```
Player browser
  https://hmh-zerox.vercel.app  (Vercel static page, gameEnv=dev,
                                  API_DOMAIN=<game host>)
        │  GET https://<game host>/cluster.json   (one-server list)
        │  wss://<game host>/w0/...               (game sockets)
        ▼
  One Docker container (this repo's Dockerfile) on Railway
    nginx (:$PORT) + node master (:3000) + 2 workers
    GAME_ENV=dev, INSTANCE_LETTER=a, NUM_WORKERS=2
```

What works: Solo (unchanged), private lobbies (create + invite link + join),
public lobbies on this one server, playing with friends anonymously.
What does NOT work without the upstream API: Ranked matchmaking, accounts
(Discord/Google/Steam login), clans, store/cosmetics, leaderboards, replays.
The "Connection error!" modal disappears once `/cluster.json` answers.

## Fork patches already in this copy (validated by Vercel build 2026-11-05)

1. `src/client/ApiBase.ts` — a build-time `API_DOMAIN` now wins over
   `api.<audience>`. Unset = upstream behaviour, so the live Vercel site is
   unchanged until we set it.
2. `src/server/Master.ts` — `GET /cluster.json` returns the one-server list
   `{latest, servers:{a:{host, numWorkers, version, state:"open"}}}`,
   CORS `*`. `version`/`latest` MUST be a commit sha (7–40 hex chars);
   `ServerEnv.gitCommit()` supplies it from `GIT_COMMIT`.
3. `Dockerfile` (start.sh) — nginx listens on `$PORT` when set (Railway
   injects it), else 80.
4. `railway.json` — Dockerfile builder, healthcheck `/api/health`.

## Railway service variables (set at deploy time)

| Variable | Value |
|---|---|
| `GAME_ENV` | `dev` |
| `GAME_HOST` | the Railway public domain, e.g. `hmh-zerox-game.up.railway.app` (set after first deploy, then redeploy) |
| `DOMAIN` | same as `GAME_HOST` |
| `NUM_WORKERS` | `2` |
| `INSTANCE_LETTER` | `a` |
| `API_KEY` | a fresh random string (generate at deploy; used for the check-in call, never shown) |
| `TURNSTILE_SITE_KEY` | `1x00000000000000000000AA` (Cloudflare test key; required to be set, unused in dev) |
| `GIT_COMMIT` | `5b75bd3ad8f66325a727f7bcec47680a0cc07e63` (repo HEAD — must match the Vercel frontend's build commit) |

Railway build: Dockerfile from this directory (upload is large — the build
context includes `resources/maps`, ~700 MB, one-time). Healthcheck
`/api/health` (503 until workers are up, so give it up to 300 s).

Local smoke test 2026-11-05 ~16:31 (before any host is chosen): `npm ci`
(589 packages) + dev server booted locally and answered
`GET /cluster.json` → 200 `{"latest":"5b75bd3…","servers":{"a":{"host":
"localhost","numWorkers":2,"version":"5b75bd3…","state":"open"}}}` and
`GET /api/health` → 200 `{"status":"ok","instanceId":"DEV_ID"}`. So the
route, the commit-shaped version and the healthcheck are proven; the
remaining unproven step is the real client flow (Vercel page with
`API_DOMAIN` → create lobby → join from a second device), which needs the
deployed server.

## After the game server is up

1. Note its public domain → set `GAME_HOST`/`DOMAIN` to it, redeploy.
2. Vercel: add build env `GAME_ENV=dev` and `API_DOMAIN=<game host>` in
   `vercel.json` `build.env`, redeploy. (Keep `DOMAIN=openfront.io` out —
   the page's `jwtAudience` stays `openfront.io` unless changed; with
   `API_DOMAIN` set, the audience no longer decides the API base.)
3. Live test: open the site on two devices → CREATE LOBBY on one, join via
   the invite link on the other, start the game.

## Render (alternative host, scoped 2026-11-05)

Yes, it works — with two conditions:

- **Plan: Standard, $25/mo (2 GB / 1 CPU), region Frankfurt.** Free sleeps
  after 15 min of inactivity (unusable for a game server) and Starter
  ($7/mo, 512 MB) is too small: measured idle footprint of this server
  locally is **~610 MB RSS** (master + 2 workers under tsx, before any
  game runs), so 512 MB would OOM. Budget alternative: `NUM_WORKERS=1`
  on Starter ≈ 320 MB idle — untested, one worker runs all games.
  WebSockets are fully supported on Render; `$PORT` is injected and the
  Dockerfile already listens on it; healthcheck is `/api/health`.
- **The code must be on GitHub first.** Render builds from a connected
  repo (or a prebuilt image in a registry). The rename + server patches
  live only in this local copy — nothing has been pushed. Muse has no
  GitHub push access (`gh` is installed but not authenticated, no stored
  git credentials; the earlier GitHub App token returned 403). So the
  push needs the user's GitHub login or a token, then Render connects to
  `amirabbas91a/HMH.Zerox` and builds the Dockerfile.
- `render.yaml` (in this copy) is ready: Docker runtime, plan standard,
  Frankfurt, healthcheck `/api/health`, env as in the Railway table
  (minus `GAME_HOST`/`DOMAIN` — `ServerEnv.publicHost()` now falls back
  to Render's injected `RENDER_EXTERNAL_HOSTNAME`, so no manual host
  step). `API_KEY` is generated by Render.
- Free tier + UptimeRobot (user's plan, 2026-11-05 — same trick they use
  for 9Router): the pinging itself works (a GET every 5 min counts as
  traffic, so the service does not idle-spin-down; ping `/api/health`),
  BUT the free tier still caps at 512 MB RAM and 0.1 CPU, and this server
  idles at ~610 MB RSS measured locally (9Router idles ~85 MB — that is
  why the trick works for 9Router and not here). So free is a smoke test
  only: it can boot and serve the list, but real games will OOM/restart
  and lag on 0.1 CPU; a ping cannot fix RAM. `render.yaml` is set to
  `NUM_WORKERS=1` for the free test (≈460 MB idle, still tight); Standard
  ($25, 2 GB) uses 2 workers. Real play with friends needs Standard.
- GitHub push prerequisite: verified 2026-11-05 the Muse GitHub
  connector CAN read the fork (README fetched) and has push tools
  (`push_files`, `create_branch`); push to a NEW branch
  (`hmh-zerox-render`, from main@5b75bd3) with only the changed/new
  files (~25 UTF-8 files, no secrets) per
  `references/snapshot-push.md`. Needs the user's explicit confirmation
  before pushing (public fork).
- After Render is up: Vercel build env `GAME_ENV=dev` +
  `API_DOMAIN=<service>.onrender.com`, redeploy, live-test a lobby.

## Costs (estimates, not quotes)

- Railway: Hobby $5/mo + usage. One always-on Node container (~1 vCPU,
  ~1 GB) ≈ **$10–25/mo** on top of what 9Router already uses.
- Cheaper alternative: Hetzner VPS (~€4–5/mo, 2 vCPU / 4 GB). The repo
  even ships `setup.sh` for Hetzner + Docker. Needs a separate purchase
  and server setup; say the word and this plan swaps host.

## Still needed from the user

1. **Railway access** — a Railway token (dashboard → account → Tokens) so
   Muse can deploy, OR the user creates the Railway project/service
   themselves from this folder and hands over the public domain.
2. **Cost go-ahead** — Railway usage is ongoing, roughly $10–25/mo.
3. Nothing else: no Cloudflare/Turnstile account (dev skips it), no domain
   purchase (Railway's free subdomain is enough).
