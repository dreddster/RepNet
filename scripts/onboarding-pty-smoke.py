#!/usr/bin/env python3
"""PTY smoke for the human RepNet onboarding path.

This intentionally uses a real pseudo-terminal instead of piped stdin because
Node readline/raw-mode prompts behave differently without a TTY.

The smoke uses a throwaway generated wallet and stops before registration. It
checks the no-ETH reviewer path: faucet guidance, resume-safe progress, and
continued Agent Card prompt rendering.
"""
from __future__ import annotations

import os
import pty
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "packages" / "cli" / "dist" / "cli.js"
TIMEOUT_SECONDS = 90


def wait_for(fd: int, text: str, output: list[str], deadline: float) -> None:
    needle = text.lower()
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.25)
        if ready:
            chunk = os.read(fd, 4096).decode("utf-8", errors="replace")
            output.append(chunk)
            if needle in "".join(output).lower():
                return
    raise TimeoutError(f"Timed out waiting for {text!r}. Output tail:\n{''.join(output)[-2000:]}")


def send(fd: int, text: str) -> None:
    os.write(fd, text.encode("utf-8"))


def main() -> int:
    if not CLI.exists():
        raise SystemExit(f"Missing built CLI at {CLI}. Run: npm run build -w @repnet/cli")

    root = Path(tempfile.mkdtemp(prefix="repnet-onboarding-pty-smoke."))
    home = root / "home"
    home.mkdir()

    master, slave = pty.openpty()
    env = os.environ.copy()
    env["HOME"] = str(home)

    node = shutil.which("node")
    if not node:
        raise SystemExit("Missing required command: node")

    proc = subprocess.Popen(
        [node, str(CLI), "onboard"],
        cwd=str(ROOT),
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave)

    output: list[str] = []
    deadline = time.monotonic() + TIMEOUT_SECONDS

    try:
        wait_for(master, "Choice [1-3]:", output, deadline)
        send(master, "1\n")

        wait_for(master, "Press Enter once you've saved the mnemonic", output, deadline)
        send(master, "\n")

        wait_for(master, "Check balance again after funding?", output, deadline)
        send(master, "n\n")

        wait_for(master, "Choice [1-2]:", output, deadline)

        text = "".join(output)
        required = [
            "New wallet generated",
            "ETH balance: 0.000000 ETH",
            "https://www.alchemy.com/faucets/base-sepolia",
            "https://faucet.quicknode.com/base/sepolia",
            "Free tier active",
            "A2A Agent Card",
        ]
        missing = [item for item in required if item not in text]
        if missing:
            raise AssertionError(f"PTY onboarding smoke missing expected output: {missing}")

        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)

        print("CLI onboarding PTY smoke passed.")
        print(f"Temp HOME: {home}")
        return 0
    finally:
        try:
            os.close(master)
        except OSError:
            pass
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
