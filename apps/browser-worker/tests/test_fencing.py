"""Worker protocol tests use a fake browser; no Camoufox download or external call."""
import asyncio
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

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

    async def command(self, command_id="one", generation=2, input_generation=1):
        return await worker.command_locked("session-a", worker.CommandRequest(generation=generation,
            input_generation=input_generation, command_id=command_id, method="page.title", page_id="p1"), "Bearer fixture-token", "1")

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

if __name__ == "__main__":
    unittest.main()
