#!/bin/sh
set -eu
Xvfb :99 -screen 0 1366x768x24 -nolisten tcp &
export DISPLAY=:99
exec uvicorn src.main:app --host 0.0.0.0 --port 8080
