"""Recoverable screen segments. Sensitive interaction disables capture for the rest of the session."""
import asyncio
import base64
import os
import time
from pathlib import Path

class Recorder:
    def __init__(self, directory: Path):
        self.directory = directory
        self.started = time.monotonic()
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
            "-i", os.environ.get("DISPLAY", ":99"), "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-g", "20", "-f", "segment", "-segment_time", "2", "-reset_timestamps", "1", str(self.directory / "%09d.ts"),
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
        paths = sorted(self.directory.glob("*.ts"))
        for path in (paths if final else paths[:-1]):
            if path.name in self.seen:
                continue
            self.seen.add(path.name)
            index = int(path.stem)
            if path.stat().st_size:
                self.segments.append({"sequence": len(self.segments), "start_ms": index * 2000,
                    "end_ms": min((index + 1) * 2000, self.offset()), "status": "ready", "path": path})

    async def private(self):
        if self.private_start is None:
            await self.stop_capture()
            self.private_start = self.offset()

    async def finish(self):
        await self.stop_capture()
        if self.private_start is not None and not self.finished:
            self.segments.append({"sequence": len(self.segments), "start_ms": self.private_start, "end_ms": self.offset(), "status": "private"})
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
