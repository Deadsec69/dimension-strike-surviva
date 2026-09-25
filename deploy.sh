#!/usr/bin/env bash
# Publish the site in this directory to GitHub Pages (root of the gh-pages branch).
#
#   https://mr-salticidae.github.io/dimension-strike/
#
# Why a separate deploy branch: main used to keep textures/, models/*.task and vendor/wasm/
# out of git (see fetch-assets.sh), and GitHub Pages serves a branch's contents as-is —
# there is no build step to run the fetch script. So those binaries have to sit in the deploy branch.
#
# Run fetch-assets.sh first; this script checks that the artifacts are all present.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(pwd -P)

BRANCH=gh-pages

for f in textures/earth_day.jpg textures/earth_night.jpg textures/earth_clouds.jpg \
         vendor/wasm/vision_wasm_internal.js vendor/wasm/vision_wasm_internal.wasm \
         models/gesture_recognizer.task; do
  [ -f "$f" ] || { echo "missing $f - run 'bash fetch-assets.sh' first" >&2; exit 1; }
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --depth 1 --single-branch --branch "$BRANCH" \
  "$(git remote get-url origin)" "$WORK/site"

# Wipe before copying so files deleted on main also disappear here; .git is untouched
git -C "$WORK/site" rm -rq --ignore-unmatch .
cp -r index.html css js vendor models textures LICENSE README.md .gitattributes "$WORK/site"/
# Without this, Jekyll steps in and rearranges the directory
touch "$WORK/site/.nojekyll"

cd "$WORK/site"
git add -A
if git diff --cached --quiet; then
  echo "identical to what is live, nothing to deploy"
  exit 0
fi

git commit -q -m "deploy $(date -u '+%Y-%m-%d %H:%M UTC') · main@$(git -C "$ROOT" rev-parse --short HEAD)"
git push -q origin "$BRANCH"
echo "pushed. Pages takes about half a minute to build, then:"
echo "  https://mr-salticidae.github.io/dimension-strike/"
