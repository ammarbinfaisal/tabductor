FROM python:3.12-slim-bookworm

ARG CAMOUFOX_BROWSER=official/stable/135.0.1-beta.24
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
COPY apps/browser-worker/src ./src
COPY apps/browser-worker/entrypoint.sh ./entrypoint.sh

RUN useradd --create-home --uid 10001 worker && mkdir -p /profiles /opt/browser-data && chown -R worker:worker /worker /profiles /opt/browser-cache /opt/browser-data
USER worker
EXPOSE 8080
CMD ["sh", "entrypoint.sh"]
