from __future__ import annotations

import base64
import ipaddress
import os
import re
import socket
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from camoufox.async_api import AsyncCamoufox
from fastapi import FastAPI, Header, HTTPException
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


class CommandRequest(BaseModel):
    generation: int = Field(ge=1)
    method: str = Field(min_length=1, max_length=80)
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

    def add_page(self, page: Any) -> str:
        page_id = f"p{self.next_page}"
        self.next_page += 1
        self.pages[page_id] = page
        return page_id


session: Session | None = None
app = FastAPI(title="Tabductor Camoufox worker", version=RPC_VERSION)


def authorize(authorization: str | None, rpc_version: str | None) -> None:
    if rpc_version != RPC_VERSION:
        raise HTTPException(426, f"RPC version {RPC_VERSION} required")
    if not TOKEN or authorization != f"Bearer {TOKEN}":
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


@app.post("/v1/sessions")
async def start_session(
    request: StartRequest,
    authorization: str | None = Header(default=None),
    x_tabductor_rpc_version: str | None = Header(default=None),
) -> dict[str, Any]:
    global session
    authorize(authorization, x_tabductor_rpc_version)
    if not ID.fullmatch(request.session_id):
        raise HTTPException(400, "invalid session id")
    if session is not None:
        if session.session_id == request.session_id and session.generation == request.generation:
            return {"session_id": session.session_id, "generation": session.generation, "idempotent": True}
        raise HTTPException(409, "worker is already allocated")
    profile = safe_profile(request.profile_dir)
    profile.mkdir(parents=True, exist_ok=True)
    options: dict[str, Any] = {
        "headless": "virtual",
        "persistent_context": True,
        "user_data_dir": str(profile),
        "humanize": True,
    }
    if request.locale:
        options["locale"] = request.locale
    if request.proxy:
        options["proxy"] = request.proxy
    manager = AsyncCamoufox(**options)
    context = await manager.__aenter__()
    session = Session(request.session_id, request.generation, manager, context)
    for page in context.pages:
        session.add_page(page)
    return {"session_id": request.session_id, "generation": request.generation, "idempotent": False}


@app.delete("/v1/sessions/{session_id}")
async def stop_session(
    session_id: str,
    generation: int,
    authorization: str | None = Header(default=None),
    x_tabductor_rpc_version: str | None = Header(default=None),
) -> dict[str, bool]:
    global session
    authorize(authorization, x_tabductor_rpc_version)
    current = require_session(generation)
    if current.session_id != session_id:
        raise HTTPException(404, "session not found")
    try:
        await current.context.close()
    finally:
        await current.manager.__aexit__(None, None, None)
        session = None
    return {"closed": True}


@app.post("/v1/sessions/{session_id}/commands")
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
    if request.method == "page.perceive":
        value = await page.evaluate("""
          (maxChars) => {
            const candidates = [...document.querySelectorAll('a,button,input,textarea,select,[role],[data-testid]')].slice(0, 300);
            const elements = candidates.map((el, i) => {
              const testid = el.getAttribute('data-testid'); const role = el.getAttribute('role');
              const name = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || null;
              const text = (el.textContent || '').trim().slice(0, 300) || null;
              const locator = testid ? `[data-testid="${CSS.escape(testid)}"]` : `:nth-match(${el.tagName.toLowerCase()}, ${i + 1})`;
              return {anchor:`e${i + 1}`, tag:el.tagName.toLowerCase(), role, name, text,
                strategy:testid?'testid':role?'role':text?'text':'css-path', locator};
            });
            return {url:location.href, title:document.title, elements, text:(document.body?.innerText || '').slice(0, maxChars)};
          }
        """, int(params.get("max_chars", 8000)))
        return {"value": value}
    raise HTTPException(400, f"unsupported method {request.method}")
