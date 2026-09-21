"""The observation contract is shared verbatim with the TypeScript driver."""
from pathlib import Path
import os

_asset = Path(os.environ.get("TABDUCTOR_PERCEPTION_SCRIPT", Path(__file__).with_name("perception-script.js")))
if not _asset.exists():
    _asset = next((parent / "packages/browser/src/perception-script.js" for parent in Path(__file__).resolve().parents if (parent / "packages/browser/src/perception-script.js").exists()), _asset)
PERCEPTION_SCRIPT = _asset.read_text()

async def perceive(current, page, params):
    for frame in page.frames:
        if frame is page.main_frame or frame.is_detached() or frame in current.frames.values():
            continue
        if len(current.frames) >= 1024:
            raise ValueError("session frame budget exhausted")
        current.frames[f"f{len(current.frames) + 1}"] = frame
    opts = dict(params)
    opts["maxChars"] = opts.pop("max_chars", opts.get("maxChars", 8000))
    frame_id = opts.get("frameId")
    selector = opts.get("selector")
    if selector and selector.startswith("@frame:"):
        frame_id, selector = selector[7:].split(" >> ", 1)
        opts["selector"] = selector
    # Main-frame observations advertise "main"; it is not a child-frame registry key.
    if frame_id == "main":
        frame_id = None
    frame = current.frames.get(frame_id) if frame_id else page.main_frame
    if not frame or frame.is_detached() or frame.page is not page:
        raise ValueError("frame unavailable; perceive again")
    value = await frame.evaluate(PERCEPTION_SCRIPT, opts)
    if frame_id:
        for element in value["elements"]:
            element["anchor"] = frame_id + "-" + element["anchor"]
            if element.get("parentAnchor"):
                element["parentAnchor"] = frame_id + "-" + element["parentAnchor"]
            for key in ("locator", "actionLocator"):
                element[key] = f"@frame:{frame_id} >> " + element[key]
            element["frameId"] = frame_id
            element["frameOrigin"] = await frame.evaluate("location.origin")
    if frame_id and value.get("scopeAnchor"):
        value["scopeAnchor"] = frame_id + "-" + value["scopeAnchor"]
    available = [(key, child) for key, child in current.frames.items() if not child.is_detached() and child.page is page]
    offset = int(params.get("frameOffset", 0))
    value["frameOffset"] = offset
    value["frames"] = [{"id": key, "url": child.url[:300]} for key, child in available[offset:offset+50]]
    value["nextFrameOffset"] = offset + 50 if offset + 50 < len(available) else None
    return value
