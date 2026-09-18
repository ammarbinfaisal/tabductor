from __future__ import annotations

import asyncio
import base64
import io
import tarfile
import time
import secrets
import ipaddress
import os
import re
import socket
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from camoufox.async_api import AsyncCamoufox
from .recording import Recorder
from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

RPC_VERSION = "1"
PROFILE_ROOT = Path(os.environ.get("TABDUCTOR_PROFILE_ROOT", "/profiles")).resolve()
TOKEN = os.environ.get("TABDUCTOR_WORKER_TOKEN", "")
ID = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")


class StartRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=160)
    generation: int = Field(ge=1)
    profile_dir: str
    locale: str | None = None
    proxy: dict[str, str] | None = None
    snapshot: str | None = None
    fingerprint: dict[str, Any] = Field(default_factory=dict)


class ControlRequest(BaseModel):
    generation: int = Field(ge=1)
    input_generation: int = Field(ge=1)
    owner: str


class CommandRequest(BaseModel):
    generation: int = Field(ge=1)
    method: str = Field(min_length=1, max_length=80)
    command_id: str = Field(min_length=1, max_length=160)
    input_generation: int = Field(ge=1)
    page_id: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)


@dataclass
class Session:
    session_id: str
    generation: int
    manager: Any
    context: Any
    pages: dict[str, Any] = field(default_factory=dict)
    next_page: int = 1
    input_generation: int = 1
    input_owner: str = "ai"
    commands: set[str] = field(default_factory=set)
    profile: Path | None = None

    def add_page(self, page: Any) -> str:
        page_id = f"p{self.next_page}"
        self.next_page += 1
        self.pages[page_id] = page
        return page_id


session: Session | None = None
command_lock = asyncio.Lock()
used = False
clean_snapshot: str | None = None
recorder: Recorder | None = None
control_vnc: Any = None
recording_session_id: str | None = None
human_view_active = False


async def stop_control_vnc():
    global control_vnc
    if control_vnc is not None and control_vnc.returncode is None:
        control_vnc.terminate()
        await control_vnc.wait()
    control_vnc = None


async def start_control_vnc():
    global control_vnc
    control_vnc = await asyncio.create_subprocess_exec("x11vnc", "-display", os.environ.get("DISPLAY", ":99"), "-localhost", "-rfbport", "5901", "-forever", "-shared", "-nopw", "-quiet", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
app = FastAPI(title="Tabductor Camoufox worker", version=RPC_VERSION)


def authorize(authorization: str | None, rpc_version: str | None) -> None:
    if rpc_version != RPC_VERSION:
        raise HTTPException(426, f"RPC version {RPC_VERSION} required")
    if not TOKEN or not secrets.compare_digest(authorization or "", f"Bearer {TOKEN}"):
        raise HTTPException(401, "invalid worker token")


def safe_profile(relative: str) -> Path:
    candidate = (PROFILE_ROOT / relative).resolve()
    if PROFILE_ROOT not in candidate.parents or candidate == PROFILE_ROOT:
        raise HTTPException(400, "profile path is outside the worker profile root")
    return candidate


def require_session(generation: int) -> Session:
    if session is None:
        raise HTTPException(404, "session is not running")
    if session.generation != generation:
        raise HTTPException(409, "stale session generation")
    return session


def require_page(current: Session, page_id: str | None) -> Any:
    page = current.pages.get(page_id or "")
    if page is None:
        raise HTTPException(404, "page not found")
    return page


def public_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(400, "only http(s) navigation is allowed")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(parsed.hostname, parsed.port or 443)}
    except socket.gaierror as error:
        raise HTTPException(400, "navigation host did not resolve") from error
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
            if os.environ.get("TABDUCTOR_ALLOW_PRIVATE_EGRESS") != "1":
                raise HTTPException(403, "private network navigation is blocked")
    return value


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {"ok": True, "rpc_version": RPC_VERSION, "allocated": session is not None}


async def start_session(
    request: StartRequest,
    authorization: str | None = Header(default=None),
    x_tabductor_rpc_version: str | None = Header(default=None),
) -> dict[str, Any]:
    global session, used, recorder, recording_session_id
    authorize(authorization, x_tabductor_rpc_version)
    if not ID.fullmatch(request.session_id):
        raise HTTPException(400, "invalid session id")
    if session is not None:
        if session.session_id == request.session_id and session.generation == request.generation:
            return {"session_id": session.session_id, "generation": session.generation, "idempotent": True}
        raise HTTPException(409, "worker is already allocated")
    if used:
        raise HTTPException(409, "used workers cannot be allocated again")
    used = True
    profile = safe_profile(request.profile_dir)
    profile.mkdir(parents=True, exist_ok=True)
    if request.snapshot:
        raw = base64.b64decode(request.snapshot, validate=True)
        if len(raw) > 128 * 1024 * 1024:
            raise HTTPException(413, "profile snapshot is too large")
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
            members = archive.getmembers()
            if sum(member.size for member in members) > 512 * 1024 * 1024 or len(members) > 100000:
                raise HTTPException(413, "expanded profile exceeds its limit")
            for member in members:
                target = (profile / member.name).resolve()
                if profile not in target.parents or not (member.isfile() or member.isdir()):
                    raise HTTPException(400, "unsafe profile archive")
            archive.extractall(profile, members=members, filter="data")
    options: dict[str, Any] = {
        "headless": False,
        "persistent_context": True,
        "user_data_dir": str(profile),
        "humanize": True,
    }
    if request.fingerprint:
        options["config"] = request.fingerprint
    if request.locale:
        options["locale"] = request.locale
    if request.proxy:
        options["proxy"] = request.proxy
    manager = AsyncCamoufox(**options)
    context = await manager.__aenter__()
    session = Session(request.session_id, request.generation, manager, context, profile=profile)
    recorder = Recorder(PROFILE_ROOT / "recordings")
    recording_session_id = session.session_id
    await recorder.start()
    for page in context.pages:
        session.add_page(page)
    return {"session_id": request.session_id, "generation": request.generation, "idempotent": False}


@app.post("/v1/sessions")
async def start_locked(request: StartRequest, authorization: str | None = Header(default=None), x_tabductor_rpc_version: str | None = Header(default=None)) -> dict[str, Any]:
    async with command_lock:
        return await start_session(request, authorization, x_tabductor_rpc_version)


@app.delete("/v1/sessions/{session_id}")
async def stop_session(session_id: str, generation: int, authorization: str | None = Header(default=None), x_tabductor_rpc_version: str | None = Header(default=None)) -> dict[str, Any]:
    global session, clean_snapshot
    authorize(authorization, x_tabductor_rpc_version)
    async with command_lock:
        if session is None and clean_snapshot is not None:
            return {"closed": True, "snapshot": clean_snapshot}
        current = require_session(generation)
        if current.session_id != session_id:
            raise HTTPException(404, "session not found")
        current.input_owner = "paused"
        await stop_control_vnc()
        if recorder:
            await recorder.finish()
        await current.context.close()
        await current.manager.__aexit__(None, None, None)
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            for path in current.profile.rglob("*"):
                if path.is_file() and not path.is_symlink() and path.name not in {"lock", ".parentlock"}:
                    archive.add(path, arcname=str(path.relative_to(current.profile)), recursive=False)
        if output.tell() > 128 * 1024 * 1024:
            raise HTTPException(413, "profile snapshot exceeds its limit")
        clean_snapshot = base64.b64encode(output.getvalue()).decode("ascii")
        session = None
        return {"closed": True, "snapshot": clean_snapshot}


@app.post("/v1/sessions/{session_id}/control")
async def control(session_id: str, request: ControlRequest, authorization: str | None = Header(default=None), x_tabductor_rpc_version: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization, x_tabductor_rpc_version)
    async with command_lock:
        current = require_session(request.generation)
        if current.session_id != session_id:
            raise HTTPException(404, "session not found")
        if request.input_generation < current.input_generation or request.owner not in {"ai", "human", "paused"}:
            raise HTTPException(409, "stale input owner")
        if request.input_generation == current.input_generation and request.owner != current.input_owner:
            raise HTTPException(409, "input generation already assigned")
        if request.input_generation != current.input_generation or request.owner != current.input_owner:
            await stop_control_vnc()
            if request.owner == "human":
                if recorder:
                    await recorder.private()
                await start_control_vnc()
        current.input_generation = request.input_generation
        current.input_owner = request.owner
        return {"acknowledged": True, "input_generation": current.input_generation}


@app.post("/v1/sessions/{session_id}/commands")
async def command_locked(session_id: str, request: CommandRequest, authorization: str | None = Header(default=None), x_tabductor_rpc_version: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization, x_tabductor_rpc_version)
    async with command_lock:
        current = require_session(request.generation)
        if current.session_id != session_id:
            raise HTTPException(404, "session not found")
        if current.input_owner != "ai" or current.input_generation != request.input_generation:
            raise HTTPException(409, "input ownership was revoked")
        if request.command_id in current.commands:
            raise HTTPException(409, "command already submitted; outcome must be reconciled")
        if len(current.commands) >= 10000:
            raise HTTPException(429, "session command budget exhausted")
        current.commands.add(request.command_id)
        if request.method == "page.insert_text" and recorder:
            await recorder.private()
        return await command(session_id, request, authorization, x_tabductor_rpc_version)


async def command(
    session_id: str,
    request: CommandRequest,
    authorization: str | None = Header(default=None),
    x_tabductor_rpc_version: str | None = Header(default=None),
) -> dict[str, Any]:
    authorize(authorization, x_tabductor_rpc_version)
    current = require_session(request.generation)
    if current.session_id != session_id:
        raise HTTPException(404, "session not found")
    params = request.params

    if request.method == "browser.version":
        return {"value": "camoufox"}
    if request.method == "page.create":
        page = await current.context.new_page()
        return {"value": {"page_id": current.add_page(page)}}

    page = require_page(current, request.page_id)
    if request.method == "page.goto":
        await page.goto(public_url(str(params["url"])), wait_until=params.get("wait_until"), timeout=params.get("timeout"))
        return {"value": None}
    if request.method == "page.click":
        await page.locator(str(params["selector"])).click()
        return {"value": None}
    if request.method == "page.type":
        await page.locator(str(params["selector"])).fill(str(params["text"]))
        return {"value": None}
    if request.method == "page.insert_text":
        locator = page.locator(str(params["selector"]))
        if await locator.count() != 1:
            raise HTTPException(409, "target is absent or ambiguous")
        await locator.press_sequentially(str(params["text"]))
        return {"value": None}
    if request.method == "page.wait_for":
        await page.locator(str(params["selector"])).wait_for(state=params.get("state"), timeout=params.get("timeout"))
        return {"value": None}
    if request.method == "page.wait_for_load_state":
        await page.wait_for_load_state(params["state"], timeout=params.get("timeout"))
        return {"value": None}
    if request.method == "page.title":
        return {"value": await page.title()}
    if request.method == "page.url":
        return {"value": page.url}
    if request.method == "page.screenshot":
        return {"value": base64.b64encode(await page.screenshot(type="png")).decode("ascii")}
    if request.method == "page.scroll":
        await page.keyboard.press("PageDown" if params.get("direction") == "down" else "PageUp")
        return {"value": None}
    if request.method == "page.close":
        await page.close()
        current.pages.pop(request.page_id or "", None)
        return {"value": None}
    if request.method == "page.upload":
        await page.locator(str(params["selector"])).set_input_files({
            "name": str(params["name"]),
            "mimeType": str(params["mime_type"]),
            "buffer": base64.b64decode(str(params["bytes"])),
        })
        return {"value": None}
    if request.method == "page.query_all":
        return {"value": await page.locator(str(params["selector"])).evaluate_all("""
          (nodes, fields) => nodes.map((root) => Object.fromEntries(Object.entries(fields).map(([name, spec]) => {
            const node = spec.selector ? root.querySelector(spec.selector) : root;
            return [name, node ? (spec.attr ? node.getAttribute(spec.attr) : (node.textContent || '').trim()) : null];
          })))
        """, params.get("fields", {}))}
    if request.method == "page.probe":
        return {"value": await page.locator(str(params["selector"])).evaluate_all("""
          (nodes) => nodes.length === 1 ? {
            tag: nodes[0].tagName.toLowerCase(), type: nodes[0].getAttribute('type'),
            contentEditable: nodes[0].isContentEditable, frameOrigin: location.origin
          } : null
        """)}
    if request.method == "challenge.apply":
        if recorder:
            await recorder.private()
        applied = await page.evaluate("""(args) => {
          const selector = args.kind === 'recaptcha_v2' ? '.g-recaptcha' : '.cf-turnstile';
          const widget = document.querySelector(selector);
          if (!widget || widget.getAttribute('data-sitekey') !== args.site_key) return false;
          const callback = widget.getAttribute('data-callback');
          if (!callback || !/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(callback)) return false;
          const fn = callback.split('.').reduce((value, key) => value?.[key], window);
          if (typeof fn !== 'function') return false;
          fn(args.token);
          return true;
        }""", params)
        if not applied:
            return {"value": False}
        await page.wait_for_timeout(500)
        recovered = await page.locator('.g-recaptcha:visible,.cf-turnstile:visible').count() == 0
        return {"value": recovered}
    if request.method == "page.perceive":
        value = await page.evaluate("""
          (maxChars) => {
            const candidates = [...document.querySelectorAll('a,button,input,textarea,select,[role],[data-testid]')].slice(0, 300);
            const elements = candidates.map((el, i) => {
              const testid = el.getAttribute('data-testid'); const role = el.getAttribute('role');
              const name = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || null;
              const text = (el.textContent || '').trim().slice(0, 300) || null;
              el.setAttribute("data-tabductor-anchor", `e${i + 1}`);
              const locator = testid ? `[data-testid="${CSS.escape(testid)}"]` : `[data-tabductor-anchor="e${i + 1}"]`;
              return {anchor:`e${i + 1}`, tag:el.tagName.toLowerCase(), role, name, text,
                strategy:testid?'testid':role?'role':text?'text':'css-path', locator};
            });
            return {url:location.href, title:document.title, elements, text:(document.body?.innerText || '').slice(0, maxChars)};
          }
        """, int(params.get("max_chars", 8000)))
        challenge = await page.evaluate("""() => {
          const widget = document.querySelector('.g-recaptcha[data-sitekey],.cf-turnstile[data-sitekey]');
          if (widget && widget.getBoundingClientRect().height > 0) return {kind: widget.classList.contains('g-recaptcha') ? 'recaptcha_v2' : 'turnstile', websiteUrl: location.href, siteKey: widget.getAttribute('data-sitekey')};
          if (document.querySelector('input[autocomplete="one-time-code"]')) return {kind:'mfa', websiteUrl:location.href, siteKey:''};
          return null;
        }""")
        if challenge:
            value["challenge"] = challenge
        return {"value": value}
    raise HTTPException(400, f"unsupported method {request.method}")


@app.websocket("/v1/sessions/{session_id}/view")
async def view(websocket: WebSocket, session_id: str, generation: int, input_generation: int, access: str):
    global human_view_active
    authorize(websocket.headers.get("authorization"), websocket.headers.get("x-tabductor-rpc-version"))
    current = require_session(generation)
    if current.session_id != session_id or access not in {"view", "control"}:
        await websocket.close(code=1008)
        return
    def allowed():
        return session is current and (access == "view" or (current.input_owner == "human" and current.input_generation == input_generation))
    if not allowed():
        await websocket.close(code=1008)
        return
    async with command_lock:
        if access == "control":
            if human_view_active or not allowed():
                await websocket.close(code=1008)
                return
            human_view_active = True
    # Two VNC servers: the viewer port is enforced read-only by x11vnc, independently of the client.
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", 5901 if access == "control" else 5900)
    except Exception:
        if access == "control":
            human_view_active = False
        raise
    await websocket.accept()
    async def downstream():
        while allowed():
            data = await reader.read(65536)
            if not data:
                break
            await websocket.send_bytes(data)
    async def upstream():
        while allowed():
            data = await websocket.receive_bytes()
            async with command_lock:
                if not allowed():
                    break
                writer.write(data)
                await writer.drain()
    async def watch():
        while allowed():
            await asyncio.sleep(0.1)
    tasks = [asyncio.create_task(downstream()), asyncio.create_task(upstream()), asyncio.create_task(watch())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        writer.close()
        await writer.wait_closed()
        if access == "control":
            human_view_active = False
        try:
            await websocket.close()
        except (RuntimeError, WebSocketDisconnect):
            pass


@app.get("/v1/sessions/{session_id}/recording")
async def recording(session_id: str, after: int = -1, authorization: str | None = Header(default=None), x_tabductor_rpc_version: str | None = Header(default=None)):
    authorize(authorization, x_tabductor_rpc_version)
    if session_id != recording_session_id or recorder is None:
        raise HTTPException(404, "recording not found")
    return recorder.read(after)
