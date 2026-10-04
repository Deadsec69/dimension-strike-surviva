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
