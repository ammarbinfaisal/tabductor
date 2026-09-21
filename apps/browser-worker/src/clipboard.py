"""Write host text to the X clipboard and paste into the focused browser field."""
import asyncio


async def run_input(args: list[str], data: bytes | None = None):
    # Clipboard contents travel over stdin, never argv, files, or logs.
    process = await asyncio.create_subprocess_exec(
        *args, stdin=asyncio.subprocess.PIPE if data is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        await asyncio.wait_for(process.communicate(data), timeout=3)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    if process.returncode:
        raise RuntimeError("remote clipboard operation failed")


async def paste_text(text: str):
    # xclip owns the selection until another application replaces it. UTF8_STRING
    # avoids the Latin-1-only clipboard path in x11vnc/noVNC.
    await run_input(["xclip", "-selection", "clipboard", "-in", "-target", "UTF8_STRING"], text.encode("utf-8"))
    # Applies to Firefox chrome (including its address bar) as well as web pages.
    # Clear host Ctrl/Cmd modifiers for this keystroke, then restore held keys.
    await run_input(["xdotool", "key", "--clearmodifiers", "ctrl+v"])
