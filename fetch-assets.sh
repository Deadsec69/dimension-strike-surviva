#!/usr/bin/env bash
# 拉取运行时依赖。这两样都是二进制产物（合计约 18MB），不入 git。
#
#   vendor/wasm/   MediaPipe 的 WASM 运行时（来自 jsDelivr，版本已钉死）
#   models/        手势识别模型（来自 Google 的 MediaPipe 模型库）
#
# 海外/香港机器可直连。国内机器若拉不到 storage.googleapis.com，
# 请在能连通的机器上跑本脚本，再把 models/ 目录 scp 过去。
set -euo pipefail
cd "$(dirname "$0")"

MP_VER="0.10.18"
WASM_BASE="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"

get() {   # get <url> <目标路径> <期望的文件头魔数，可空>
  local url="$1" out="$2" magic="${3:-}"
  if [ -f "$out" ]; then
    echo "  已存在  $out ($(du -h "$out" | cut -f1))"
    return 0
  fi
  mkdir -p "$(dirname "$out")"
  echo "  下载中  $out"
  curl -fL --progress-bar -o "$out" "$url"
  if [ -n "$magic" ] && [ "$(head -c ${#magic} "$out")" != "$magic" ]; then
    echo "  文件头不符（期望 $magic），可能下到了错误页面，已删除" >&2
    rm -f "$out"
    return 1
  fi
}

echo "MediaPipe WASM 运行时 v${MP_VER}"
get "${WASM_BASE}/vision_wasm_internal.js"   vendor/wasm/vision_wasm_internal.js
get "${WASM_BASE}/vision_wasm_internal.wasm" vendor/wasm/vision_wasm_internal.wasm $'\x00asm'

echo "手势识别模型"
get "$MODEL_URL" models/gesture_recognizer.task PK   # .task 是 zip 包

echo
echo "完成。运行：python serve.py 8123"
