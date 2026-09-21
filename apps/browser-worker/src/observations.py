"""Bounded, ephemeral network observations; payloads leave only through authenticated RPC.
No body is fetched while collecting metadata. Human-input generations never cross this feed.
"""
import asyncio
import base64
import time
from fastapi import HTTPException

MAX_REQUESTS = 1000
MAX_BODY = 1024 * 1024

class Observations:
    def __init__(self, current):
        self.current = current
        self.events = []
        self.requests = {}
        self.ids = {}
        self.attached = set()
        self.dialog_seen = set()
        self.roots = {}
        self.pending = {}
        current.context.on("page", self.enforce_tab_limit)
        current.context.on("request", self.request)
        current.context.on("requestfinished", self.settled)
        current.context.on("requestfailed", self.failed)

    async def enforce_tab_limit(self, page):
        if len(self.current.context.pages) > 16:
            await page.close()

    def event(self, value):
        self.events.append({"sequence": len(self.events), **value})

    def attach(self, page, root_id):
        if page in self.attached:
            return
        self.attached.add(page)
        self.roots[page] = root_id
        page.on("popup", lambda popup: self.attach(popup, root_id))
        async def dialog(value):
            if self.current.input_owner == "ai" and root_id not in self.dialog_seen:
                self.dialog_seen.add(root_id)
                self.event({"kind": "dialog", "page_id": root_id, "dialog": {"type": value.type, "message": "Browser dialog dismissed"}})
            page_id = self.current.add_page(page)
            policy = self.current.dialog_policies.pop(page_id, None)
            if policy and policy.get("accept"):
                await value.accept(policy.get("promptText"))
            else:
                await value.dismiss()
        page.on("dialog", dialog)

    def request(self, request):
        if self.current.input_owner != "ai" or len(self.requests) + len(self.pending) >= MAX_REQUESTS:
            return
        self.pending[request] = asyncio.create_task(self.start(request))

    async def failed(self, request):
        await self.settled(request, True)

    async def start(self, request):
        try:
            page = request.frame.page
        except Exception:
            # Firefox can report a popup's first navigation before it exposes its Frame.
            # Resolve only an unambiguous page URL, then walk its actual opener chain.
            page = None
            if request.is_navigation_request():
                for _ in range(50):
                    try:
                        page = request.frame.page
                    except Exception:
                        pass
                    if page:
                        break
                    candidates = [p for p in self.current.context.pages if p.url == request.url]
                    if len(candidates) == 1:
                        page = candidates[0]
                        break
                    await asyncio.sleep(0.02)
        # Firefox can expose the popup Page before its opener relationship or the
        # popup event is visible. Wait for attribution rather than dropping that request.
        page_id = None
        for _ in range(50):
            ancestor = page
            try:
                while ancestor and ancestor not in self.roots:
                    ancestor = await ancestor.opener()
            except Exception:
                ancestor = None
            page_id = self.roots.get(ancestor)
            if page_id or not page:
                break
            await asyncio.sleep(0.02)
        if not page_id:
            return
        if self.current.input_owner != "ai" or len(self.requests) >= MAX_REQUESTS:
            return
        request_id = str(len(self.requests))
        self.ids[request] = request_id
        now = int(time.time() * 1000)
        record = {"method": request.method, "url": request.url, "resourceType": request.resource_type,
                  "status": None, "timings": {"startedAt": now, "endedAt": None, "durationMs": None}}
        self.requests[request_id] = {"request": request, "record": record, "page_id": page_id,
                                     "generation": self.current.input_generation, "settled": False}
        self.event({"kind": "request", "page_id": page_id, "request_id": request_id, "record": {**record, "timings": dict(record["timings"])}})

    async def settled(self, request, failed=False):
        pending = self.pending.pop(request, None)
        if pending:
            await pending
        request_id = self.ids.get(request)
        if request_id is None:
            return
        item = self.requests[request_id]
        if item["settled"] or self.current.input_owner != "ai" or item["generation"] != self.current.input_generation:
            return
        item["settled"] = True
        response = None if failed else await request.response()
        record = item["record"]
        now = int(time.time() * 1000)
        record["status"] = response.status if response else None
        record["timings"] = {"startedAt": record["timings"]["startedAt"], "endedAt": now, "durationMs": now - record["timings"]["startedAt"]}
        self.event({"kind": "settled", "page_id": item["page_id"], "request_id": request_id, "record": dict(record)})

    def read(self, after):
        # Filter generations at read time as well: queued observations must not surface
        # after a human has taken over and changed the page.
        return [event for event in self.events[after + 1:] if event["kind"] == "dialog" or
                self.requests[event["request_id"]]["generation"] == self.current.input_generation]

    async def part(self, request_id, part):
        item = self.requests.get(request_id)
        if not item or item["generation"] != self.current.input_generation:
            raise HTTPException(404, "network observation unavailable")
        request = item["request"]
        if part == "requestHeaders":
            return await request.all_headers()
        if part == "requestBody":
            body = request.post_data_buffer
            mime = request.headers.get("content-type", "application/octet-stream")
            if body is None:
                return None
        else:
            response = await request.response()
            if not response:
                raise HTTPException(409, "network response unavailable")
            if part == "responseHeaders":
                return await response.all_headers()
            if part != "responseBody":
                raise HTTPException(400, "unknown network part")
            length = response.headers.get("content-length")
            if length and length.isdecimal() and int(length) > MAX_BODY:
                raise HTTPException(413, "network body exceeds limit")
            body = await response.body()
            mime = response.headers.get("content-type", "application/octet-stream")
        if len(body) > MAX_BODY:
            raise HTTPException(413, "network body exceeds limit")
        return {"bytes": base64.b64encode(body).decode("ascii"), "mime": mime}
