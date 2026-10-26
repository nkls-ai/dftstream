# site-capture

Produces the product screenshots and the animated click-through that ship in
`site/public/shots/`. Every image is a headless screenshot of the real UI,
driven against a Convex backend seeded from this repo's own `.examples/` ORCA
outputs. Nothing is mocked or drawn by hand.

## 1. An isolated backend

Do **not** capture against a shared dev backend — load-test fixtures with
hundreds of runs make `experiments:listWithSummary` exceed Convex's
system-operation budget, and the UI then renders skeletons forever.

```bash
BIN=~/.cache/convex/binaries/<version>/convex-local-backend
mkdir -p /tmp/os-capture-backend && cd /tmp/os-capture-backend
env -u TZ "$BIN" --port 3310 --site-proxy-port 3311 \
  --instance-name anonymous-db --instance-secret <secret from db/.convex/local/default/config.json> \
  --local-storage /tmp/os-capture-backend/storage \
  /tmp/os-capture-backend/convex_local_backend.sqlite3 &
```

Deploy the functions into it from a copy of `db/` (so nothing in the repo's
own `.convex/` state is touched):

```bash
rsync -a --exclude node_modules --exclude .convex db/ /tmp/os-db-capture/
ln -s "$PWD/db/node_modules" /tmp/os-db-capture/node_modules
cd /tmp/os-db-capture
cat > .env.local <<EOF
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3310
CONVEX_SELF_HOSTED_ADMIN_KEY=<adminKey from db/.convex/local/default/config.json>
EOF
bunx convex env set CLERK_JWT_ISSUER_DOMAIN ""   # auth.config names it; deploy aborts if unset
bunx convex env set DFTSTREAM_AUTH_REQUIRED 0
bunx convex deploy -y
```

## 2. Seed it

`seed.sh` stages `.examples/` into the `<root>/<experiment>/<run>/` layout the
importer wants, then imports. Runs in about a minute against an idle backend.

```bash
.ai_scripts/site-capture/seed.sh
```

## 3. Serve the UI

```bash
cd ui && BUN_PORT=3057 BUN_PUBLIC_CONVEX_URL=http://127.0.0.1:3310 bun src/index.ts
```

## 4. Headless Chromium

This host has no GUI libraries and no root. Unprivileged fix — download the
libs into a directory and point `LD_LIBRARY_PATH` at it:

```bash
mkdir -p /tmp/chr/debs /tmp/chr/libs && cd /tmp/chr/debs
apt-get download libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libasound2 \
  libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libgbm1 libxkbcommon0 libdrm2 \
  libwayland-server0 libxcb-randr0 libxi6 libnspr4 libnss3 libcups2
for d in *.deb; do dpkg-deb -x "$d" /tmp/chr/libs; done
```

The apt index is stale, so some pinned versions 404. Scrape the pool listing
for the current filename instead, e.g.
`curl -s http://archive.ubuntu.com/ubuntu/pool/main/m/mesa/ | grep -oE 'libgbm1_[^"]+amd64\.deb'`.

## 5. Capture

```bash
cd /tmp/capture-project && bun add playwright-core gifenc sharp
OS_UI_URL=http://127.0.0.1:3057 \
OS_OUT_DIR="$PWD/site/public/shots" \
LD_LIBRARY_PATH=/tmp/chr/libs/usr/lib/x86_64-linux-gnu:/tmp/chr/libs/lib/x86_64-linux-gnu \
bun .ai_scripts/site-capture/capture.ts
```

Stills are captured at 1440×900 @2x and shipped palette-quantized at 1440 wide
(≈40–85 KB each). The tour is a **real GIF**, encoded frame by frame with
`gifenc` — this host has no `ffmpeg`, `gifski` or ImageMagick. `tour-poster.png`
is its first frame, served instead of the GIF under `prefers-reduced-motion`.
