"""Pin an observed node across validation and an effect; copied attributes are not identity."""
from contextlib import asynccontextmanager

@asynccontextmanager
async def snapshot_target(locator, selector):
    if "[data-tabductor-node=" not in selector:
        yield locator
        return
    if await locator.count() != 1:
        raise ValueError("stale or ambiguous snapshot target; perceive again")
    handle = await locator.element_handle()
    if handle is None:
        raise ValueError("stale snapshot target; perceive again")
    try:
        valid = await handle.evaluate("el => el.isConnected && window.__tabductorPerception?.ids.get(el) === el.getAttribute('data-tabductor-node')")
        if not valid:
            raise ValueError("snapshot node was replaced; perceive again")
        yield handle
    finally:
        await handle.dispose()
