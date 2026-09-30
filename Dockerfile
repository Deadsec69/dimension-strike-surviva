# Dimensional Strike - the game runs in the visitor's browser; this image only serves the static
# files (with the COOP/COEP headers MediaPipe's GPU delegate needs) and runs the Gemini pipeline.
FROM python:3.12-slim

# Pillow is the one optional dependency: serve.py's brighten() lifts a murky portrait a stop and
# degrades gracefully without it. Nothing else here needs pip.
RUN pip install --no-cache-dir Pillow==11.* && useradd -m app

WORKDIR /app
COPY --chown=app:app . /app
# runs/ is excluded from the image (it is people's faces and per-deployment state), so the server has
# to be able to create it on first write. WORKDIR makes /app root-owned, which COPY --chown does not
# change - without this the first POST /api/finish dies with EACCES on /app/runs.
RUN mkdir -p /app/runs && chown -R app:app /app
USER app

# The platform supplies PORT; serve.py binds 0.0.0.0 whenever PORT is set.
ENV PORT=8080
EXPOSE 8080
CMD ["python", "serve.py"]
