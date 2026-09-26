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
from unittest.mock import AsyncMock, Mock, patch

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

    async def test_takeover_cancels_proxy_scopes_before_draining_callbacks(self):
        waiting = asyncio.create_task(asyncio.Event().wait())
        async def close():
            waiting.cancel()
        scope = types.SimpleNamespace(close=AsyncMock(side_effect=close))
        worker.session.proxy_scopes = {"cell": scope}
        worker.session.inflight.add(waiting)
        await asyncio.wait_for(worker.control("session-a", worker.ControlRequest(generation=2,
            input_generation=2, owner="human"), "Bearer fixture-token", "1"), 1)
        scope.close.assert_awaited_once()
        self.assertTrue(waiting.cancelled())
        self.assertEqual(worker.session.proxy_scopes, {})

    async def test_unchanged_control_does_not_cancel_or_wait_for_active_cell(self):
        waiting = asyncio.create_task(asyncio.Event().wait())
        scope = types.SimpleNamespace(close=AsyncMock())
        worker.session.proxy_scopes = {"cell": scope}
        worker.session.inflight.add(waiting)
        try:
            for _ in range(3):
                result = await asyncio.wait_for(worker.control("session-a", worker.ControlRequest(
                    generation=2, input_generation=1, owner="ai"), "Bearer fixture-token", "1"), 0.5)
                self.assertEqual(result, {"acknowledged": True, "input_generation": 1})
            scope.close.assert_not_awaited()
            self.assertEqual(worker.checkpoint_cookies.await_count, 3)
            self.assertFalse(waiting.done())
            self.assertEqual(worker.session.proxy_scopes, {"cell": scope})
        finally:
            waiting.cancel()
            await asyncio.gather(waiting, return_exceptions=True)
            worker.session.inflight.clear()

    async def test_invalid_control_does_not_close_active_scopes(self):
        scope = types.SimpleNamespace(close=AsyncMock())
        worker.session.proxy_scopes = {"cell": scope}
        worker.session.input_generation = 2
        for generation, owner in [(1, "ai"), (2, "human"), (3, "invalid")]:
            with self.subTest(generation=generation, owner=owner):
                with self.assertRaises(worker.HTTPException):
                    await worker.control("session-a", worker.ControlRequest(generation=2,
                        input_generation=generation, owner=owner), "Bearer fixture-token", "1")
        scope.close.assert_not_awaited()
        self.assertEqual(worker.session.proxy_scopes, {"cell": scope})
        self.assertEqual(worker.session.input_owner, "ai")

    async def test_automation_errors_keep_distinct_codes_and_safe_messages(self):
        request = types.SimpleNamespace(url=types.SimpleNamespace(path="/v1/sessions/session-a/automation"))
        for detail, code, uncertain in [
            ("input ownership was revoked", "browser_input_revoked", False),
            ("command already submitted", "browser_outcome_uncertain", True),
            ("invocation already open or capacity exhausted", "browser_invocation_conflict", False),
            ("target is absent or ambiguous", "browser_stale_target", False),
        ]:
            with self.subTest(code=code):
                response = await worker.http_error_handler(request, worker.HTTPException(409, detail + " secret-value"))
                payload = json.loads(response.body)["detail"]
                self.assertEqual(payload["code"], code)
                self.assertEqual(payload["outcomeUncertain"], uncertain)
                self.assertNotIn("secret-value", payload["message"])

    async def test_expiry_and_takeover_preserve_uncertainty_of_submitted_operations(self):
        for owner, code in [("ai", "browser_invocation_expired"), ("paused", "browser_input_revoked")]:
            worker.session.input_owner = owner
            for method, uncertain in [("start", False), ("poll", True), ("callback", True)]:
                with self.subTest(owner=owner, method=method):
                    with self.assertRaises(worker.HTTPException) as caught:
                        await worker.automation("session-a", worker.CommandRequest(generation=2,
                            input_generation=1, command_id="missing", method=method, page_id="p1",
                            params={"invocation": "expired-cell"}), "Bearer fixture-token", "1")
                    self.assertEqual(caught.exception.detail["code"], code)
                    self.assertEqual(caught.exception.detail["outcomeUncertain"], uncertain)

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

    async def test_harness_click_distinguishes_preflight_from_dispatched_timeout(self):
        from playwright.async_api import TimeoutError
        for i, (effects, code, uncertain) in enumerate([
            ([TimeoutError("missing target secret-value")], "browser_target_not_ready", False),
            ([None, TimeoutError("dispatched secret-value")], "browser_timeout", True),
        ]):
            click = AsyncMock(side_effect=effects)
            worker.session.pages["p1"].locator = Mock(return_value=types.SimpleNamespace(click=click))
            with self.assertRaises(worker.HTTPException) as caught:
                await worker.command_locked("session-a", worker.CommandRequest(generation=2,
                    input_generation=1, command_id=f"click-{i}", method="page.harness", page_id="p1",
                    params={"method":"click","args":{"selector":"a","timeoutMs":500}}), "Bearer fixture-token", "1")
            self.assertEqual(caught.exception.detail["code"], code)
            self.assertEqual(caught.exception.detail["outcomeUncertain"], uncertain)
            self.assertNotIn("secret-value", str(caught.exception.detail))
            self.assertEqual(click.await_count, len(effects))

    async def test_closed_page_is_recoverable_only_when_browser_and_context_are_alive(self):
        from playwright.async_api import Error
        worker.session.pages["p1"].title = AsyncMock(side_effect=Error("Target page, context or browser has been closed secret-value"))
        worker.session.pages["p1"].is_closed = lambda: True
        for i, (connected, context_closed, expected) in enumerate([
            (True, False, "browser_page_closed"),
            (False, False, "browser.disconnected"),
            (True, True, "browser.disconnected"),
        ]):
            worker.session.context = types.SimpleNamespace(browser=types.SimpleNamespace(is_connected=lambda: connected))
            worker.session.context_closed = context_closed
            with self.assertRaises(worker.HTTPException) as caught:
                await self.command(f"closed-{i}")
            self.assertEqual(caught.exception.detail["code"], expected)
            self.assertTrue(caught.exception.detail["outcomeUncertain"])
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
        self.assertEqual(worker.session.selected_page, second)
        self.assertEqual(worker.session.pages[second].bring_to_front.await_count, 21)
        worker.session.pages[second].bring_to_front.reset_mock()
        await worker.select_tab("tabs", worker.SelectTabRequest(generation=1, page_id=second), "Bearer fixture-token", "1")
        worker.session.pages[second].bring_to_front.assert_awaited_once()
        self.assertEqual(worker.session.selected_page, second)
        with self.assertRaises(worker.HTTPException):
            await worker.select_tab("tabs", worker.SelectTabRequest(generation=2, page_id=second), "Bearer fixture-token", "1")

    async def test_replay_follows_each_node_and_keeps_recording_ordinary_python_calls(self):
        recorder = types.SimpleNamespace(private=AsyncMock())
        with patch.object(worker, "recorder", recorder):
            for index, member in enumerate(("evaluate", "fill")):
                page_id = (await self.acquire(f"node-{index}", f"acquire-{index}"))["value"]["page_id"]
                page = worker.session.pages[page_id]
                popup = types.SimpleNamespace(is_closed=lambda: False, bring_to_front=AsyncMock())
                scope = types.SimpleNamespace(root=page, closed=False, ref=Mock(),
                    origins={"target": popup}, owns=AsyncMock(return_value=True), start=Mock(return_value="ticket"))
                worker.session.proxy_scopes = {"cell": scope}
                await worker.automation("tabs", worker.CommandRequest(generation=1, input_generation=1,
                    command_id=f"call-{index}", method="start", page_id=page_id,
                    params={"invocation": "cell", "target": {"id": "target"}, "member": member, "recording_private": False}), "Bearer fixture-token", "1")
                popup.bring_to_front.assert_awaited_once()
                self.assertIs(worker.session.pages[worker.session.selected_page], popup)
                scope.start.assert_called_once()
            recorder.private.assert_not_awaited()

    async def test_sensitive_input_stops_capture_before_foreground_or_dispatch(self):
        page_id = (await self.acquire("login", "acquire"))["value"]["page_id"]
        page = worker.session.pages[page_id]
        recorder = types.SimpleNamespace(private=AsyncMock())
        scope = types.SimpleNamespace(root=page, closed=False, ref=Mock(), origins={"target": page},
            owns=AsyncMock(return_value=True), start=Mock(return_value="ticket"))
        worker.session.proxy_scopes = {"cell": scope}
        async def focus():
            recorder.private.assert_awaited_once()
            scope.start.assert_not_called()
        page.bring_to_front = AsyncMock(side_effect=focus)
        with patch.object(worker, "recorder", recorder):
            await worker.automation("tabs", worker.CommandRequest(generation=1, input_generation=1,
                command_id="secret", method="start", page_id=page_id,
                params={"invocation": "cell", "target": {"id": "target"}, "member": "fill", "recording_private": True}), "Bearer fixture-token", "1")
        page.bring_to_front.assert_awaited_once()
        scope.start.assert_called_once()

    async def test_privacy_inspection_resolves_keyword_selectors_and_rejects_unknown_frames(self):
        page_id = (await self.acquire("login", "acquire"))["value"]["page_id"]
        page = worker.session.pages[page_id]
        page.url = "https://fixture.test"
        locator = type("Locator", (), {})()
        locator.count = AsyncMock(return_value=1)
        locator.evaluate = AsyncMock(return_value={"type": "password", "tag": "input", "origin": page.url})
        locator._impl_obj = types.SimpleNamespace(_selector="#password")
        target = type("Page", (), {})()
        target.locator = Mock(return_value=locator)
        scope = types.SimpleNamespace(root=page, ref=Mock(return_value=target), origins={"target": page})
        worker.session.proxy_scopes = {"cell": scope}
        request = worker.CommandRequest(generation=1, input_generation=1, command_id="inspect", method="inspect", page_id=page_id,
            params={"invocation": "cell", "call": {"target": {"id": "target"}, "args": [], "kwargs": {"selector": "#password"}}})
        result = await worker.automation("tabs", request, "Bearer fixture-token", "1")
        target.locator.assert_called_once_with("#password")
        self.assertEqual(result["value"]["type"], "password")
        scope.ref.return_value = types.SimpleNamespace()
        page.evaluate.return_value = {"tag": "iframe", "origin": page.url}
        self.assertEqual(await worker.automation("tabs", request, "Bearer fixture-token", "1"), {"value": None})


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
