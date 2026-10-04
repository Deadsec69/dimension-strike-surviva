# Architecture

How the pieces fit, for anyone changing this who did not write it.

The short version: **the browser does everything that matters.** The server exists to hold one secret
and one folder. If you deleted the server, the game would still play - you would lose the portraits and
the shared leaderboard, and nothing else.

## Where the work happens

| Concern | Runs on | Notes |
|---|---|---|
| Planet, shaders, post-processing | Visitor's GPU | `js/planet.js`, one Three.js scene |
| Gesture recognition | Visitor's CPU/GPU | MediaPipe in a WASM runtime |
| Game simulation | Visitor's CPU | `js/survival.js`, fixed-step on rAF |
| Portrait generation | Server -> Gemini | The only network call per run |
| Leaderboard | Server disk | A single JSON file |

Nothing about gameplay round-trips to the server. There is no tick, no authoritative state, no sync.

## Module map

```
js/main.js       wiring and the frame loop; owns nothing, coordinates everything
js/planet.js     the Three.js scene, every shader, the post chain, camera handling
js/civ.js        the civilization's state and its broadcasts
js/gesture.js    MediaPipe wrapper: the recognition state machine
js/survival.js   survival mode: rocks, shields, beams, scoring (loaded on demand)
js/board.js      end-of-run scoring, portrait polling, the observer board
serve.py         static files, the Gemini pipeline, the board, quota
```

## The frame loop

`main.js` drives one `requestAnimationFrame` loop. Order matters:

1. `survival.update(dt)` first, so this frame's impacts exist before anything reads them.
2. `civ.update(dt, T, P, spin)` consumes the resulting temperature and pressure.
3. `stage.update(dt)` renders, having been told the environment by the two above.

Reversing 1 and 2 makes impacts land a frame late, which reads as input lag on the asteroid that
killed you - the one frame a player is most likely to be watching closely.

## Two clocks

Scene time and real time are deliberately different.

- **Scene time** is scaled by hit-stop, so the fracture can be held for 130ms and released over 240ms.
  Anything that should feel like part of the event uses it.
- **Real time** drives camera shake, the gesture state machine and input handling, so the picture keeps
  moving and the hands keep working while scene time is nearly frozen.

A third clock exists inside `gesture.js`: an internal accumulator capped at 100ms per step, because
neither frame counts (a dim room drops the camera to 15fps) nor `performance.now()` deltas (switching
tabs jumps seconds) survive contact with reality.

## Data flow of one finished run

1. The browser grabs a mirrored JPEG on the frame the run ends - not when the verdict appears 2.7s
   later, by which point the reaction has left the face.
2. `POST /api/finish` records the row and returns immediately, so the score banks even if Gemini is
   slow or down.
3. A background thread reads the expression, generates the portrait, brightens it if Pillow is present,
   and writes it under `runs/<callsign>/`.
4. The page polls `/api/run/:id` until `pending` clears, then swaps the image in - including on the
   board, even if the player has already started another run.
