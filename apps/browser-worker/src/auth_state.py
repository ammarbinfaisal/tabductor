"""Import explicitly selected origins before recording or untrusted page scripts run."""
import json
from urllib.parse import urlparse


async def import_auth_state(context, states):
    for state in states:
        origin = state["origin"]
        parsed = urlparse(origin)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("invalid authentication origin")
        page = await context.new_page()
        try:
            # Establish the real storage origin without making any request to the site.
            # A persistent init script would reset subsequently refreshed login tokens.
            await page.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body="<!doctype html><title>Profile setup</title>"))
            await page.goto(origin, wait_until="domcontentloaded")
            await page.evaluate("entries => { localStorage.clear(); for (const entry of entries) localStorage.setItem(entry.name, entry.value); }", state["localStorage"])
        finally:
            await page.unroute("**/*")
            await page.close()
        # Replace the selected site's cookies, including cookies removed locally.
        for cookie in await context.cookies():
            domain = cookie["domain"].lstrip(".")
            if parsed.hostname == domain or parsed.hostname.endswith("." + domain):
                await context.clear_cookies(name=cookie["name"], domain=cookie["domain"], path=cookie["path"])
        if state["cookies"]:
            await context.add_cookies(state["cookies"])
