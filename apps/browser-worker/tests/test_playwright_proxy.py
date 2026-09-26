"""Runs in the browser-worker image with its pinned Camoufox/Playwright builds."""
import asyncio
import unittest
import datetime
import base64
import json
from camoufox.async_api import AsyncCamoufox
from browser_harness.playwright_worker import Scope
from playwright.async_api import expect


class ProxyTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.manager = AsyncCamoufox(headless=True, main_world_eval=True)
        self.browser = await self.manager.__aenter__()
        self.context = await self.browser.new_context()
        self.page = await self.context.new_page()
        await self.page.set_content('<input aria-label="Name"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>')
        async def owns(page):
            candidate = page
            while candidate:
                if candidate is self.page:
                    return True
                candidate = getattr(candidate, "_tabductor_root", None) or await candidate.opener()
            return False
        self.scope = Scope(self.context, self.page, "cell-1", owns)

    async def asyncTearDown(self):
        await self.scope.close()
        await self.manager.__aexit__(None, None, None)

    async def invoke(self, target, member, args=None, kwargs=None, callback=None):
        return await self.scope.invoke({"target": target["$ref"], "member": member, "args": args or [], "kwargs": kwargs or {}, "callback": callback})

    async def test_locator_dom_handles_assertions_and_files(self):
        root = self.scope.initial_page
        locator = await self.invoke(root, "get_by_role", ["textbox"], {"name": "Name"})
        await self.invoke(locator, "fill", ["Alice"])
        button = await self.invoke(root, "get_by_role", ["button"], {"name": "Save"})
        await self.invoke(button, "click")
        output = await self.invoke(root, "locator", ["output"])
        self.assertEqual(await self.invoke(output, "inner_text"), "Alice")
        assertions = self.scope.encode(expect(self.scope.ref(output["$ref"])))
        await self.invoke(assertions, "to_have_text", ["Alice"])
        handle = await self.invoke(root, "evaluate_handle", ["() => ({count: 7})"])
        self.assertEqual(await self.invoke(handle, "json_value"), {"count": 7})
        screenshot = await self.invoke(root, "screenshot")
        self.assertIn("$bytes", screenshot)
        await self.invoke(handle, "dispose")
        for member, args, kwargs in [("goto", ["file:///etc/passwd"], {}), ("add_script_tag", [], {"path": "/etc/passwd"}), ("set_input_files", ["input", "/etc/passwd"], {})]:
            with self.assertRaises(ValueError):
                await self.invoke(root, member, args, kwargs)
        with self.assertRaises(ValueError):
            await self.invoke(root, "browser")
        bad = {"$ref": {**root["$ref"], "scope": "another-cell"}}
        with self.assertRaises(ValueError):
            await self.invoke(bad, "title")

    async def test_callback_can_make_nested_calls_during_parent_wait(self):
        root = self.scope.initial_page
        await self.invoke(root, "expose_function", ["ask_python", {"$callback": "fn-1"}])
        ticket = self.scope.start({"target": root["$ref"], "member": "evaluate", "args": ["() => window.ask_python('question')"], "kwargs": {}}, "job-1")
        for _ in range(100):
            reply = await self.scope.poll(ticket)
            if reply["events"]:
                event = reply["events"][0]
                nested = self.scope.start({"target": root["$ref"], "member": "title", "args": [], "kwargs": {}, "callback": event["id"]}, "job-2")
                nested_reply = await self.scope.poll(nested)
                while nested_reply["pending"]:
                    nested_reply = await self.scope.poll(nested)
                self.scope.reply(event["id"], {"ok": True, "value": "answer"})
            if not reply["pending"]:
                self.assertEqual(reply["result"], {"ok": True, "value": "answer"})
                break
        else:
            self.fail("Callback deadlocked")

    async def test_owned_popups_and_foreign_page_filtering(self):
        foreign = await self.context.new_page()
        popup = await self.invoke(self.scope.initial_context, "new_page")
        self.assertIsNone(await self.scope.ref(popup["$ref"]).opener())
        pages = await self.invoke(self.scope.initial_context, "pages")
        self.assertEqual(len(pages), 2)
        self.assertNotIn(foreign, [self.scope.ref(p["$ref"]) for p in pages])
        await self.invoke(popup, "set_content", ["<h1>Popup</h1>"])
        self.assertEqual(await self.invoke(popup, "inner_text", ["h1"]), "Popup")
        await self.invoke(popup, "close")
        self.assertEqual(len(await self.invoke(self.scope.initial_context, "pages")), 1)

    async def test_context_settings_cookies_storage_and_browser_objects(self):
        context = self.scope.initial_context
        await self.invoke(context, "add_cookies", kwargs={"cookies": [{"name": "fixture", "value": "saved", "url": "https://fixture.test"}]})
        self.assertEqual((await self.invoke(context, "cookies", kwargs={"urls": "https://fixture.test"}))[0]["value"], "saved")
        state = await self.invoke(context, "storage_state")
        self.assertEqual(state["cookies"][0]["name"], "fixture")
        await self.invoke(context, "clear_cookies", kwargs={"path": "/"})
        self.assertEqual(await self.invoke(context, "cookies"), [])
        await self.invoke(context, "set_default_timeout", kwargs={"timeout": 321})
        self.assertEqual(self.page._impl_obj._timeout_settings.timeout(), 321)
        browser = await self.invoke(context, "browser")
        self.assertTrue(await self.invoke(browser, "is_connected"))
        self.assertEqual(len(await self.invoke(browser, "contexts")), 1)
        with self.assertRaises(ValueError):
            await self.invoke(browser, "new_context")
        foreign = await self.context.new_page()
        with self.assertRaisesRegex(ValueError, "another task"):
            await self.invoke(context, "set_offline", [True])
        await foreign.close()

    async def test_clock_workers_and_tracing_return_types(self):
        clock = await self.invoke(self.scope.initial_page, "clock")
        self.assertEqual(clock["$ref"]["class"], "Clock")
        await self.invoke(clock, "set_fixed_time", kwargs={"time": {"$datetime": datetime.datetime(2024, 1, 1, tzinfo=datetime.timezone.utc).isoformat()}})
        await self.page.evaluate("() => window.fixtureWorker = new Worker(URL.createObjectURL(new Blob(['self.onmessage = e => postMessage(e.data)'], {type:'text/javascript'})))")
        workers = await self.invoke(self.scope.initial_page, "workers")
        self.assertEqual(workers[0]["$ref"]["class"], "Worker")
        self.assertEqual(await self.invoke(workers[0], "evaluate", ["() => 42"]), 42)
        tracing = await self.invoke(self.scope.initial_context, "tracing")
        await self.invoke(tracing, "start", kwargs={"screenshots": True})
        await self.page.locator("input").fill("Traced")
        archive = await self.invoke(tracing, "stop", kwargs={"path": "__transfer__"})
        self.assertIn("$bytes", archive)

    async def test_context_expect_page_sees_native_new_page(self):
        context = self.scope.initial_context
        pending = await self.invoke(context, "expect_page", kwargs={"timeout": 1000})
        await self.invoke(pending, "enter")
        created = await self.invoke(context, "new_page")
        await self.invoke(pending, "exit")
        self.assertTrue(await self.invoke(pending, "is_done"))
        self.assertEqual(await self.invoke(pending, "value"), created)

    async def test_assertions_preserve_assertion_error_type(self):
        assertions = self.scope.encode(expect(self.page.locator("output")))
        ticket = self.scope.start({"target": assertions["$ref"], "member": "to_have_text", "args": ["missing"], "kwargs": {"timeout": 1}}, "assertion")
        for _ in range(100):
            result = await self.scope.poll(ticket)
            if not result["pending"]:
                break
        self.assertEqual(result["result"]["code"], "browser_assertion_failed")

    async def test_context_dialog_subscription_cleanup(self):
        await self.invoke(self.scope.initial_context, "on", kwargs={"event": "dialog", "f": {"$callback": "dialog"}})
        self.assertGreater(self.page._proxy_dialog_listeners, 0)
        await self.scope.close()
        self.assertEqual(self.page._proxy_dialog_listeners, 0)

    async def test_directory_upload_transfers_files_without_worker_path_access(self):
        await self.page.set_content('<input type="file" webkitdirectory>')
        await self.invoke(self.scope.initial_page, "set_input_files", ["input", {"$directory": {
            "name": "folder", "files": [{"path": "nested/file.txt", "data": "aGVsbG8="}]
        }}])
        self.assertEqual(await self.page.locator("input").evaluate("el => el.files[0].webkitRelativePath"), "folder/nested/file.txt")
        with self.assertRaisesRegex(ValueError, "Invalid directory"):
            self.scope.decode({"$directory": {"name": "folder", "files": [{"path": "../outside", "data": ""}]}})

    async def test_har_replay_and_cleanup(self):
        har = {"log": {"version": "1.2", "creator": {"name": "fixture", "version": "1"}, "entries": [{
            "request": {"url": "https://fixture.test/har", "method": "GET", "headers": []},
            "response": {"status": 200, "headers": [{"name": "content-type", "value": "text/html"}],
                         "content": {"mimeType": "text/html", "text": "<h1>HAR replay</h1>"}}
        }]}}
        await self.invoke(self.scope.initial_page, "route_from_har", [{"$file": {
            "name": "fixture.har", "data": base64.b64encode(json.dumps(har).encode()).decode()
        }}])
        await self.invoke(self.scope.initial_page, "goto", ["https://fixture.test/har"])
        self.assertEqual(await self.page.locator("h1").inner_text(), "HAR replay")
        await self.scope.close()
        self.assertEqual(self.page._impl_obj._routes, [])
        self.assertEqual(self.page._impl_obj._har_routers, [])

    async def test_callable_url_matcher_waits_for_python(self):
        ticket = self.scope.start({"target": self.scope.initial_page["$ref"], "member": "wait_for_url",
                                   "args": [{"$callback": "url-match"}], "kwargs": {"timeout": 1000}}, "url-wait")
        seen = []
        for _ in range(100):
            reply = await self.scope.poll(ticket)
            for event in reply["events"]:
                seen.append(event["args"][0])
                self.scope.reply(event["id"], {"ok": True, "value": event["args"][0] == "about:blank"})
            if not reply["pending"]:
                self.assertTrue(reply["result"]["ok"], reply)
                break
        else:
            self.fail("URL predicate did not complete")
        self.assertEqual(seen, ["about:blank"])

    async def test_routes_reentrant_callbacks_and_cleanup(self):
        root = self.scope.initial_page
        await self.invoke(root, "route", ["https://fixture.test/**", {"$callback": "route"}])
        ticket = self.scope.start({"target": root["$ref"], "member": "goto", "args": ["https://fixture.test/"], "kwargs": {}}, "navigate")
        for _ in range(100):
            reply = await self.scope.poll(ticket)
            for event in reply["events"]:
                route = event["args"][0]
                nested = self.scope.start({"target": route["$ref"], "member": "fulfill", "args": [], "kwargs": {"body": "<h1>Intercepted</h1>", "content_type": "text/html"}, "callback": event["id"]}, "fulfill")
                while (await self.scope.poll(nested))["pending"]:
                    pass
                self.scope.reply(event["id"], {"ok": True, "value": None})
            if not reply["pending"]:
                self.assertTrue(reply["result"]["ok"], reply)
                break
        self.assertEqual(await self.page.locator("h1").inner_text(), "Intercepted")
        await self.invoke(root, "route_web_socket", ["**/socket", {"$callback": "ws"}])
        self.assertTrue(self.page._impl_obj._web_socket_routes)
        await self.scope.close()
        self.assertFalse(self.page._impl_obj._web_socket_routes)
        self.assertFalse(self.page._impl_obj._routes)

    async def test_remote_event_predicate_and_scope_cancellation(self):
        root = self.scope.initial_page
        pending = await self.invoke(root, "expect_popup", [], {"predicate": {"$callback": "predicate"}})
        await self.invoke(pending, "enter")
        await self.page.evaluate("() => window.open('about:blank')")
        ticket = self.scope.start({"target": pending["$ref"], "member": "exit", "args": [], "kwargs": {}}, "expect")
        for _ in range(100):
            reply = await self.scope.poll(ticket)
            for event in reply["events"]:
                self.assertEqual(event["args"][0]["$ref"]["class"], "Page")
                self.scope.reply(event["id"], {"ok": True, "value": True})
            if not reply["pending"]:
                self.assertTrue(reply["result"]["ok"], reply)
                break
        self.assertEqual((await self.invoke(pending, "value"))["$ref"]["class"], "Page")
        await self.invoke(root, "expose_function", ["pending", {"$callback": "never-replied"}])
        stuck = self.scope.start({"target": root["$ref"], "member": "evaluate", "args": ["() => pending()"], "kwargs": {}}, "stuck")
        for _ in range(100):
            reply = await self.scope.poll(stuck)
            if reply["events"]:
                break
        await asyncio.wait_for(self.scope.close(), 2)
        self.assertTrue(self.scope.jobs[stuck].done())


if __name__ == "__main__":
    unittest.main()
