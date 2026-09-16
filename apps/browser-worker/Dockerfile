FROM python:3.12-slim-bookworm

ARG CAMOUFOX_BROWSER=official/stable/135.0.1-beta.24
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 CAMOUFOX_BROWSER=${CAMOUFOX_BROWSER}
WORKDIR /worker

RUN apt-get update && apt-get install -y --no-install-recommends xvfb ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY apps/browser-worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
  && camoufox set "${CAMOUFOX_BROWSER}" \
  && camoufox fetch
COPY apps/browser-worker/src ./src

RUN useradd --create-home --uid 10001 worker && mkdir -p /profiles && chown -R worker:worker /worker /profiles
USER worker
EXPOSE 8080
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8080"]
