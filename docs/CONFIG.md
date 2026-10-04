# Configuration

Every setting is an environment variable. `serve.py` also reads a `.env` next to it at startup; real
environment variables win over anything in that file.

Nothing here has a default that costs money. With no key set at all the game plays, the board records
every run, and portraits simply stay empty.

## `GEMINI_API_KEY`

Your Gemini key. Used for a visitor's free portrait, and for every portrait if they bring no key of
their own. Read from the environment or `.env`; it is never sent to a browser and never written to
`runs/`.

Unset is a supported mode, not an error: runs still score and the board still records them.
