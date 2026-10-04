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
