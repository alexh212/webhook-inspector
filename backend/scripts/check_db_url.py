#!/usr/bin/env python3
"""Validate DATABASE_URL: surface hidden whitespace, parse, and resolve host.

Usage (from backend/):
    python scripts/check_db_url.py
or pass a URL to test the value you're about to paste into Render:
    python scripts/check_db_url.py 'postgresql+asyncpg://...'
"""
import os
import socket
import sys
from urllib.parse import urlparse

from dotenv import load_dotenv


def main() -> int:
    if len(sys.argv) > 1:
        url = sys.argv[1]
        source = "argv"
    else:
        load_dotenv()
        url = os.getenv("DATABASE_URL", "")
        source = "env"

    if not url:
        print("DATABASE_URL is empty or unset")
        return 1

    print(f"source={source}  length={len(url)}")
    print(f"head={url[:40]!r}")
    print(f"tail={url[-40:]!r}")

    problems = []
    if url != url.strip():
        problems.append("leading/trailing whitespace")
    if "\n" in url or "\r" in url:
        problems.append("embedded newline")
    if " " in url.strip():
        problems.append("embedded space")
    if problems:
        print("PROBLEMS:", ", ".join(problems))
        return 1

    parsed = urlparse(url.replace("postgresql+asyncpg", "postgresql"))
    host = parsed.hostname
    port = parsed.port or 5432
    print(f"host={host}  port={port}  user={parsed.username}  db={parsed.path.lstrip('/')}")

    if not host:
        print("PROBLEM: no host parsed from URL")
        return 1

    try:
        addrs = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        print(f"DNS OK -> {addrs[0][4][0]}")
    except socket.gaierror as e:
        print(f"DNS FAIL: {e}  (this is the same error Render is hitting)")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
