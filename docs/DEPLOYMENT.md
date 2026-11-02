# Deployment

## Local

```bash
npm ci
npm run build
npm start
```

The server serves both the API and the built client from `dist/client` on `HOST:PORT`. By default it binds only to `127.0.0.1`. Set `HOST` explicitly for LAN/public exposure and configure at least one access token; non-loopback binding without a token fails closed at startup.
Runtime state lives under `data/`:

- `data/aquapilot.db` — decisions, alarms and replay snapshots (SQLite, Node 22+)
- `data/topology.json` — the active flowsheet document (units, links, positions, waypoints)
- `data/topology-history.json` — the newest 20 applied versions, used for rollback
- `data/llm-config.json`, `data/agent-config.json` — model and Agent configuration

Everything under `data/` must be on a persistent volume: the SQLite file holds the
replay history, and the two topology files hold the operator's authored flowsheet.

## Docker

```bash
docker build -t aquapilot:local .
docker run --rm -p 5173:5173 \
  -e AQUAPILOT_TOKEN="$AQUAPILOT_TOKEN" \
  -v aquapilot-data:/app/data aquapilot:local
```

Notes that matter:

- The image runs as the non-root `node` user. `/app/data` is created and chowned in
  the Dockerfile; if you bind-mount a host directory instead of a named volume,
  make sure that directory is writable by UID 1000.
- Persistence is optional: with `AQUAPILOT_PERSIST=0` (or on Node 20, where
  `node:sqlite` does not exist) the server runs with in-memory history only and
  says so in the UI replay panel and `/api/health?deep=1`.
- The healthcheck hits `/api/health`, which is public even when
  `AQUAPILOT_TOKEN` is set.
- For local browser smoke testing, `npm run e2e` uses Playwright's managed browser
  when available. Set `AQUAPILOT_BROWSER_PATH` to an existing Edge or Chromium
  executable when the managed browser is not installed; the same behavioral
  assertions run unchanged.

Compose example:

```yaml
services:
  aquapilot:
    image: aquapilot:local
    ports: ['5173:5173']
    environment:
      HOST: '0.0.0.0'
      PORT: '5173'
      LOG_LEVEL: info
      # Non-loopback HOST requires a token.
      AQUAPILOT_TOKEN: change-me
      # AQUAPILOT_LLM_BASE_URL: https://api.example.com/v1
      # AQUAPILOT_LLM_MODEL: model-name
    volumes:
      - aquapilot-data:/app/data
    restart: unless-stopped
volumes:
  aquapilot-data:
```

## Reverse proxy

Put TLS in front of the app. When any role token is configured, the browser needs
to reach `/api/auth-required` and `/api/health` (including `?deep=1`) without a
token. Other `/api/*` endpoints and the WebSocket handshake require a valid token;
static assets remain public. Browser WebSocket clients use the base64url token
subprotocol described in [API.md](API.md#websocket-protocol).

Nginx sketch:

```nginx
server {
  listen 443 ssl;
  server_name aquapilot.example.com;

  location /ws {
    proxy_pass http://127.0.0.1:5173;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
  }

  location / {
    proxy_pass http://127.0.0.1:5173;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

The WebSocket origin allowlist accepts any host when a token is configured
(the token is the security boundary); with no token it only accepts localhost.
If you deploy publicly without a token, that is the wrong configuration.

## Observability

| Need                   | Endpoint                                                                     |
| ---------------------- | ---------------------------------------------------------------------------- |
| Liveness               | `GET /api/health`                                                            |
| Readiness              | `GET /api/health?deep=1` (503 when the tick loop is paused because it threw) |
| Prometheus             | `GET /api/metrics`                                                           |
| Human-readable metrics | `GET /api/metrics?format=json`                                               |
| Logs                   | stdout, one JSON object per line, filter with `LOG_LEVEL`                    |

Suggested alerts are in [SLO.md](SLO.md).

## Backup and restore

```bash
npm run backup -- create --db data/aquapilot.db --out backups/aquapilot.db
npm run backup -- restore --from backups/aquapilot.db --db data/aquapilot.db        # preflight
npm run backup -- restore --from backups/aquapilot.db --db data/aquapilot.db --yes  # apply
```

`create` uses `VACUUM INTO`, so the backup is consistent even while the server is
writing. `restore` verifies that the file opens and contains data before replacing
anything, and is a two-step operation by design.

## Mirrors and code hosting

The project is published as **five repositories on three services**:

| Repository                                | Service | CI definition                                  |
| ----------------------------------------- | ------- | ---------------------------------------------- |
| `Morningstar202604/aquapilot` (canonical) | GitHub  | `.github/workflows/ci.yml` + `release.yml`     |
| `badhope/aquapilot`                       | GitHub  | same workflow (the repo carries the same tree) |
| `X33834/aquapilot`                        | GitHub  | same workflow                                  |
| `badhope/aquapilot`                       | Gitee   | `.workflow/aquapilot-ci.yml`                   |
| `badhope/aquapilot`                       | GitCode | `.gitcode/pipeline.yml`                        |

AtomGit is the same service as GitCode (same hosts, same API, same repository id),
so it is not a separate target and there is no separate AtomGit remote.

Mirroring does not change the app. Pushing the same commit to several hosts is
enough; each pipeline is self-contained and uses only `npm ci` plus the repo's own
scripts. The default branch is `main` everywhere; `master` no longer exists on any
remote.

## Publishing a Docker image

GitHub Container Registry example:

```bash
echo "$GH_TOKEN" | docker login ghcr.io -u <user> --password-stdin
docker build -t ghcr.io/<user>/aquapilot:0.5.0 -t ghcr.io/<user>/aquapilot:latest .
docker push ghcr.io/<user>/aquapilot:0.5.0
docker push ghcr.io/<user>/aquapilot:latest
```

Docker Hub is identical with `docker.io/<user>/aquapilot`. Never bake tokens or
`.env` files into the image; `.dockerignore` already excludes them.

## Demo assets

```bash
npx tsx scripts/media.ts     # 10 screenshots + docs/media/demo.webm
ffmpeg -y -i docs/media/demo.webm -vf "fps=12,scale=1280:-2" \
  -c:v libx264 -pix_fmt yuv420p -crf 26 -movflags +faststart docs/media/demo.mp4
ffmpeg -y -i docs/media/demo.mp4 -vf "fps=8,scale=960:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" \
  docs/media/demo.gif
```

`media.ts` starts the production build on port 5190 with persistence disabled, so
the screenshots never depend on a developer's local database.
