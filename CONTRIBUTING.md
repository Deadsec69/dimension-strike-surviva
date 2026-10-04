# Contributing

This is a small project with strong opinions baked into it. The comments explain *why* far more often
than *what*, because the what is usually visible and the why is what gets lost.

## Before changing rendering

Read the "Implementation notes" section of the README first. Most of the non-obvious code is non-obvious
because the obvious version was tried and looked wrong, and that is recorded.

## Run it

```bash
bash fetch-assets.sh    # only if the binaries are missing; the repo commits them
python serve.py 8123
```

`localhost` is a secure context, so the camera works without any certificate.

## Conventions

- No build step, and no pip dependencies. Pillow is optional and the code degrades without it.
- Comments say why. If a constant looks arbitrary, the comment should say what went wrong at other
  values.
- Interface copy is English; so is everything else in the repo.

## Testing

There is no test runner. Changes are verified by driving the real thing: `window.__ds` exposes
`stage`, `civ`, `survival`, `board`, `gesture` and `fire()` so a headless browser can play a run
without a camera, and `survival._spawnAt()` places a rock exactly where a test wants it.

## Secrets

Never commit a key. `.env` and `deploy/.env` are gitignored; the `.example` files carry blank values.
Error strings that reach a client are scrubbed, and public rows carry codes rather than exception text.

## Privacy

Portraits are likenesses of real people. A visitor sees only the ones their own browser generated, and
`runs/` is never served as static files. Keep it that way.
