"""Recoverable screen segments. Sensitive interaction disables capture for the rest of the session."""
import asyncio
import base64
import csv
import json
import os
import subprocess
import time
from pathlib import Path

class Recorder:
    def __init__(self, directory: Path):
        self.directory = directory
        self.started = time.monotonic()
        self.wall_started_ms = time.time() * 1000
        self.process = None
        self.segments = []
        self.seen = set()
        self.private_start = None
        self.finished = False

    def offset(self):
        return max(0, int((time.monotonic() - self.started) * 1000))

    async def start(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        self.process = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "x11grab", "-video_size", "1366x768", "-framerate", "10",
            "-use_wallclock_as_timestamps", "1", "-copyts", "-i", os.environ.get("DISPLAY", ":99"), "-vsync", "0", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-g", "20", "-f", "segment", "-segment_list", str(self.directory / "segments.csv"), "-segment_list_type", "csv", "-segment_time", "2", "-reset_timestamps", "1", str(self.directory / "%09d.ts"),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)

    async def stop_capture(self):
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        self.collect(final=True)

    def collect(self, final=False):
        manifest = self.directory / "segments.csv"
        if not manifest.exists():
            return
        for row in csv.reader(manifest.read_text().splitlines()):
            if len(row) != 3 or row[0] in self.seen:
                continue
            path = self.directory / Path(row[0]).name
            try:
                start_ms = max(0, round(float(row[1]) * 1000 - self.wall_started_ms))
                end_ms = max(start_ms, round(float(row[2]) * 1000 - self.wall_started_ms))
            except ValueError:
                continue
            if not path.exists() or not path.stat().st_size or end_ms <= start_ms:
                continue
            # The segment muxer reports zero for the first start even with copyts.
            # Its end is a wall-clock timestamp; recover the actual first-frame time
            # from the encoded duration so startup latency is an explicit gap.
            if float(row[1]) == 0:
                try:
                    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "json", str(path)], capture_output=True, text=True, check=True, timeout=5)
                    duration_ms = round(float(json.loads(probe.stdout)["format"]["duration"]) * 1000)
                    start_ms = max(0, end_ms - duration_ms)
                except (ValueError, KeyError, subprocess.SubprocessError):
                    continue
            self.seen.add(row[0])
            previous_end = self.segments[-1]["end_ms"] if self.segments else 0
            if start_ms > previous_end:
                self.segments.append({"sequence": len(self.segments), "start_ms": previous_end, "end_ms": start_ms, "status": "gap"})
            self.segments.append({"sequence": len(self.segments), "start_ms": start_ms,
                "end_ms": end_ms, "status": "ready", "path": path})

    async def private(self):
        if self.private_start is None:
            await self.stop_capture()
            # A final frame has duration and can extend a few milliseconds beyond
            # capture shutdown. Never overlap the private interval with that frame.
            self.private_start = max(self.offset(), self.segments[-1]["end_ms"] if self.segments else 0)

    async def finish(self):
        await self.stop_capture()
        if self.private_start is not None and not self.finished:
            self.segments.append({"sequence": len(self.segments), "start_ms": self.private_start, "end_ms": max(self.private_start, self.offset()), "status": "private"})
        self.finished = True

    def read(self, after):
        self.collect(final=self.finished)
        result = []
        for segment in self.segments:
            if segment["sequence"] <= after:
                continue
            item = {key: value for key, value in segment.items() if key != "path"}
            if "path" in segment:
                item["bytes"] = base64.b64encode(segment["path"].read_bytes()).decode("ascii")
            result.append(item)
            if len(result) >= 8:
                break
        return {"segments": result, "finished": self.finished, "private": self.private_start is not None}
