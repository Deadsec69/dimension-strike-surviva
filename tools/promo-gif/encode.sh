#!/usr/bin/env bash
# 合成帧 → 公众号 GIF。公众号上限 10MB / 300 帧。
#
# 24fps 采样隔帧取到 12fps：二向箔那段 24fps 会超 300 帧，体积也翻倍到 14MB。
# 128 色 + bayer 4：和 255 色肉眼无差，省约三成。调色板按全帧统计——只统计变化像素的话，
# 静止的字幕颜色分不到位置。diff_mode=rectangle 只重抖变化的那块，帧间差分才压得动。
#
# 用法：bash tools/promo-gif/encode.sh [clip ...]    不给就做六段
#       宽度与色数可用 W / COLORS 覆盖。精华合集走 reel.py，它要按段分调色板
set -euo pipefail
cd "$(dirname "$0")/out"
mkdir -p gif
W=${W:-720}
COLORS=${COLORS:-128}

declare -A NAME=(
  [a_hero]=01_主视觉 [b_foil]=02_二向箔 [c_crush]=03_引力挤压
  [d_heat]=04_升温 [e_cold]=05_冰封 [f_spin]=06_拨动自转
)

enc(){
  local clip=$1 out="gif/${NAME[$1]}.gif"
  ffmpeg -y -loglevel error -framerate 24 -i "comp/$clip/%04d.png" \
    -vf "select='not(mod(n\,2))',setpts=N/12/TB,scale=$W:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=$COLORS:stats_mode=full[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
    -r 12 "$out"
  local bytes n
  bytes=$(wc -c < "$out")
  n=$(ffprobe -v error -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "$out")
  printf '%-18s %s MB  %3s 帧  %s 秒\n' "${NAME[$clip]}" \
    "$(awk -v b="$bytes" 'BEGIN{printf "%.2f", b/1e6}')" "$n" "$(awk -v n="$n" 'BEGIN{printf "%.1f", n/12}')"
  # 公众号的「10M」按最保守的十进制算
  if (( bytes > 10000000 || n > 300 )); then echo "  ↑ 超出公众号上限（10MB / 300 帧）" >&2; fi
}

clips=("$@")
[ ${#clips[@]} -gt 0 ] || clips=(a_hero b_foil c_crush d_heat e_cold f_spin)
for c in "${clips[@]}"; do enc "$c"; done
