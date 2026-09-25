# Promo GIFs

Six clips (hero / foil / gravity crush / heating / freezing / spinning, 720 wide) plus a ~22 second
highlight reel (640 wide), all at 12fps, looping forever, and all kept under the **10MB / 300 frame**
limit of the publishing platform.

```bash
python tools/promo-gif/capserve.py     # opens the capture page; the server exits once every frame is shot
python tools/promo-gif/compose.py      # overlays the vignette, flash, verdict, comms subtitles, readouts and touch points
bash   tools/promo-gif/encode.sh       # -> out/gif/01_hero.gif ... 06_spin.gif
python tools/promo-gif/reel.py         # -> out/gif/00_reel.gif
```

To redo only some clips: `capserve.py --clips b_foil,c_crush`, then run `compose.py b_foil c_crush`
and `encode.sh b_foil c_crush` on those. The records for the other clips stay in `out/meta.json`.

Dependencies: ffmpeg, plus Pillow and numpy for Python. Run `fetch-assets.sh` first - capture fails if
the textures are incomplete. All intermediates live in `out/` (gitignored), about 1GB in total.

## Pipeline

**Capture** (`capserve.py` + `capture.js`). `/capture.html` is `index.html` with one line injecting
`capture.js` appended; the site itself carries no capture code. The page stops its own main loop and
advances deterministically 1/24 second at a time, rendering, calling `toDataURL` and POSTing frames
back to the server. Strike frames, fracture frames, comms log entries, slider temperatures and finger
positions are all recorded into `meta.json`, which everything downstream aligns against.

**Compositing** (`compose.py`). The vignette, flash, verdict and comms log are DOM layers the canvas
cannot see, so they are reconstructed from `css/style.css` and overlaid. The type is scaled up: a
960-wide canvas ends up around 0.39x in a feed, and a 20px verdict at original size is 8px on a phone.

**Encoding** (`encode.sh`). Every other frame is taken to reach 12fps, 128 colors with bayer dithering,
and a separate palette per clip.

**Reel** (`reel.py`). One excerpt per clip, with the uneventful parts sped up by dropping frames, dark
transitions between clips and an end card at the finish. The reel's palette is also per-clip: with one
palette for the whole thing, the orange glow around the lava gets only a handful of colors and breaks
into rings. ffmpeg's concat can't join frames with different palettes, so each clip is encoded
separately and then, at the byte level, the later clips' global color tables are rewritten as
per-frame local color tables and stitched together.

## Non-obvious things

- **Grain has to be off.** It changes every pixel every frame, which defeats GIF's inter-frame
  differencing entirely; after 256-color quantization it is invisible anyway.
- **The main loop has to stop.** It advances on real time, and sampling on top of it is no longer
  evenly spaced - in a throttled preview pane it also slips in a 0.05 second step once a second.
- **`toDataURL` must be read in the same task as the render.** One `await` in between and the buffer
  has already been cleared.
- **Heating and freezing speed up the environment only.** Capture advances the environment an extra
  2x (`_dampEnv`) while the camera and rotation stay at normal speed; speeding up everything would
  turn the planet 200 degrees and you could not see what the surface was doing.
- **Heating stops at 800K.** Above 880K the whole planet is white hot and blown out, and the bloom
  smears across the entire frame.
- **The first frame must not be black.** While loading, and in power saving mode, only the first frame
  is shown - so there is a fade out but no fade in, and the loop point is "go dark, cut back to the
  start".
- **The textures are CC BY 4.0.** The hero clip and the reel's end card carry the attribution in small
  type, which is unreadable on a phone, so it has to be repeated in the body of the article.
