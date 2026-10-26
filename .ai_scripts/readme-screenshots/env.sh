#!/usr/bin/env bash
# Source before capture.ts / live.ts:  source .ai_scripts/readme-screenshots/env.sh
#
# Headless Chromium on this host needs (1) GUI libs unpacked without root and
# (2) a font with the media-control glyphs (⏮ ⏭) the trajectory players use —
# without it they render as empty boxes. Both live outside the repo.
libs="${ORCA_SHOT_LIBS:-$HOME/.cache/orbital-chrome-libs}"
fonts="${ORCA_SHOT_FONTS:-/tmp/orca-shot-fonts}"

if [[ ! -f "$fonts/NotoSansSymbols2-Regular.ttf" ]]; then
  mkdir -p "$fonts/deb"
  (cd "$fonts/deb" && apt-get download fonts-noto-core >/dev/null && dpkg-deb -x fonts-noto-core_*.deb x) \
    || { echo "env.sh: could not fetch fonts-noto-core" >&2; return 1; }
  cp "$fonts/deb/x/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf" "$fonts/"
fi
cat > "$fonts/fonts.conf" <<CONF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>$fonts</dir>
  <cachedir>$fonts/cache</cachedir>
</fontconfig>
CONF

export LD_LIBRARY_PATH="$libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export FONTCONFIG_FILE="$fonts/fonts.conf"
