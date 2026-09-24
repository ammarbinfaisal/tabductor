"""Stable, value-free errors: never send browser call logs or typed secrets to clients."""
from fastapi import HTTPException
from playwright.async_api import Error, TimeoutError


def command_error(error, *, page_closed=False, browser_connected=False):
    message = str(error).lower()
    code, status, detail, uncertain = "browser_command_failed", 500, "Browser command failed; inspect the current page.", True
    if isinstance(error, HTTPException):
        if isinstance(error.detail, dict):
            return error
        message = str(error.detail).lower()
        status = error.status_code
        if "ownership" in message or "input owner" in message:
            code, detail, uncertain = "browser_input_revoked", "Browser control changed; wait for acknowledgement and perceive again.", False
        elif "invocation" in message:
            code, detail, uncertain = "browser_invocation_conflict", "Browser invocation is already open or capacity is exhausted; finish the active cell before opening another.", False
        elif "already submitted" in message:
            code, detail = "browser_outcome_uncertain", "Command already submitted; reconcile its effect before retrying."
        elif "session" in message and status in (404, 409):
            code, detail = "browser.disconnected", "Browser session is no longer available."
        elif "page" in message or "target" in message or "frame" in message:
            code, detail, uncertain = "browser_stale_target", "Target is absent or stale; perceive again.", False
        else:
            code, detail, uncertain = "browser_command_rejected", "Browser rejected the command; check its arguments and limits.", False
    elif "snapshot" in message or "not attached" in message or "detached" in message or "strict mode violation" in message:
        code, status, detail, uncertain = "browser_stale_target", 409, "Target changed or is ambiguous; perceive again.", False
    elif "intercepts pointer" in message or "obscur" in message:
        code, status, detail, uncertain = "browser_target_obstructed", 422, "Target is obstructed; inspect overlays or another visible target.", False
    elif isinstance(error, TimeoutError):
        code, status, detail = "browser_timeout", 408, "Browser command timed out; inspect the page and reconcile any effect before retrying."
    elif isinstance(error, Error) and any(part in message for part in ("has been closed", "disconnected", "connection closed", "browser closed")):
        if page_closed and browser_connected:
            code, status, detail = "browser_page_closed", 409, "The selected page closed. Use tabs.list and tabs.switch to inspect the surviving destination tab and verify the outcome before repeating actions."
        else:
            code, status, detail = "browser.disconnected", 503, "Browser connection ended; reconcile any effect before retrying."
    elif isinstance(error, (ValueError, TypeError)):
        code, status, detail, uncertain = "browser_invalid_argument", 422, "Invalid browser arguments; inspect the target and tool schema.", False
    return HTTPException(status, {"code": code, "message": detail, "outcomeUncertain": uncertain})
