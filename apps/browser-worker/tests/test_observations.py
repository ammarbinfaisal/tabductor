import asyncio
import base64
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock
sys.path.insert(0, str(Path(__file__).parents[1]))
from src.observations import Observations
from fastapi import HTTPException

class ObservationsTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.current = types.SimpleNamespace(input_owner="ai", input_generation=1,
            context=types.SimpleNamespace(on=lambda *args: None, pages=[]))
        self.feed = Observations(self.current)
        self.page = object()
        self.feed.roots[self.page] = "p1"
        self.response = types.SimpleNamespace(status=200, headers={"content-type":"application/json"},
            body=AsyncMock(return_value=b'{"ok":true}'))
        class Request:
            method="GET"
            url="https://fixture.test/api"
            resource_type="fetch"
        self.request = Request()
        self.request.frame=types.SimpleNamespace(page=self.page)
        self.request.response=AsyncMock(return_value=self.response)

    async def test_metadata_does_not_read_body_and_body_reads_are_bounded(self):
        await self.feed.start(self.request)
        await self.feed.settled(self.request)
        self.assertEqual([e["kind"] for e in self.feed.read(-1)], ["request", "settled"])
        self.response.body.assert_not_awaited()
        part = await self.feed.part("0", "responseBody")
        self.assertEqual(base64.b64decode(part["bytes"]), b'{"ok":true}')
        self.response.headers["content-length"]="2000000"
        with self.assertRaises(HTTPException) as error:
            await self.feed.part("0", "responseBody")
        self.assertEqual(error.exception.status_code, 413)
        self.response.body.assert_awaited_once()

    async def test_takeover_generation_hides_old_feed_and_revokes_body_access(self):
        await self.feed.start(self.request)
        self.current.input_owner="human"
        self.current.input_generation=2
        await self.feed.settled(self.request)
        self.current.input_owner="ai"
        self.current.input_generation=3
        self.assertEqual(self.feed.read(-1), [])
        with self.assertRaises(HTTPException):
            await self.feed.part("0", "responseBody")
        self.response.body.assert_not_awaited()
