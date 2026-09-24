"""Offline real-Camoufox regression. Run separately from fake-browser protocol tests.
docker run --rm --network none -v "$PWD/apps/browser-worker:/worker:ro" \
  -e TABDUCTOR_PERCEPTION_SCRIPT=/shared/perception-script.js \
  -v "$PWD/packages/browser/src/perception-script.js:/shared/perception-script.js:ro" \
  --entrypoint python tabductor-browser-worker:local tests/test_browser_contract.py
"""
import sys
import asyncio
import unittest
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from camoufox.async_api import AsyncCamoufox
from src import main as worker


class BrowserContract(unittest.IsolatedAsyncioTestCase):
    async def test_closed_oauth_popup_recovers_to_its_root_in_a_persistent_browser(self):
        with tempfile.TemporaryDirectory() as profile:
            async with AsyncCamoufox(headless=True, persistent_context=True, user_data_dir=profile) as context:
                worker.TOKEN = "popup-test"
                worker.recorder = None
                worker.command_lock = asyncio.Lock()
                worker.session = worker.Session("popup-test", 1, None, context)
                current = worker.session
                context.on("close", lambda *_: setattr(current, "context_closed", True))
                ordinal = 0

                async def call(method, page_id=None, params=None):
                    nonlocal ordinal
                    ordinal += 1
                    result = await worker.command_locked("popup-test", worker.CommandRequest(generation=1,
                        input_generation=1, command_id=str(ordinal), method=method, page_id=page_id,
                        params=params or {}), "Bearer popup-test", "1")
                    return result["value"]

                root = (await call("tab.acquire", params={"tab_key":"destination"}))["page_id"]
                unrelated = (await call("tab.acquire", params={"tab_key":"other-task"}))["page_id"]
                page = current.pages[root]
                await page.set_content("<title>Destination</title><button onclick=\"window.open('about:blank')\">Sign in</button>")
                async with page.expect_popup() as opened:
                    await page.locator("button").click()
                popup = await opened.value
                popup_id = current.add_page(popup)
                await call("page.switch_tab", root, {"id":popup_id})
                await page.set_content("<title>Signed in</title><main>Database ready</main>")
                await popup.close()
                with self.assertRaises(worker.HTTPException) as closed:
                    await call("page.perceive", popup_id)
                self.assertEqual(closed.exception.detail["code"], "browser_page_closed")
                tabs = await call("page.tabs", root)
                self.assertEqual([tab["id"] for tab in tabs], [root])
                self.assertEqual(tabs[0]["title"], "Signed in")
                with self.assertRaises(worker.HTTPException):
                    await call("page.switch_tab", root, {"id":unrelated})
                await call("page.switch_tab", root, {"id":root})
                self.assertIn("Database ready", (await call("page.perceive", root))["text"])
                await context.close()
                with self.assertRaises(worker.HTTPException) as disconnected:
                    await call("page.perceive", root)
                self.assertEqual(disconnected.exception.detail["code"], "browser.disconnected")

    async def test_repeated_anchors_and_bounded_collection_use_playwright_fields(self):
        async with AsyncCamoufox(headless=True) as browser:
            page = await browser.new_page()
            await page.set_content("<main>" + "".join(
                f'<article data-testid="item"><span class="author">author-{i}</span>'
                f'<a href="https://fixture.test/item/{i}">item-{i}</a></article>' for i in range(100)
            ) + "</main>")
            worker.TOKEN = "test"
            worker.recorder = None
            worker.session = worker.Session("test", 1, None, None)
            worker.session.pages["p1"] = page
            async def call(method, params=None):
                result = await worker.command("test", worker.CommandRequest(generation=1, input_generation=1, method=method,
                    command_id=method, page_id="p1", params=params or {}), "Bearer test", "1")
                return result["value"]
            perception = await call("page.perceive")
            items = [element for element in perception["elements"] if element["tag"] == "article"]
            self.assertGreater(len(items), 1)
            self.assertNotEqual(items[0]["locator"], items[1]["locator"])
            fields = {"author": {"selector": ".author"},
                      "url": {"selector": 'a:has-text("item-") >> nth=0', "attr": "href"},
                      "optional": {"selector": ".missing"}}
            for i in range(2):
                row = await call("page.query_all", {"selector": items[i]["locator"], "fields": fields})
                self.assertEqual(row, [{"author": f"author-{i}", "url": f"https://fixture.test/item/{i}", "optional": None}])
            records = []
            for offset in range(0, 100, 25):
                batch = await call("page.query_all", {"selector": "article", "fields": fields, "offset": offset, "limit": 25})
                self.assertEqual(len(batch), 25)
                records.extend(batch)
            self.assertEqual(len({record["url"] for record in records}), 100)
            self.assertEqual([record["author"] for record in records], [f"author-{i}" for i in range(100)])
            with self.assertRaises(worker.HTTPException) as caught:
                await call("page.query_all", {"selector": "article", "fields": {"bad_field": {"selector": "a:nth("}}})
            self.assertEqual(caught.exception.status_code, 422)
            self.assertIn("bad_field", caught.exception.detail)
            with self.assertRaises(Exception):
                await call("page.query_all", {"selector": "article", "fields": fields, "maxFieldChars": 2})

    async def test_delayed_property_editor_semantics_and_structural_pagination(self):
        async with AsyncCamoufox(headless=True) as browser:
            page = await browser.new_page()
            await page.set_content((Path(__file__).parent / "fixtures/property-editor.html").read_text())
            worker.TOKEN = "contract"
            worker.recorder = None
            worker.session = worker.Session("contract", 1, None, page.context)
            worker.session.pages["p1"] = page
            async def call(method, params=None):
                result = await worker.command("contract", worker.CommandRequest(generation=1, input_generation=1,
                    method=method, command_id=method, page_id="p1", params=params or {}), "Bearer contract", "1")
                return result["value"]
            await call("page.click", {"selector": "#add"})
            await page.locator('input[placeholder="Type property name…"]').wait_for()
            p = await call("page.perceive", {"elementLimit": 10})
            self.assertEqual(p["activeScope"], "dialog")
            self.assertEqual(p["elements"][0]["controlLabel"], "Property name")
            self.assertTrue(p["elements"][0]["focused"])
            dialog = next(e for e in p["elements"] if e["role"] == "dialog")
            scoped = await call("page.perceive", {"selector": dialog["actionLocator"], "inspect": True, "elementLimit": 10})
            self.assertLess(scoped["coverage"]["totalElements"], 15)
            self.assertEqual(scoped["elements"][0]["role"], "textbox")
            structural = await call("page.perceive", {"selector": dialog["actionLocator"], "inspect": True,
                "structuralDetail": True, "elementLimit": 10})
            self.assertGreater(structural["coverage"]["totalElements"], 350)
            self.assertEqual(structural["coverage"]["nextElementOffset"], 10)
            self.assertEqual(structural["uiFingerprint"], scoped["uiFingerprint"])
            await call("page.interact", {"kind": "press", "selector": p["elements"][0]["actionLocator"], "key": "Escape"})
            closed = await call("page.perceive")
            self.assertEqual(closed["activeScope"], "page")
            self.assertNotEqual(closed["uiFingerprint"], p["uiFingerprint"])

    async def test_shared_perception_state_pagination_frames_and_node_identity(self):
        async with AsyncCamoufox(headless=True) as browser:
            page = await browser.new_page()
            await page.set_content((Path(__file__).parent / "fixtures/perception.html").read_text())
            worker.TOKEN = "contract"
            worker.recorder = None
            worker.session = worker.Session("contract", 1, None, page.context)
            worker.session.pages["p1"] = page
            async def call(method, params=None):
                result = await worker.command("contract", worker.CommandRequest(generation=1, input_generation=1,
                    method=method, command_id=method, page_id="p1", params=params or {}), "Bearer contract", "1")
                return result["value"]
            p = await call("page.perceive", {"elementLimit": 100})
            self.assertTrue(all(e["frameId"] == "main" for e in p["elements"]))
            explicit_main = await call("page.perceive", {"frameId": "main", "elementLimit": 100})
            self.assertEqual(explicit_main["elements"], p["elements"])
            self.assertEqual(explicit_main["frames"], p["frames"])
            self.assertNotIn("main", [f["id"] for f in p["frames"]])
            entry = next(e for e in p["elements"] if e["name"] == "Account name")
            self.assertEqual(entry["role"], "textbox")
            self.assertEqual(entry["value"], "before")
            self.assertTrue(next(e for e in p["elements"] if e["name"] == "Enabled")["checked"])
            self.assertTrue(next(e for e in p["elements"] if e["name"] == "Unavailable")["disabled"])
            option = next(e for e in p["elements"] if e["tag"] == "option" and e["text"] == "Beta")
            self.assertEqual(option["value"], "b")
            self.assertEqual(option["role"], "option")
            self.assertFalse(option["selected"])
            self.assertTrue(any(e["name"] == "Shadow control" for e in p["elements"]))
            self.assertFalse(any(e["text"] == "Hidden ancestor" for e in p["elements"]))
            self.assertNotIn("never-observe-this", str(p))
            late = await call("page.perceive", {"query": "Control 449", "frameId": "main"})
            self.assertTrue(any(e["text"] == "Control 449" for e in late["elements"]))
            self.assertGreater(p["coverage"]["totalElements"], 450)
            tail = await call("page.perceive", {"textOffset": 30000, "maxChars": 20000})
            self.assertIn("Tail sentinel", tail["text"])
            article = next(e for e in p["elements"] if e["tag"] == "article")
            scoped = await call("page.perceive", {"selector": article["actionLocator"], "inspect": True, "frameId": article["frameId"]})
            self.assertTrue(any(e["selectorHint"] == "span.author" for e in scoped["elements"]))
            self.assertTrue(all(e["frameId"] == "main" and not e["actionLocator"].startswith("@frame:") for e in scoped["elements"]))
            with self.assertRaisesRegex(ValueError, "frame unavailable"):
                await call("page.perceive", {"frameId": "missing-frame"})
            frame = await call("page.perceive", {"frameId": p["frames"][0]["id"]})
            inside = next(e for e in frame["elements"] if e["name"] == "Frame name")
            await call("page.type", {"selector": inside["actionLocator"], "text": "frame value"})
            save = next(e for e in p["elements"] if e["text"] == "Save")
            await page.locator("#insert").click()
            await call("page.perceive")
            await call("page.click", {"selector": save["actionLocator"]})
            self.assertEqual(await page.locator("#status").inner_text(), "Saved successfully")
            await call("page.interact", {"kind":"select", "selector":"#choice", "values":["b"]})
            self.assertEqual(await page.locator("#choice").input_value(), "b")
            await call("page.interact", {"kind": "press", "selector": entry["actionLocator"], "key": "Enter"})
            self.assertEqual(await page.locator("#status").inner_text(), "Pressed")
            hover = next(e for e in p["elements"] if e["name"] == "Hover target")
            await call("page.interact", {"kind": "hover", "selector": hover["actionLocator"]})
            self.assertEqual(await page.locator("#status").inner_text(), "Hovered")
            source = next(e for e in p["elements"] if e["name"] == "Drag source")
            destination = next(e for e in p["elements"] if e["name"] == "Drop target")
            await call("page.interact", {"kind": "drag", "selector": source["actionLocator"], "target": destination["actionLocator"]})
            self.assertEqual(await page.locator("#status").inner_text(), "Dropped")
            scroll = next(e for e in p["elements"] if e["name"] == "Scroll region")
            await call("page.interact", {"kind": "scroll", "selector": scroll["actionLocator"], "direction": "down"})
            self.assertGreater(await page.locator("#scroll-box").evaluate("el => el.scrollTop"), 0)
            image = await call("page.screenshot", {"selector": "#save"})
            self.assertGreater(len(image), 100)
            current = await call("page.perceive", {"query": "Save"})
            old = next(e for e in current["elements"] if e["text"] == "Save")
            await page.locator("#clone").click()
            with self.assertRaisesRegex(ValueError, "replaced"):
                await call("page.click", {"selector": old["actionLocator"]})

    async def test_two_reusable_tabs_keep_independent_state_across_packet_runs(self):
        async with AsyncCamoufox(headless=True) as browser:
            context = await browser.new_context()
            await context.new_page()
            worker.TOKEN = "tabs"
            worker.recorder = None
            worker.command_lock = asyncio.Lock()
            worker.session = worker.Session("tabs", 1, None, context)
            ordinal = 0
            async def call(method, page_id=None, params=None):
                nonlocal ordinal
                ordinal += 1
                result = await worker.command_locked("tabs", worker.CommandRequest(generation=1, input_generation=1,
                    command_id=str(ordinal), method=method, page_id=page_id, params=params or {}), "Bearer tabs", "1")
                return result["value"]
            x = (await call("tab.acquire", params={"tab_key": "x"}))["page_id"]
            notion = (await call("tab.acquire", params={"tab_key": "notion"}))["page_id"]
            await worker.session.pages[x].set_content("<title>X fixture</title><main>Timeline</main>")
            await worker.session.pages[notion].set_content("<title>Notion fixture</title><input id='entry'>")
            waiting = asyncio.create_task(call("page.wait_for", x, {"selector": "#next", "timeout": 3000}))
            await asyncio.sleep(0.05)
            try:
                await asyncio.wait_for(call("page.type", notion, {"selector": "#entry", "text": "Saved packet"}), 1)
                self.assertFalse(waiting.done())
            finally:
                await worker.session.pages[x].set_content("<title>X fixture</title><div id='next'>Next tweet</div>")
                await waiting
            for _ in range(5):
                self.assertEqual((await call("tab.acquire", params={"tab_key": "notion"}))["page_id"], notion)
            self.assertEqual(await worker.session.pages[notion].locator("#entry").input_value(), "Saved packet")
            self.assertEqual(len(context.pages), 2)
            own = await call("page.tabs", x)
            self.assertEqual([tab["id"] for tab in own], [x])
            with self.assertRaises(worker.HTTPException) as denied:
                await call("page.switch_tab", x, {"id": notion})
            self.assertEqual(denied.exception.status_code, 403)
            tabs = await worker.list_tabs("tabs", 1, "Bearer tabs", "1")
            self.assertEqual({tab["title"] for tab in tabs["tabs"]}, {"X fixture", "Notion fixture"})
            await worker.select_tab("tabs", worker.SelectTabRequest(generation=1, page_id=x), "Bearer tabs", "1")
            self.assertEqual(worker.session.selected_page, x)


if __name__ == "__main__":
    unittest.main()
