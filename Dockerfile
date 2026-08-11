# One image, three commands: migrate, engine, web (see docker-compose.yml).
#
# One rather than three because they share a workspace — the packages the engine executes
# are the packages the web app reads through, and building them twice would let the two
# drift between rebuilds. Which process runs is the container's `command`.

FROM node:24-bookworm-slim AS base
# Corepack downloads the pinned pnpm on first use. Pointing its cache somewhere the runtime
# stage can copy from is what keeps a *started container* from needing the network — the
# alternative is a web service that fails to boot on a machine behind a firewall.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable
WORKDIR /app
ENV CI=true

# Dependencies, in their own layer keyed on the lockfile. `pnpm fetch` populates the store
# from the lockfile alone, so adding a workspace package does not need a line here — the
# alternative (copying every package.json by hand) is a footgun that goes stale silently.
# The root package.json comes along only for its `packageManager` pin, so `corepack install`
# caches the pnpm this repo actually uses rather than whatever is newest.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install && pnpm fetch

FROM deps AS build
COPY . .
# Not `--offline`: `pnpm fetch` is a cache warmer, not a guarantee, and a package it did not
# pull (it is stricter than install about what the lockfile asks for) should be downloaded
# rather than fail the build.
RUN pnpm install --frozen-lockfile
# Typecheck the whole workspace, then build the Next app. A broken build should fail here,
# not at container start.
RUN pnpm build && pnpm -F web build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /opt/corepack /opt/corepack
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
# Overridden per service in compose; this default makes a bare `docker run` do the useful thing.
CMD ["pnpm", "-F", "web", "start"]
