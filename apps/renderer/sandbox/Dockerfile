# S5e's actual security boundary. `apps/renderer`'s Node process (../src) is the composition
# root that receives render requests and orchestrates `docker run` against *this* image, once
# per render, fresh scratch dir every time (docs/subphases/S5e-latex-renderer.md deliverable
# 1). This image is never the thing that stays up: it exists to be `docker run --rm` per job
# and thrown away.
#
# Two stages. The builder has network access — needed once, at *image build* time — to fetch
# the tectonic binary and pre-warm its package cache (techical_plan §13.5, §20: "pre-warm the
# cache into the image so the render container needs no network at runtime"). The final stage
# is `FROM scratch`: no shell, no coreutils, no /etc/passwd, nothing to `\input` by accident
# and nothing to exec even if some future TeX engine bug reopened shell-escape. This is
# belt-and-suspenders on top of `--network none`/`--read-only`, not a replacement for them —
# apps/renderer/src/sandbox.ts still applies those flags at `docker run`.
FROM alpine:3.20 AS builder
ARG TECTONIC_VERSION=0.17.0
RUN apk add --no-cache curl tar
WORKDIR /build
RUN curl -sL -o tectonic.tar.gz \
      "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    && tar xzf tectonic.tar.gz \
    && chmod +x tectonic

# The package allowlist lives here, as the set of documents this step compiles — nothing
# outside what these two documents pull in is fetchable at runtime, because there is no
# runtime network to fetch it over (S5e deliverable 1: "a narrow package allowlist baked into
# the pre-warmed cache; nothing outside it is reachable, network or otherwise").
COPY warmup /build/warmup
ENV HOME=/build/home
ENV XDG_CACHE_HOME=/build/cache
RUN mkdir -p /build/home /build/cache /build/warmup-out \
    && ./tectonic --outdir /build/warmup-out /build/warmup/warm-article.tex \
    && ./tectonic --outdir /build/warmup-out /build/warmup/warm-beamer.tex \
    && chmod -R a+rX /build/cache /build/tectonic

FROM scratch
COPY --from=builder /build/tectonic /tectonic
COPY --from=builder /build/cache /cache
ENV XDG_CACHE_HOME=/cache
ENV HOME=/cache
# Belt-and-suspenders alongside the `--untrusted` flag apps/renderer always passes: shell
# escape is off even if some future call site ever forgot the flag. Neither alone is "a flag
# that could be left on" — `--untrusted` cannot be overridden by `-Z shell-escape` on the same
# command line, and this env var forces the same posture with no command line at all.
ENV TECTONIC_UNTRUSTED_MODE=1
WORKDIR /work
ENTRYPOINT ["/tectonic"]
