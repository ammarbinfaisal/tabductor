#!/bin/sh
set -eu
Xvfb :99 -screen 0 1366x768x24 -nolisten tcp &
export DISPLAY=:99
for attempt in 1 2 3 4 5; do
  xdpyinfo >/dev/null 2>&1 && break
  sleep 1
done
x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -viewonly -nopw -quiet &
exec uvicorn src.main:app --host 0.0.0.0 --port 8080
