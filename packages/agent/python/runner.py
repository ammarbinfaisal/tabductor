"""Tabductor's workflow API extension to the shared browser harness."""
import sys
from pathlib import Path

script = Path(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else Path("/opt/browser_harness/tabductor_runner.py")
sys.path.insert(0, str(script.resolve().parent.parent))

from browser_harness.playwright_proxy import WORKFLOW_METHODS
from browser_harness.tabductor_runner import main

WORKFLOW_METHODS.update({"store.define_table", "store.query", "store.insert", "store.upsert"})

if __name__ == "__main__":
    main()
