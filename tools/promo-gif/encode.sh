#!/usr/bin/env bash
# Composited frames -> publishable GIF. The platform limit is 10MB / 300 frames.
#
# Every other frame of the 24fps capture is taken to reach 12fps: the foil clip at 24fps would exceed
# 300 frames and double in size to 14MB.
# 128 colors plus bayer 4: indistinguishable from 255 by eye and about a third smaller. The palette is
# computed over whole frames - computed over changed pixels only, the stationary subtitles get no
# colors allocated. diff_mode=rectangle re-dithers only the changed region, which is what lets
# inter-frame differencing actually compress.
#
# Usage: bash tools/promo-gif/encode.sh [clip ...]   with no arguments it does all six
#        W / COLORS override the width and color count. The highlight reel goes through reel.py,
#        which needs a per-clip palette.
set -euo pipefail
cd "$(dirname "$0")/out"
mkdir -p gif
W=${W:-720}
COLORS=${COLORS:-128}

declare -A NAME=(
  [a_hero]=01_hero [b_foil]=02_foil [c_crush]=03_crush
  [d_heat]=04_heat [e_cold]=05_cold [f_spin]=06_spin
)

enc(){
  local clip=$1 out="gif/${NAME[$1]}.gif"
  ffmpeg -y -loglevel error -framerate 24 -i "comp/$clip/%04d.png" \
    -vf "select='not(mod(n\,2))',setpts=N/12/TB,scale=$W:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=$COLORS:stats_mode=full[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
    -r 12 "$out"
  local bytes n
  bytes=$(wc -c < "$out")
  n=$(ffprobe -v error -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "$out")
  printf '%-18s %s MB  %3s frames  %s s\n' "${NAME[$clip]}" \
    "$(awk -v b="$bytes" 'BEGIN{printf "%.2f", b/1e6}')" "$n" "$(awk -v n="$n" 'BEGIN{printf "%.1f", n/12}')"
  # Treat the platform's "10M" as decimal, the most conservative reading
  if (( bytes > 10000000 || n > 300 )); then echo "  ^ over the platform limit (10MB / 300 frames)" >&2; fi
}

clips=("$@")
[ ${#clips[@]} -gt 0 ] || clips=(a_hero b_foil c_crush d_heat e_cold f_spin)
for c in "${clips[@]}"; do enc "$c"; done
