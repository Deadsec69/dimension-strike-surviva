#!/usr/bin/env bash
# Fetch the runtime dependencies (~20MB total). These are binary artifacts.
#
#   textures/      Earth textures (Solar System Scope, CC BY 4.0)
#   vendor/wasm/   MediaPipe WASM runtime (jsDelivr, version pinned)
#   models/        Gesture recognition model (Google MediaPipe model zoo)
#
# If storage.googleapis.com is unreachable from your network, run this script on a machine
# that can reach it and scp the models/ directory across.
set -euo pipefail
cd "$(dirname "$0")"

MP_VER="0.10.18"
WASM_BASE="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"
TEX_BASE="https://www.solarsystemscope.com/textures/download"

# Compare file headers as hex: some of these start with null bytes, and bash command
# substitution silently drops nulls, so comparing raw bytes would never match.
head_hex() { head -c "$1" "$2" | od -An -tx1 | tr -d ' \n'; }

get() {   # get <url> <destination path> <expected header in hex> <minimum bytes>
  local url="$1" out="$2" magic="${3:-}" minsize="${4:-0}"
  if [ -f "$out" ]; then
    echo "  exists    $out ($(du -h "$out" | cut -f1))"
    return 0
  fi
  mkdir -p "$(dirname "$out")"
  echo "  fetching  $out"
  curl -fL --progress-bar -o "$out" "$url"

  local size
  size=$(wc -c < "$out" | tr -d ' ')
  if [ "$size" -lt "$minsize" ]; then
    echo "  suspicious size (${size}B, expected at least ${minsize}B) - probably an error page, deleted" >&2
    rm -f "$out"; return 1
  fi
  if [ -n "$magic" ]; then
    local got
    got=$(head_hex $(( ${#magic} / 2 )) "$out")
    if [ "$got" != "$magic" ]; then
      echo "  header mismatch (got $got, expected $magic), deleted" >&2
      rm -f "$out"; return 1
    fi
  fi
}

echo "Earth textures (Solar System Scope · CC BY 4.0)"
get "${TEX_BASE}/2k_earth_daymap.jpg"   textures/earth_day.jpg    ffd8ff 200000
get "${TEX_BASE}/2k_earth_nightmap.jpg" textures/earth_night.jpg  ffd8ff 100000
get "${TEX_BASE}/2k_earth_clouds.jpg"   textures/earth_clouds.jpg ffd8ff 300000

# The specular map (water mask) is only published as TIFF, which browsers won't load, so convert it.
# It drives the sun's reflection on the ocean and bounds where heating boils / cooling freezes. Worth keeping.
if [ ! -f textures/earth_spec.jpg ]; then
  echo "  fetching  textures/earth_spec.jpg (TIFF -> JPEG)"
  curl -fL --progress-bar -o textures/_spec_src.tif "${TEX_BASE}/2k_earth_specular_map.tif"
  if ! python -c "
from PIL import Image
im = Image.open('textures/_spec_src.tif').convert('L')
im.save('textures/earth_spec.jpg', quality=88, optimize=True)
print('    converted', im.size)
" 2>/dev/null; then
    echo "  !! Pillow is needed to convert the TIFF: pip install Pillow" >&2
    echo "  !! earth_spec.jpg was not created - the page still runs, but the ocean" >&2
    echo "     reflection and the reach of temperature over water fall back to" >&2
    echo "     inferring water from color, which is less precise." >&2
  fi
  rm -f textures/_spec_src.tif
else
  echo "  exists    textures/earth_spec.jpg ($(du -h textures/earth_spec.jpg | cut -f1))"
fi

echo "MediaPipe WASM runtime v${MP_VER}"
get "${WASM_BASE}/vision_wasm_internal.js"   vendor/wasm/vision_wasm_internal.js   "" 100000
# WASM magic number \0asm
get "${WASM_BASE}/vision_wasm_internal.wasm" vendor/wasm/vision_wasm_internal.wasm 0061736d 5000000

echo "Gesture recognition model"
# .task is a MediaPipe container: two null bytes then a zip ("PK"), not a bare zip
get "$MODEL_URL" models/gesture_recognizer.task 0000504b 5000000

echo
echo "Done. Run: python serve.py 8123"
