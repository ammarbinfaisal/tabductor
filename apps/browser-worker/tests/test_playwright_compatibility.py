"""Compare the sandbox API against the worker's pinned, native Playwright API."""
import inspect
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from playwright import sync_api as native
from playwright.sync_api import _generated
from browser_harness import playwright_proxy as proxy


class Compatibility(unittest.TestCase):
    def setUp(self):
        self.calls = []
        def call(name, args):
            self.calls.append((name, args))
            if name == "playwright.expect":
                return self.reference("LocatorAssertions")
            if args.get("member") == "context":
                return self.reference("BrowserContext")
            if args.get("member") == "value":
                return self.reference("Page")
            if args.get("member") == "storage_state":
                return {"cookies": [], "origins": []}
            if args.get("member") in {"screenshot", "save_as", "stop"}:
                return {"$bytes": "aW1hZ2U="}
            return None
        self.transport = proxy.Transport(call)

    def reference(self, name):
        return {"$ref": {"class": name, "id": name, "scope": "cell"}}

    def object(self, name):
        return self.transport.decode(self.reference(name))

    def test_every_native_class_member_and_argument_is_present(self):
        classes = {n: c for n, c in vars(_generated).items() if inspect.isclass(c) and c.__module__ == _generated.__name__}
        self.assertEqual(set(classes), set(proxy.MANIFEST["classes"]))
        for name, cls in classes.items():
            members = {n: v for n, v in inspect.getmembers(cls) if not n.startswith("_") and (callable(v) or isinstance(v, property))}
            self.assertEqual(set(members), set(proxy.MANIFEST["classes"][name]), name)
            for member, value in members.items():
                with self.subTest(cls=name, member=member):
                    public = getattr(proxy.PUBLIC_TYPES[name], member)
                    if isinstance(value, property):
                        self.assertIsInstance(public, property)
                    else:
                        actual, expected = inspect.signature(public), inspect.signature(value)
                        self.assertEqual([(p.name, p.kind, p.default) for p in actual.parameters.values()],
                                         [(p.name, p.kind, p.default) for p in expected.parameters.values()])

    def test_native_exports_except_host_owned_startup_are_importable(self):
        import sys
        with patch.dict(sys.modules):
            proxy.install_sync_api(self.transport, self.object("Page"), self.object("BrowserContext"))
            module = sys.modules["playwright.sync_api"]
            for name in native.__all__:
                if name != "sync_playwright":
                    self.assertTrue(hasattr(module, name), name)
            self.assertEqual(module.ViewportSize(width=800, height=600), {"width": 800, "height": 600})
            self.assertIs(module.ChromiumBrowserContext, module.BrowserContext)
            self.assertEqual(module.Error("message").message, "message")

    def test_identity_inheritance_and_bound_signatures(self):
        page, context = self.object("Page"), self.object("BrowserContext")
        self.assertIs(page.context, context)
        self.assertIs(page, self.object("Page"))
        self.assertIsInstance(self.object("ElementHandle"), proxy.PUBLIC_TYPES["JSHandle"])
        self.assertEqual(list(inspect.signature(page.goto).parameters), ["url", "timeout", "wait_until", "referer"])
        with self.assertRaises(TypeError):
            page.goto("https://example.test", url="duplicate")
        proxy.PUBLIC_TYPES["Page"].title(page)
        self.assertEqual(self.calls[-1][1]["member"], "title")

    def test_event_context_manager_returns_cached_event_info(self):
        manager = self.object("EventContextManager")
        with manager as info:
            self.assertIsInstance(info, proxy.EventInfo)
        self.assertIs(info.value, self.object("Page"))
        self.assertTrue(info.is_done())
        self.assertEqual([args["member"] for _, args in self.calls], ["enter", "exit", "value"])

    def test_expect_options_are_per_transport_and_explicit(self):
        self.transport.expect.set_options(timeout=123)
        self.transport.expect(actual=self.object("Locator"), message="saved")
        self.assertEqual(self.calls[-1][1]["timeout"], 123)
        self.assertEqual(self.calls[-1][1]["message"], "saved")
        with self.assertRaises(ValueError):
            self.transport.expect("not a Playwright object")

    def test_paths_are_local_and_screenshot_format_is_inferred(self):
        with tempfile.TemporaryDirectory() as folder:
            image = Path(folder) / "nested/screenshot.jpg"
            self.object("Page").screenshot(path=image)
            self.assertEqual(image.read_bytes(), b"image")
            self.assertEqual(self.calls[-1][1]["kwargs"], {"type": "jpeg"})
            with self.assertRaises(proxy.BrowserError):
                self.object("Page").screenshot(path=Path(folder) / "image.txt")
            state = Path(folder) / "state.json"
            result = self.object("BrowserContext").storage_state(path=state)
            self.assertEqual(json.loads(state.read_text()), result)
            destination = Path(folder) / "downloads/file.bin"
            self.object("Download").save_as(destination)
            self.assertEqual(destination.read_bytes(), b"image")
            self.assertNotIn(folder, str(self.calls))


if __name__ == "__main__":
    unittest.main()
