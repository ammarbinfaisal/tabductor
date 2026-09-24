FROM python:3.12-slim-bookworm

ARG CAMOUFOX_BROWSER=official/stable/152.0.4-beta.30
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 CAMOUFOX_BROWSER=${CAMOUFOX_BROWSER} XDG_CACHE_HOME=/opt/browser-cache XDG_DATA_HOME=/opt/browser-data
WORKDIR /worker

RUN apt-get update && apt-get install -y --no-install-recommends xvfb x11vnc x11-utils ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY apps/browser-worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
  && playwright install-deps firefox \
  && camoufox sync \
  && camoufox fetch "${CAMOUFOX_BROWSER}" \
  && camoufox set "${CAMOUFOX_BROWSER}" \
  && camoufox active | grep -F "${CAMOUFOX_BROWSER}"
RUN apt-get update && apt-get install -y --no-install-recommends xclip xdotool \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 worker && mkdir -p /profiles /opt/browser-data && chown -R worker:worker /worker /profiles /opt/browser-cache /opt/browser-data
COPY apps/browser-worker/src ./src
COPY vendor/browser-harness/src/browser_harness/camoufox.py vendor/browser-harness/src/browser_harness/playwright_worker.py vendor/browser-harness/src/browser_harness/playwright_manifest.json /worker/harness/browser_harness/
ENV PYTHONPATH=/worker/harness
COPY packages/browser/src/perception-script.js ./src/perception-script.js
COPY apps/browser-worker/entrypoint.sh ./entrypoint.sh

USER worker
EXPOSE 8080
CMD ["sh", "entrypoint.sh"]
