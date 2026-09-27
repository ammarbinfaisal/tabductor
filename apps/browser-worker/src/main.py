from __future__ import annotations

import asyncio
import base64
import io
import json
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
from .observations import Observations
from .auth_state import import_auth_state
from .clipboard import paste_text
from .extraction import extract
from .perception import perceive
from .snapshot_target import snapshot_target
from .rpc_errors import command_error
from fastapi.responses import JSONResponse
from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from playwright.async_api import Error as PlaywrightError

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
    imported_states: list[dict[str, Any]] = Field(default_factory=list)
    fingerprint: dict[str, Any] = Field(default_factory=dict)


class ControlRequest(BaseModel):
    generation: int = Field(ge=1)
    input_generation: int = Field(ge=1)
    owner: str


class NavigateRequest(BaseModel):
    generation: int = Field(ge=1)
    input_generation: int = Field(ge=1)
    url: str = Field(min_length=1, max_length=4096)


class SelectTabRequest(BaseModel):
    generation: int = Field(ge=1)
    page_id: str = Field(min_length=1, max_length=160)


class PasteRequest(BaseModel):
    generation: int = Field(ge=1)
    input_generation: int = Field(ge=1)
    text: str = Field(min_length=1, max_length=100_000)


class CommandRequest(BaseModel):
    generation: int = Field(ge=1)
    method: str = Field(min_length=1, max_length=80)
    command_id: str = Field(min_length=1, max_length=160)
    input_generation: int = Field(ge=1)
    event_cursor: int = Field(default=-1, ge=-1)
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
    observations: Any = None
    frames: dict[str, Any] = field(default_factory=dict)
    context_closed: bool = False
    manager_closed: bool = False
    tab_slots: dict[str, str] = field(default_factory=dict)
    page_locks: dict[str, asyncio.Lock] = field(default_factory=dict)
    inflight: set[Any] = field(default_factory=set)
    selected_page: str | None = None
    dialog_policies: dict[str, dict] = field(default_factory=dict)

    def add_page(self, page: Any) -> str:
        for existing_id, existing in self.pages.items():
            if existing is page:
                return existing_id
        page_id = f"p{self.next_page}"
        self.next_page += 1
        self.pages[page_id] = page
        self.page_locks[page_id] = asyncio.Lock()
        if self.observations:
            self.observations.attach(page, page_id)
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
    for _ in range(50):
        if control_vnc.returncode is not None:
            raise RuntimeError("human input server failed to start")
        try:
            _, writer = await asyncio.open_connection("127.0.0.1", 5901)
            writer.close()
            await writer.wait_closed()
            return
        except OSError:
            await asyncio.sleep(0.1)
    await stop_control_vnc()
    raise RuntimeError("human input server did not become ready")
app = FastAPI(title="Tabductor Camoufox worker", version=RPC_VERSION)

@app.middleware("http")
async def recording_clock(request, call_next):
    active_recorder = recorder
    start = active_recorder.offset() if active_recorder else None
    response = await call_next(request)
    if active_recorder is not None and start is not None:
        response.headers["x-tabductor-recording-start-ms"] = str(start)
        response.headers["x-tabductor-recording-end-ms"] = str(active_recorder.offset())
        response.headers["x-tabductor-recording-private"] = str(active_recorder.private_start is not None).lower()
    return response



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


async def checkpoint_cookies(current: Session):
    """Keep session cookies on disk before a human can close the browser window."""
    if current.context_closed:
        return
    try:
        cookies = await current.context.cookies()
    except PlaywrightError:
        if current.context_closed:
            return
        raise
    target = current.profile / ".tabductor-session-cookies.json"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(cookies))
    temporary.chmod(0o600)
    temporary.replace(target)


def locator_for(current, page, selector):
    match = re.match(r"^@frame:(f[0-9]+) >> (.+)$", selector, re.S)
    if not match:
        return page.locator(selector)
    frame = current.frames.get(match.group(1))
    if frame is None or frame.is_detached() or frame.page is not page:
        raise HTTPException(409, "frame is no longer available")
    return frame.locator(match.group(2))

async def secret_target(current, page, selector):
    if selector.startswith("@frame:"):
        locator = locator_for(current, page, selector)
        return locator if await locator.count() == 1 else None
    for frame in page.frames:
        locator = frame.locator(selector)
        if await locator.count() == 1:
            return locator
    return None

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
        # Explicit harness JS can inspect application globals and browser fetch.
        # Perception and locator scripts continue using the isolated world.
        "main_world_eval": True,
        "user_data_dir": str(profile),
        # Animated cursor movement stalls pointer clicks under Xvfb. Use normal
        # Playwright pointer input; never replay a timed-out click via DOM activation.
        "humanize": False,
        "os": "linux",
        "window": (1366, 768),
    }
    fingerprint_path = profile / ".tabductor-fingerprint.json"
    options["config"] = json.loads(fingerprint_path.read_text()) if fingerprint_path.exists() else request.fingerprint
    if request.locale:
        options["locale"] = request.locale
    if request.proxy:
        options["proxy"] = request.proxy
    from camoufox.utils import launch_options
    prepared = await asyncio.to_thread(launch_options, **options)
    fragments = [(int(key.removeprefix("CAMOU_CONFIG_")), value) for key, value in prepared["env"].items() if key.startswith("CAMOU_CONFIG_")]
    if fingerprint_path.exists():
        # launch_options regenerates some random seeds even with config supplied. Restore
        # the complete original browser configuration after preparing OS launch settings.
        encoded = json.dumps({**json.loads(fingerprint_path.read_text()), "allowMainWorld": True})
        for key in list(prepared["env"]):
            if key.startswith("CAMOU_CONFIG_"):
                del prepared["env"][key]
        for offset in range(0, len(encoded), 32767):
            prepared["env"][f"CAMOU_CONFIG_{offset // 32767 + 1}"] = encoded[offset:offset + 32767]
    else:
        fingerprint_path.write_text("".join(value for _, value in sorted(fragments)))
    manager = AsyncCamoufox(from_options=prepared, persistent_context=True)
    context = await manager.__aenter__()
    try:
        cookies_path = profile / ".tabductor-session-cookies.json"
        if cookies_path.exists():
            await context.add_cookies(json.loads(cookies_path.read_text()))
        await import_auth_state(context, request.imported_states)
    except Exception:
        await manager.__aexit__(None, None, None)
        raise HTTPException(400, "could not restore imported authentication")
    session = Session(request.session_id, request.generation, manager, context, profile=profile)
    current = session
    context.on("close", lambda *_: setattr(current, "context_closed", True))
    await checkpoint_cookies(current)
    session.observations = Observations(session)
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
        await drain_commands(current)
        current.input_owner = "paused"
        await stop_control_vnc()
        if recorder:
            await recorder.finish()
        # Persistent Firefox profiles discard session cookies on a clean close.
        # Keep them inside the encrypted profile archive for the next allocation.
        await checkpoint_cookies(current)
        if not current.manager_closed:
            try:
                await current.manager.__aexit__(None, None, None)
            except PlaywrightError:
                if not current.context_closed:
                    raise
            current.manager_closed = True
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
        if current.context_closed:
            return {"closed": True}
        if request.input_generation < current.input_generation or request.owner not in {"ai", "human", "paused"}:
            raise HTTPException(409, "stale input owner")
        if request.input_generation == current.input_generation and request.owner != current.input_owner:
            raise HTTPException(409, "input generation already assigned")
        # Fleet reconciliation repeats the acknowledged generation. It must not
        # cancel active cells or wait for their browser operations to finish.
        if request.input_generation == current.input_generation:
            # Retain the periodic cookie snapshot for a window closed by its user.
            await checkpoint_cookies(current)
            return {"acknowledged": True, "input_generation": current.input_generation}
        await drain_commands(current)
        await checkpoint_cookies(current)
        await stop_control_vnc()
        if request.owner == "human":
            if recorder:
                await recorder.private()
            await start_control_vnc()
        current.dialog_policies.clear()
        current.input_generation = request.input_generation
        current.input_owner = request.owner
        return {"acknowledged": True, "input_generation": current.input_generation}


@app.post("/v1/sessions/{session_id}/navigate")
async def navigate(session_id: str, request: NavigateRequest, authorization: str | None = Header(default=None), x_tabductor_rpc_version: str | None = Header(default=None)):
    authorize(authorization, x_tabductor_rpc_version)
    async with command_lock:
        current = require_session(request.generation)
        if current.session_id != session_id:
            raise HTTPException(404, "session not found")
        if current.input_owner != "human" or current.input_generation != request.input_generation:
            raise HTTPException(409, "human input ownership required")
        parsed = urlparse(request.url)
        if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
            raise HTTPException(400, "invalid website address")
        target = public_url(request.url)
        pages = [page for page in current.context.pages if not page.is_closed()]
        page = current.pages.get(current.selected_page)
        if page is None or page.is_closed():
            page = pages[-1] if pages else await current.context.new_page()
        await page.goto(target, wait_until="domcontentloaded", timeout=30000)
        await page.bring_to_front()
        return {"navigated": True}


@app.get("/v1/sessions/{session_id}/tabs")
async def list_tabs(session_id: str, generation: int, authorization: str | None = Header(default=None), x_tabductor_rpc_version: str | None = Header(default=None)):
    authorize(authorization, x_tabductor_rpc_version)
    current = require_session(generation)
    if current.session_id != session_id:
        raise HTTPException(404, "session not found")
    async def describe(page):
        page_id = current.add_page(page)
        try:
            title = await page.title()
            selected = await page.evaluate("document.visibilityState === 'visible'")
        except PlaywrightError:
            title, selected = "", False
        if selected:
            current.selected_page = page_id
        return {"pageId": page_id, "title": title[:500], "url": page.url[:4096], "selected": selected,
                "tabKey": next((key for key, value in current.tab_slots.items() if value == page_id), None)}
    return {"tabs": await asyncio.gather(*(describe(page) for page in current.context.pages if not page.is_closed()))}


@app.post("/v1/sessions/{session_id}/tabs/select")
async def select_tab(session_id: str, request: SelectTabRequest, authorization: str | None = Header(default=None), x_tabductor_rpc_version: str | None = Header(default=None)):
    authorize(authorization, x_tabductor_rpc_version)
    async with command_lock:
        current = require_session(request.generation)
        if current.session_id != session_id:
            raise HTTPException(404, "session not found")
        page = require_page(current, request.page_id)
        await page.bring_to_front()
        current.selected_page = request.page_id
        return {"selected": True}


@app.post("/v1/sessions/{session_id}/paste")
async def paste(session_id: str, request: PasteRequest, authorization: str | None = Header(default=None), x_tabductor_rpc_version: str | None = Header(default=None)):
    authorize(authorization, x_tabductor_rpc_version)
    async with command_lock:
        current = require_session(request.generation)
        if current.session_id != session_id:
            raise HTTPException(404, "session not found")
        if current.context_closed or current.input_owner != "human" or current.input_generation != request.input_generation or not human_view_active:
            raise HTTPException(409, "active human control required")
        try:
            await paste_text(request.text)
        except (OSError, RuntimeError, asyncio.TimeoutError):
            raise HTTPException(503, "remote clipboard unavailable") from None
        return {"pasted": True}


async def drain_commands(current: Session):
    # Caller holds command_lock: no new command can enter while takeover/stop drains.
    scopes = getattr(current, "proxy_scopes", {})
    active, current.proxy_scopes = list(scopes.values()), {}
    await asyncio.gather(*(scope.close() for scope in active), return_exceptions=True)
    if current.inflight:
        await asyncio.gather(*list(current.inflight), return_exceptions=True)


@app.exception_handler(HTTPException)
async def http_error_handler(request, error):
    if request.url.path.endswith(("/commands", "/automation")):
        error = command_error(error)
    return JSONResponse(status_code=error.status_code, content={"detail": error.detail})


@app.post("/v1/sessions/{session_id}/commands")
async def command_locked(session_id: str, request: CommandRequest, authorization: str | None = Header(default=None), x_tabductor_rpc_version: str | None = Header(default=None)) -> dict[str, Any]:
    authorize(authorization, x_tabductor_rpc_version)
    current = require_session(request.generation)
    # Page commands serialize only with that page. Context-level creates share a lock.
    lock_key = request.page_id or "browser"
    if request.page_id and request.page_id not in current.pages:
        raise HTTPException(404, "page not found")
    page_lock = current.page_locks.setdefault(lock_key, asyncio.Lock())
    async with page_lock:
        async with command_lock:
            if session is not current or current.session_id != session_id:
                raise HTTPException(404, "session not found")
            if current.input_owner != "ai" or current.input_generation != request.input_generation:
                raise HTTPException(409, "input ownership was revoked")
            if request.command_id in current.commands:
                raise HTTPException(409, "command already submitted; outcome must be reconciled")
            if len(current.commands) >= 10000:
                raise HTTPException(429, "session command budget exhausted")
            current.commands.add(request.command_id)
            private_harness = request.method == "page.harness" and request.params.get("method") in ("fill", "type_text", "js", "upload")
            if recorder and (request.method == "page.insert_text" or private_harness):
                await recorder.private()
            operation = asyncio.create_task(command(session_id, request, authorization, x_tabductor_rpc_version))
            current.inflight.add(operation)
        try:
            # A disconnected caller must not let takeover race an unfinished browser effect.
            result = await asyncio.shield(operation)
            if current.observations:
                result["events"] = current.observations.read(request.event_cursor)
                result["event_cursor"] = len(current.observations.events) - 1
            return result
        except Exception as error:
            page = current.pages.get(request.page_id or "")
            browser = getattr(current.context, "browser", None)
            raise command_error(error,
                page_closed=bool(page and getattr(page, "is_closed", lambda: False)()),
                browser_connected=bool(browser and browser.is_connected() and not current.context_closed),
            ) from None
        finally:
            try:
                if not operation.done():
                    await operation
            finally:
                current.inflight.discard(operation)


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
        from browser_harness.camoufox import VERSION as harness_version
        return {"value": f"camoufox:{os.environ.get('CAMOUFOX_BROWSER', 'unknown')}/rpc:{RPC_VERSION}/harness:{harness_version}"}
    if request.method == "browser.events":
        return {"value": None}
    if request.method == "network.part":
        return {"value": await current.observations.part(str(params["request_id"]), str(params["part"]))}
    if request.method == "tab.acquire":
        key = params.get("tab_key")
        if not isinstance(key, str) or not key.strip() or len(key) > 160:
            raise HTTPException(400, "invalid tab key")
        page_id = current.tab_slots.get(key)
        page = current.pages.get(page_id)
        if page is None or page.is_closed():
            # Use the browser's initial blank tab before opening another physical tab.
            assigned = set(current.tab_slots.values())
            page = next((candidate for candidate in current.context.pages
                         if not candidate.is_closed() and candidate.url == "about:blank"
                         and current.add_page(candidate) not in assigned), None)
            if page is None:
                if len(current.context.pages) >= 16:
                    raise HTTPException(429, "session tab budget exhausted")
                page = await current.context.new_page()
            page_id = current.add_page(page)
            current.tab_slots[key] = page_id
        if current.observations:
            current.observations.dialog_seen.discard(page_id)
        # A session records the browser screen, so each node's leased tab must be visible.
        await page.bring_to_front()
        current.selected_page = page_id
        return {"value": {"page_id": page_id, "url": page.url}}
    if request.method == "page.create":
        if len(current.context.pages) >= 16:
            raise HTTPException(429, "session tab budget exhausted")
        page = await current.context.new_page()
        page_id = current.add_page(page)
        await page.bring_to_front()
        current.selected_page = page_id
        return {"value": {"page_id": page_id}}

    page = require_page(current, request.page_id)
    if request.method == "page.goto":
        await page.goto(public_url(str(params["url"])), wait_until=params.get("wait_until"), timeout=params.get("timeout"))
        return {"value": None}
    if request.method == "page.click":
        async with snapshot_target(locator_for(current, page, str(params["selector"])), str(params["selector"])) as target:
            await target.click(timeout=5000)
        return {"value": None}
    if request.method == "page.type":
        async with snapshot_target(locator_for(current, page, str(params["selector"])), str(params["selector"])) as target:
            await target.fill(str(params["text"]), timeout=5000)
        return {"value": None}
    if request.method == "page.insert_text":
        locator = await secret_target(current, page, str(params["selector"]))
        if locator is None:
            raise HTTPException(409, "target is absent or ambiguous")
        async with snapshot_target(locator, str(params["selector"])) as target:
            await target.type(str(params["text"]))
        return {"value": None}
    if request.method == "page.wait_for":
        await locator_for(current, page, str(params["selector"])).first.wait_for(state=params.get("state"), timeout=params.get("timeout"))
        return {"value": None}
    if request.method == "page.wait_for_load_state":
        await page.wait_for_load_state(params["state"], timeout=params.get("timeout"))
        return {"value": None}
    if request.method == "page.title":
        return {"value": await page.title()}
    if request.method == "page.harness":
        from browser_harness.camoufox import TargetNotReadyError, execute
        if params["method"] == "paste":
            # X clipboard and key dispatch stay inside the worker input lock.
            text = params.get("args", {}).get("text", getattr(page, "_harness_clipboard", ""))
            await page.bring_to_front()
            await paste_text(text)
            return {"value": {"url": page.url}}
        if params["method"] == "new_tab":
            if len(current.context.pages) >= 16:
                raise HTTPException(429, "session tab budget exhausted")
            async with page.expect_popup() as pending:
                await page.evaluate("() => window.open('about:blank', '_blank')")
            created = await pending.value
            return {"value": {"id": current.add_page(created), "url": created.url}}
        try:
            return {"value": await execute(page, str(params["method"]), params.get("args", {}))}
        except TargetNotReadyError:
            raise HTTPException(409, {"code": "browser_target_not_ready",
                "message": "No click was dispatched: the target was missing, ambiguous, or not actionable. Inspect the page and choose a current target.",
                "outcomeUncertain": False}) from None
    if request.method == "page.url":
        return {"value": page.url}
    if request.method == "page.screenshot":
        target = locator_for(current, page, params["selector"]) if params.get("selector") else page
        if params.get("selector"):
            bounds = await target.bounding_box()
            if not bounds or bounds["width"] * bounds["height"] > 4194304:
                raise HTTPException(413, "element crop is absent or too large; choose a smaller visible element")
        return {"value": base64.b64encode(await target.screenshot(type="png")).decode("ascii")}
    if request.method == "page.scroll":
        await page.keyboard.press("PageDown" if params.get("direction") == "down" else "PageUp")
        return {"value": None}
    if request.method == "page.close":
        await page.close()
        current.pages.pop(request.page_id or "", None)
        return {"value": None}
    if request.method == "page.upload":
        async with snapshot_target(locator_for(current, page, str(params["selector"])), str(params["selector"])) as target:
            await target.set_input_files({
                "name": str(params["name"]),
                "mimeType": str(params["mime_type"]),
                "buffer": base64.b64decode(str(params["bytes"])),
            })
        return {"value": None}
    if request.method == "page.interact":
        kind = params["kind"]
        target = locator_for(current, page, params["selector"]) if params.get("selector") else None
        async with snapshot_target(target, params.get("selector", "")) as target:
            if kind == "press":
                await (target.press(params["key"]) if target else page.keyboard.press(params["key"]))
            elif kind == "select":
                await target.select_option(params["values"])
            elif kind == "hover":
                await target.hover()
            elif kind == "drag":
                async with snapshot_target(locator_for(current, page, params["target"]), params["target"]) as destination:
                    await target.hover()
                    await page.mouse.down()
                    try:
                        await destination.hover()
                    finally:
                        await page.mouse.up()
            elif kind == "dialog":
                current.dialog_policies[request.page_id] = params
            elif kind == "scroll":
                if target:
                    await target.evaluate("""(el, direction) => el.scrollBy(
                      direction === 'left' ? -el.clientWidth : direction === 'right' ? el.clientWidth : 0,
                      direction === 'up' ? -el.clientHeight : direction === 'down' ? el.clientHeight : 0)""", params["direction"])
                else:
                    await page.keyboard.press({"up":"PageUp", "down":"PageDown", "left":"ArrowLeft", "right":"ArrowRight"}[params["direction"]])
            else:
                raise HTTPException(400, "unknown interaction")
        return {"value": None}
    if request.method == "page.download":
        async with page.expect_download(timeout=15000) as pending:
            async with snapshot_target(locator_for(current, page, params["selector"]), params["selector"]) as target:
                await target.click(timeout=5000)
        download = await pending.value
        try:
            path = Path(await download.path())
            if path.stat().st_size > 1000000:
                raise HTTPException(413, "download exceeds 1 MB")
            return {"value": {"name": download.suggested_filename, "mime": "application/octet-stream",
                              "bytes": base64.b64encode(path.read_bytes()).decode("ascii")}}
        finally:
            await download.delete()
    if request.method in ("page.tabs", "page.switch_tab"):
        # Follow actual opener ownership; never expose another leased root tab.
        root = page
        assigned = set(current.tab_slots.values())
        while current.add_page(root) not in assigned and (getattr(root, "_tabductor_root", None) or await root.opener()):
            root = getattr(root, "_tabductor_root", None) or await root.opener()
        owned = []
        for candidate in current.context.pages:
            ancestor = candidate
            while ancestor and ancestor is not root:
                if current.add_page(ancestor) in assigned:
                    ancestor = None
                    break
                ancestor = getattr(ancestor, "_tabductor_root", None) or await ancestor.opener()
            if ancestor is root:
                owned.append(candidate)
        if request.method == "page.tabs":
            return {"value": [{"id": current.add_page(p), "url": p.url, "title": await p.title()} for p in owned]}
        selected = next((p for p in owned if current.add_page(p) == params["id"]), None)
        if selected is None:
            raise HTTPException(403, "tab is not owned by this run")
        await selected.bring_to_front()
        return {"value": {"page_id": current.add_page(selected), "url": selected.url}}
    if request.method == "page.query_all":
        return {"value": await extract(locator_for(current, page, str(params["selector"])), params.get("fields", {}), params)}
    if request.method == "page.probe":
        locator = await secret_target(current, page, str(params["selector"]))
        if locator is None:
            return {"value": None}
        return {"value": await locator.evaluate_all("""
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
        value = await perceive(current, page, params)
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


@app.post("/v1/sessions/{session_id}/automation")
async def automation(session_id: str, request: CommandRequest, authorization: str | None = Header(default=None), x_tabductor_rpc_version: str | None = Header(default=None)):
    """Invocation-scoped object RPC. Poll/reply never wait under the page lock."""
    from browser_harness.playwright_worker import Scope
    authorize(authorization, x_tabductor_rpc_version)
    current = require_session(request.generation)
    if current.session_id != session_id:
        raise HTTPException(404, "session not found")
    args = request.params
    invocation = args.get("invocation")
    if not isinstance(invocation, str) or len(invocation) > 100:
        raise HTTPException(400, "invalid invocation")
    scopes = getattr(current, "proxy_scopes", None)
    if scopes is None:
        scopes = current.proxy_scopes = {}
    if request.method == "close":
        scope = scopes.pop(invocation, None)
        if scope:
            await scope.close()
        return {"value": None}
    if current.input_owner != "ai" or current.input_generation != request.input_generation:
        raise HTTPException(409, {
            "code": "browser_input_revoked",
            "message": "Browser control changed; wait for acknowledgement and inspect the page before repeating effects.",
            # A denied submission did not execute. A denied poll cannot establish
            # whether the already-submitted operation took effect.
            "outcomeUncertain": request.method in {"poll", "callback"},
        })
    root = require_page(current, request.page_id)
    if request.method == "open":
        async with command_lock:
            if session is not current or current.input_owner != "ai" or current.input_generation != request.input_generation:
                raise HTTPException(409, "input ownership was revoked")
            if invocation in scopes or len(scopes) >= 32:
                raise HTTPException(409, "invocation already open or capacity exhausted")
            # One cell owns this root at a time. Reclaim abandoned scopes before a
            # replacement run can act on the same leased page.
            for old_id, old_scope in list(scopes.items()):
                if old_scope.root is root:
                    await old_scope.close()
                    scopes.pop(old_id, None)
            async def owns(page):
                candidate = page
                while candidate:
                    if candidate is root:
                        return True
                    if current.add_page(candidate) in current.tab_slots.values():
                        return False
                    candidate = getattr(candidate, "_tabductor_root", None) or await candidate.opener()
                return False
            def track(task):
                current.inflight.add(task)
                task.add_done_callback(current.inflight.discard)
            scope = Scope(current.context, root, invocation, owns, track)
            scopes[invocation] = scope
            return {"value": {"page": scope.initial_page, "context": scope.initial_context}}
    scope = scopes.get(invocation)
    if scope is None or scope.root is not root:
        raise HTTPException(409, {
            "code": "browser_invocation_expired",
            "message": "Browser invocation expired; start a fresh Python cell and inspect the page before repeating effects.",
            "outcomeUncertain": request.method in {"poll", "callback"},
        })
    try:
        if request.method == "start":
            async with command_lock:
                if session is not current or current.input_owner != "ai" or current.input_generation != request.input_generation or scope.closed:
                    raise HTTPException(409, "input ownership was revoked")
                if request.command_id in current.commands:
                    raise HTTPException(409, "command already submitted")
                if len(current.commands) >= 10000:
                    raise HTTPException(429, "session command budget exhausted")
                current.commands.add(request.command_id)
                # The trusted host classifies secret/password input before dispatch.
                # Routine evaluation and public form input must not end the replay.
                # Older hosts without classification keep the conservative behavior.
                private = args.get("recording_private", args.get("member") in (
                    "evaluate", "evaluate_handle", "fill", "type", "press_sequentially", "insert_text", "set_input_files"))
                if recorder and private:
                    await recorder.private()
                target = args["target"]
                scope.ref(target)
                page = scope.origins[target["id"]]
                if not await scope.owns(page):
                    raise HTTPException(403, "target belongs to another browser node")
                if not page.is_closed():
                    await page.bring_to_front()
                    current.selected_page = current.add_page(page)
                return {"value": {"ticket": scope.start(args, request.command_id)}}
        if request.method == "expect":
            target = scope.ref(args["target"])
            from playwright.async_api import Expect
            assertions = Expect()
            if args.get("timeout") is not None:
                assertions.set_options(timeout=args["timeout"])
            return {"value": scope.encode(assertions(target, args.get("message"))) }
        if request.method == "inspect":
            target_ref = args.get("target") or args["call"]["target"]
            target = scope.ref(target_ref)
            page = scope.origins[target_ref["id"]]
            call = args.get("call") or {}
            if type(target).__name__ in ("Page", "Frame"):
                selector = call["args"][0] if call.get("args") else call.get("kwargs", {}).get("selector")
                if selector is not None:
                    target = target.locator(selector)
            if type(target).__name__ == "Locator":
                if await target.count() != 1:
                    return {"value": None}
                value = await target.evaluate("el => ({type:el.type,tag:el.tagName.toLowerCase(),origin:el.ownerDocument.location.origin})")
                value["selector"] = target._impl_obj._selector
                if args.get("pin"):
                    pin = str(args["pin"])
                    if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", pin):
                        raise ValueError("Invalid secret target pin")
                    await target.evaluate("(el, pin) => el.setAttribute('data-tabductor-secret-target', pin)", pin)
                    value["selector"] = f'[data-tabductor-secret-target="{pin}"]'
            else:
                value = await page.evaluate("() => ({type:document.activeElement?.type,tag:document.activeElement?.tagName.toLowerCase(),origin:location.origin})")
                if value.get("tag") in ("iframe", "frame"):
                    return {"value": None}
            return {"value": {**value, "pageId": current.add_page(page), "pageOrigin": urlparse(page.url).scheme + "://" + urlparse(page.url).netloc}}
        if request.method == "poll":
            return {"value": await scope.poll(args["ticket"])}
        if request.method == "callback":
            scope.reply(args["ticket"], args["result"])
            return {"value": None}
        raise ValueError("Unknown automation command")
    except (ValueError, TypeError, AttributeError) as error:
        raise HTTPException(422, {"code": "browser_invalid_argument", "message": str(error)[:500], "outcomeUncertain": False}) from None


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
