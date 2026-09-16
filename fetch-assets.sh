#!/usr/bin/env bash
# 拉取运行时依赖（合计约 20MB），这些都是二进制产物，不入 git。
#
#   textures/      地球贴图（Solar System Scope，CC BY 4.0）
#   vendor/wasm/   MediaPipe WASM 运行时（jsDelivr，版本已钉死）
#   models/        手势识别模型（Google MediaPipe 模型库）
#
# 海外/香港机器可直连。国内机器若拉不到 storage.googleapis.com，
# 请在能连通的机器上跑本脚本，再把 models/ 目录 scp 过去。
set -euo pipefail
cd "$(dirname "$0")"

MP_VER="0.10.18"
WASM_BASE="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"
TEX_BASE="https://www.solarsystemscope.com/textures/download"

# 文件头必须按十六进制比对：部分文件头部含 null 字节，
# 而 bash 的命令替换会静默吞掉 null，直接比原始字节永远不会相等。
head_hex() { head -c "$1" "$2" | od -An -tx1 | tr -d ' \n'; }

get() {   # get <url> <目标路径> <期望文件头的十六进制> <最小字节数>
  local url="$1" out="$2" magic="${3:-}" minsize="${4:-0}"
  if [ -f "$out" ]; then
    echo "  已存在  $out ($(du -h "$out" | cut -f1))"
    return 0
  fi
  mkdir -p "$(dirname "$out")"
  echo "  下载中  $out"
  curl -fL --progress-bar -o "$out" "$url"

  local size
  size=$(wc -c < "$out" | tr -d ' ')
  if [ "$size" -lt "$minsize" ]; then
    echo "  体积异常（${size}B，应不少于 ${minsize}B），疑似下到错误页面，已删除" >&2
    rm -f "$out"; return 1
  fi
  if [ -n "$magic" ]; then
    local got
    got=$(head_hex $(( ${#magic} / 2 )) "$out")
    if [ "$got" != "$magic" ]; then
      echo "  文件头不符（读到 $got，期望 $magic），已删除" >&2
      rm -f "$out"; return 1
    fi
  fi
}

echo "地球贴图（Solar System Scope · CC BY 4.0）"
get "${TEX_BASE}/2k_earth_daymap.jpg"   textures/earth_day.jpg    ffd8ff 200000
get "${TEX_BASE}/2k_earth_nightmap.jpg" textures/earth_night.jpg  ffd8ff 100000
get "${TEX_BASE}/2k_earth_clouds.jpg"   textures/earth_clouds.jpg ffd8ff 300000

# 高光图（水体遮罩）官方只提供 TIFF，浏览器不认，需转一次。
# 它驱动海洋的太阳反射点，也是升温蒸干/降温结冰的作用范围，值得留。
if [ ! -f textures/earth_spec.jpg ]; then
  echo "  下载中  textures/earth_spec.jpg（TIFF 转 JPEG）"
  curl -fL --progress-bar -o textures/_spec_src.tif "${TEX_BASE}/2k_earth_specular_map.tif"
  if ! python -c "
from PIL import Image
im = Image.open('textures/_spec_src.tif').convert('L')
im.save('textures/earth_spec.jpg', quality=88, optimize=True)
print('    转换完成', im.size)
" 2>/dev/null; then
    echo "  !! 需要 Pillow 来转换 TIFF：pip install Pillow" >&2
    echo "  !! 未生成 earth_spec.jpg —— 页面仍可运行，但海洋反射点和" >&2
    echo "     温度对水体的作用范围会退化为按颜色推断，精度略低。" >&2
  fi
  rm -f textures/_spec_src.tif
else
  echo "  已存在  textures/earth_spec.jpg ($(du -h textures/earth_spec.jpg | cut -f1))"
fi

echo "MediaPipe WASM 运行时 v${MP_VER}"
get "${WASM_BASE}/vision_wasm_internal.js"   vendor/wasm/vision_wasm_internal.js   "" 100000
# WASM 魔数 \0asm
get "${WASM_BASE}/vision_wasm_internal.wasm" vendor/wasm/vision_wasm_internal.wasm 0061736d 5000000

echo "手势识别模型"
# .task 是 MediaPipe 的容器：两个 null 字节 + zip（"PK"），并非裸 zip
get "$MODEL_URL" models/gesture_recognizer.task 0000504b 5000000

echo
echo "完成。运行：python serve.py 8123"
