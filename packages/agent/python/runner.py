"""Tabductor's browser service extension to the shared browser harness."""
import sys
from pathlib import Path

script = Path(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else Path("/opt/browser_harness/tabductor_runner.py")
sys.path.insert(0, str(script.resolve().parent.parent))

from browser_harness.playwright_proxy import BROWSER_METHODS, BrowserServices
from browser_harness import tabductor_runner

BROWSER_METHODS.update({"store.define_table", "store.query", "store.insert", "store.upsert"})
BROWSER_METHODS.update({f"captcha.{method}" for method in (
    "providers", "create_task", "get_result", "wait", "solve", "push_variable",
)})


class TabductorInterpreter(tabductor_runner.Interpreter):
    def __init__(self, wire_in, wire_out):
        super().__init__(wire_in, wire_out)
        self.env["captcha"] = BrowserServices(self.transport, "captcha")


tabductor_runner.Interpreter = TabductorInterpreter

if __name__ == "__main__":
    tabductor_runner.main()
