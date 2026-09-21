"""Worker protocol tests use a fake browser; no Camoufox download or external call."""
import asyncio
import importlib.util
import sys
import types
import unittest
import tempfile
import json
import base64
import io
import tarfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

fake = types.ModuleType("camoufox.async_api")
fake.AsyncCamoufox = None
sys.modules.setdefault("camoufox", types.ModuleType("camoufox"))
sys.modules["camoufox.async_api"] = fake
sys.path.insert(0, str(Path(__file__).parents[1]))
import src.recording
spec = importlib.util.spec_from_file_location("src.worker_protocol", Path(__file__).parents[1] / "src/main.py")
worker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = worker
spec.loader.exec_module(worker)

class Fencing(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        worker.TOKEN = "fixture-token"
        worker.stop_control_vnc = AsyncMock()
        worker.start_control_vnc = AsyncMock()
        worker.command_lock = asyncio.Lock()
        worker.session = worker.Session("session-a", 2, None, None)
        worker.session.pages["p1"] = types.SimpleNamespace(title=AsyncMock(return_value="Fixture"))
        checkpoint = patch.object(worker, "checkpoint_cookies", AsyncMock())
        checkpoint.start()
        self.addCleanup(checkpoint.stop)

    async def command(self, command_id="one", generation=2, input_generation=1, page_id="p1"):
        return await worker.command_locked("session-a", worker.CommandRequest(generation=generation,
            input_generation=input_generation, command_id=command_id, method="page.title", page_id=page_id), "Bearer fixture-token", "1")

    async def test_duplicate_command_never_replays(self):
        self.assertEqual(await self.command(), {"value": "Fixture"})
        with self.assertRaises(worker.HTTPException) as caught:
            await self.command()
        self.assertEqual(caught.exception.status_code, 409)
        worker.session.pages["p1"].title.assert_awaited_once()

    async def test_pause_waits_for_inflight_command_before_human_input(self):
        started, finish = asyncio.Event(), asyncio.Event()
        async def title():
            started.set()
            await finish.wait()
            return "Done"
        worker.session.pages["p1"].title = title
        command = asyncio.create_task(self.command())
        await started.wait()
        control = asyncio.create_task(worker.control("session-a", worker.ControlRequest(generation=2, input_generation=2, owner="human"), "Bearer fixture-token", "1"))
        await asyncio.sleep(0)
        self.assertFalse(control.done())
        finish.set()
        await command
        await control
        with self.assertRaises(worker.HTTPException):
            await self.command("two")
        await worker.control("session-a", worker.ControlRequest(generation=2, input_generation=3, owner="ai"), "Bearer fixture-token", "1")
        with self.assertRaises(worker.HTTPException):
            await self.command("three", input_generation=1)

    async def test_stale_allocation_cannot_issue_commands(self):
        with self.assertRaises(worker.HTTPException):
            await self.command(generation=1)
        worker.session.pages["p1"].title.assert_not_awaited()

    async def test_different_tabs_execute_concurrently_but_same_tab_waits(self):
        started, finish = asyncio.Event(), asyncio.Event()
        async def title():
            started.set()
            await finish.wait()
            return "Done"
        worker.session.pages["p1"].title = title
        worker.session.pages["p2"] = types.SimpleNamespace(title=AsyncMock(return_value="Notion"))
        first = asyncio.create_task(self.command("first"))
        await started.wait()
        second = asyncio.create_task(self.command("second"))
        try:
            result = await asyncio.wait_for(self.command("other-tab", page_id="p2"), 1)
            self.assertEqual(result, {"value": "Notion"})
            self.assertFalse(second.done())
        finally:
            finish.set()
            await asyncio.gather(first, second)

    async def test_takeover_drains_both_tabs_and_rejects_queued_input(self):
        started = [asyncio.Event(), asyncio.Event()]
        finish = [asyncio.Event(), asyncio.Event()]
        async def title(index):
            started[index].set()
            await finish[index].wait()
            return "Done"
        worker.session.pages["p1"].title = lambda: title(0)
        worker.session.pages["p2"] = types.SimpleNamespace(title=lambda: title(1))
        commands = [asyncio.create_task(self.command(str(i), page_id=f"p{i+1}")) for i in range(2)]
        await asyncio.wait_for(asyncio.gather(*(event.wait() for event in started)), 1)
        takeover = asyncio.create_task(worker.control("session-a", worker.ControlRequest(generation=2,
            input_generation=2, owner="human"), "Bearer fixture-token", "1"))
        await asyncio.sleep(0)
        queued = asyncio.create_task(self.command("queued"))
        finish[0].set()
        await commands[0]
        self.assertFalse(takeover.done())
        finish[1].set()
        await commands[1]
        await takeover
        with self.assertRaises(worker.HTTPException):
            await queued

    async def test_control_reconciliation_preserves_dialog_policy_until_generation_changes(self):
        worker.session.dialog_policies["p1"] = {"accept": True}
        await worker.control("session-a", worker.ControlRequest(generation=2, input_generation=1, owner="ai"), "Bearer fixture-token", "1")
        self.assertEqual(worker.session.dialog_policies, {"p1": {"accept": True}})
        await worker.control("session-a", worker.ControlRequest(generation=2, input_generation=2, owner="paused"), "Bearer fixture-token", "1")
        self.assertEqual(worker.session.dialog_policies, {})

    async def test_action_errors_are_typed_and_do_not_expose_call_logs(self):
        from playwright.async_api import TimeoutError, Error
        cases = [
            (ValueError("stale snapshot target"), "browser_stale_target"),
            (RuntimeError("unexpected internal secret-value"), "browser_command_failed"),
            (TimeoutError("Locator.click timed out: secret-value"), "browser_timeout"),
            (TimeoutError("overlay intercepts pointer events secret-value"), "browser_target_obstructed"),
            (Error("Target page, context or browser has been closed secret-value"), "browser.disconnected"),
        ]
        for i, (error, code) in enumerate(cases):
            worker.session.pages["p1"].title = AsyncMock(side_effect=error)
            with self.assertRaises(worker.HTTPException) as caught:
                await self.command(f"failure-{i}")
            self.assertEqual(caught.exception.detail["code"], code)
            self.assertNotIn("secret-value", str(caught.exception.detail))


class ReusableTabs(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        worker.TOKEN = "fixture-token"
        worker.command_lock = asyncio.Lock()
        worker.recorder = None
        def page():
            return types.SimpleNamespace(url="about:blank", is_closed=lambda: False,
                title=AsyncMock(return_value="Fixture"), evaluate=AsyncMock(return_value=False), bring_to_front=AsyncMock())
        self.context = types.SimpleNamespace(pages=[page()])
        async def new_page():
            value = page()
            self.context.pages.append(value)
            return value
        self.context.new_page = AsyncMock(side_effect=new_page)
        worker.session = worker.Session("tabs", 1, None, self.context)

    async def acquire(self, key, command_id):
        return await worker.command_locked("tabs", worker.CommandRequest(generation=1, input_generation=1,
            command_id=command_id, method="tab.acquire", params={"tab_key": key}), "Bearer fixture-token", "1")

    async def test_many_acquisitions_reuse_two_tabs_and_preserve_their_urls(self):
        first = (await self.acquire("x", "x1"))["value"]["page_id"]
        second = (await self.acquire("notion", "n1"))["value"]["page_id"]
        self.assertNotEqual(first, second)
        worker.session.pages[second].url = "https://app.notion.com/database"
        for i in range(20):
            value = (await self.acquire("notion", f"n{i+2}"))["value"]
            self.assertEqual(value, {"page_id": second, "url": "https://app.notion.com/database"})
        self.assertEqual(len(self.context.pages), 2)
        self.context.new_page.assert_awaited_once()
        tabs = await worker.list_tabs("tabs", 1, "Bearer fixture-token", "1")
        self.assertEqual([tab["tabKey"] for tab in tabs["tabs"]], ["x", "notion"])
        await worker.select_tab("tabs", worker.SelectTabRequest(generation=1, page_id=second), "Bearer fixture-token", "1")
        worker.session.pages[second].bring_to_front.assert_awaited_once()
        self.assertEqual(worker.session.selected_page, second)
        with self.assertRaises(worker.HTTPException):
            await worker.select_tab("tabs", worker.SelectTabRequest(generation=2, page_id=second), "Bearer fixture-token", "1")


class ClipboardPaste(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        worker.TOKEN = "fixture-token"
        worker.command_lock = asyncio.Lock()
        worker.session = worker.Session("paste-test", 2, None, None, input_owner="human", input_generation=3)
        worker.human_view_active = True
        self.writer = AsyncMock()
        patcher = patch.object(worker, "paste_text", self.writer)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(setattr, worker, "human_view_active", False)

    async def paste(self, session_id="paste-test", generation=2, input_generation=3, token="fixture-token"):
        return await worker.paste(session_id, worker.PasteRequest(generation=generation,
            input_generation=input_generation, text="hello\nمرحبا 🌍"), f"Bearer {token}", "1")

    async def test_pastes_unicode_once_under_active_control(self):
        self.assertEqual(await self.paste(), {"pasted": True})
        self.writer.assert_awaited_once_with("hello\nمرحبا 🌍")

    async def test_rejects_stale_generations_wrong_session_and_token(self):
        for args in ({"generation": 1}, {"input_generation": 2}, {"session_id": "other"}, {"token": "wrong"}):
            with self.assertRaises(worker.HTTPException):
                await self.paste(**args)
        self.writer.assert_not_awaited()

    async def test_requires_human_owner_and_connected_controller(self):
        for owner in ("ai", "paused"):
            worker.session.input_owner = owner
            with self.assertRaises(worker.HTTPException):
                await self.paste()
        worker.session.input_owner = "human"
        worker.human_view_active = False
        with self.assertRaises(worker.HTTPException):
            await self.paste()
        self.writer.assert_not_awaited()

    async def test_checks_ownership_again_after_waiting_for_lock(self):
        await worker.command_lock.acquire()
        operation = asyncio.create_task(self.paste())
        await asyncio.sleep(0)
        worker.session.input_owner = "ai"
        worker.command_lock.release()
        with self.assertRaises(worker.HTTPException):
            await operation
        self.writer.assert_not_awaited()

    async def test_failure_does_not_expose_clipboard_contents(self):
        self.writer.side_effect = RuntimeError("synthetic clipboard contents")
        with self.assertRaises(worker.HTTPException) as caught:
            await self.paste()
        self.assertEqual(caught.exception.status_code, 503)
        self.assertNotIn("synthetic", caught.exception.detail)


class ProfileSave(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        worker.TOKEN = "fixture-token"
        worker.command_lock = asyncio.Lock()
        worker.clean_snapshot = None
        worker.recorder = None
        worker.stop_control_vnc = AsyncMock()
        self.cookies = [{"name": "login", "value": "fixture", "domain": "profile.test", "path": "/", "expires": -1}]
        self.context = types.SimpleNamespace(cookies=AsyncMock(return_value=self.cookies))
        self.manager = types.SimpleNamespace(__aexit__=AsyncMock(side_effect=self.closed))
        self.current = worker.Session("save-test", 1, self.manager, self.context, profile=Path(self.directory.name))
        worker.session = self.current

    async def closed(self, *_):
        self.current.context_closed = True

    async def stop(self):
        return await worker.stop_session("save-test", 1, "Bearer fixture-token", "1")

    def saved_cookies(self, result):
        with tarfile.open(fileobj=io.BytesIO(base64.b64decode(result["snapshot"])), mode="r:gz") as archive:
            return json.load(archive.extractfile(".tabductor-session-cookies.json"))

    async def test_saves_checkpoint_after_browser_window_was_closed(self):
        await worker.checkpoint_cookies(self.current)
        self.current.context_closed = True
        self.context.cookies.side_effect = RuntimeError("Browser was already closed")
        result = await self.stop()
        self.assertEqual(self.saved_cookies(result), self.cookies)
        self.context.cookies.assert_awaited_once()

    async def test_archive_retry_does_not_read_a_closed_context(self):
        with patch.object(worker.tarfile, "open", side_effect=OSError("temporary archive failure")):
            with self.assertRaises(OSError):
                await self.stop()
        self.context.cookies.side_effect = RuntimeError("Browser was already closed")
        result = await self.stop()
        self.assertEqual(self.saved_cookies(result), self.cookies)
        self.context.cookies.assert_awaited_once()
        self.manager.__aexit__.assert_awaited_once()
        self.assertEqual(await self.stop(), result)

    async def test_control_reports_browser_closure_so_fleet_can_save_it(self):
        self.current.context_closed = True
        result = await worker.control("save-test", worker.ControlRequest(generation=1, input_generation=1, owner="ai"), "Bearer fixture-token", "1")
        self.assertEqual(result, {"closed": True})

if __name__ == "__main__":
    unittest.main()
