#!/usr/bin/env bash
# 把当前目录的站点推到 GitHub Pages（gh-pages 分支根目录）。
#
#   https://mr-salticidae.github.io/dimension-strike/
#
# 为什么要有一条独立的部署分支：main 把 textures/、models/*.task、vendor/wasm/
# 排除在 git 之外（见 fetch-assets.sh），而 GitHub Pages 是「拿分支内容直接发」，
# 没有构建步骤可以跑拉取脚本。所以这些二进制必须躺在部署分支里。
#
# 部署前先跑一次 fetch-assets.sh，脚本会检查产物是否齐全。
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(pwd -P)

BRANCH=gh-pages

for f in textures/earth_day.jpg textures/earth_night.jpg textures/earth_clouds.jpg \
         vendor/wasm/vision_wasm_internal.js vendor/wasm/vision_wasm_internal.wasm \
         models/gesture_recognizer.task; do
  [ -f "$f" ] || { echo "缺少 $f —— 先跑 bash fetch-assets.sh" >&2; exit 1; }
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --depth 1 --single-branch --branch "$BRANCH" \
  "$(git remote get-url origin)" "$WORK/site"

# 先清空再拷，这样 main 里删掉的文件也能同步过去；.git 不受影响
git -C "$WORK/site" rm -rq --ignore-unmatch .
cp -r index.html css js vendor models textures LICENSE README.md .gitattributes "$WORK/site"/
# 没有它 Jekyll 会介入重排目录
touch "$WORK/site/.nojekyll"

cd "$WORK/site"
git add -A
if git diff --cached --quiet; then
  echo "内容与线上一致，无需部署"
  exit 0
fi

git commit -q -m "部署 $(date -u '+%Y-%m-%d %H:%M UTC') · main@$(git -C "$ROOT" rev-parse --short HEAD)"
git push -q origin "$BRANCH"
echo "已推送。Pages 构建约半分钟，然后访问："
echo "  https://mr-salticidae.github.io/dimension-strike/"
