# Deployment

## Local

```bash
npm ci
npm run build
npm start
```

The server serves both the API and the built client from `dist/client` on `PORT`
(default 5173), and persists history to `data/aquapilot.db` (SQLite, Node 22+).

## Docker

```bash
docker build -t aquapilot:local .
docker run --rm -p 5173:5173 -v aquapilot-data:/app/data aquapilot:local
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

Compose example:

```yaml
services:
  aquapilot:
    image: aquapilot:local
    ports: ['5173:5173']
    environment:
      PORT: '5173'
      LOG_LEVEL: info
      # AQUAPILOT_TOKEN: change-me
      # AQUAPILOT_LLM_BASE_URL: https://api.example.com/v1
      # AQUAPILOT_LLM_MODEL: model-name
    volumes:
      - aquapilot-data:/app/data
    restart: unless-stopped
volumes:
  aquapilot-data:
```

## Reverse proxy

Put TLS in front of the app. When `AQUAPILOT_TOKEN` is enabled, the browser needs
to reach `/api/auth-required` and `/api/health` without a token; everything else
(`/api/*` and the WebSocket handshake) requires it.

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

| Need | Endpoint |
|---|---|
| Liveness | `GET /api/health` |
| Readiness | `GET /api/health?deep=1` (503 when the tick loop is paused because it threw) |
| Prometheus | `GET /api/metrics` |
| Human-readable metrics | `GET /api/metrics?format=json` |
| Logs | stdout, one JSON object per line, filter with `LOG_LEVEL` |

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

The repository ships CI definitions for three platforms out of the box:

| Platform | File | Notes |
|---|---|---|
| GitHub Actions | `.github/workflows/ci.yml` | Node 20 + 22 matrix, coverage, audit, build, smoke, browser smoke, backup round-trip |
| Gitee Go | `.workflow/aquapilot-ci.yml` | typecheck, tests with count floor, build, smoke, secret scan |
| GitCode | `.gitcode/pipeline.yml` | typecheck, test, build, smoke |

Mirroring does not change the app. Pushing the same commit to several hosts is
enough; each pipeline is self-contained and uses only `npm ci` plus the repo's own
scripts.

## Publishing a Docker image

GitHub Container Registry example:

```bash
echo "$GH_TOKEN" | docker login ghcr.io -u <user> --password-stdin
docker build -t ghcr.io/<user>/aquapilot:0.3.0 -t ghcr.io/<user>/aquapilot:latest .
docker push ghcr.io/<user>/aquapilot:0.3.0
docker push ghcr.io/<user>/aquapilot:latest
```

Docker Hub is identical with `docker.io/<user>/aquapilot`. Never bake tokens or
`.env` files into the image; `.dockerignore` already excludes them.

## Demo assets

```bash
npx tsx scripts/media.ts     # 9 screenshots + docs/media/demo.webm
ffmpeg -y -i docs/media/demo.webm -vf "fps=12,scale=1280:-2" \
  -c:v libx264 -pix_fmt yuv420p -crf 26 -movflags +faststart docs/media/demo.mp4
ffmpeg -y -i docs/media/demo.mp4 -vf "fps=8,scale=960:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" \
  docs/media/demo.gif
```

`media.ts` starts the production build on port 5190 with persistence disabled, so
the screenshots never depend on a developer's local database.
