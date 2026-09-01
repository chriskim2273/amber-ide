#!/usr/bin/env python3
"""Tests for LAN-proxy header stripping. Run: python3 -m unittest infra/daemon/test_amber_web_lan_proxy.py"""

import importlib.util
import unittest
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "lan_proxy", Path(__file__).with_name("amber-web-lan-proxy.py")
)
_MOD = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(_MOD)
filter_request_head = _MOD.filter_request_head


class FilterRequestHead(unittest.TestCase):
    def test_strips_tailscale_and_forwarded_headers(self):
        head = (
            b"GET /api/sessions HTTP/1.1\r\n"
            b"Host: 10.0.0.5:7718\r\n"
            b"X-Forwarded-Proto: https\r\n"
            b"X-Forwarded-Host: teapot-dev.tail3d57b4.ts.net\r\n"
            b"Tailscale-User-Login: alice@github\r\n"
            b"Tailscale-User-Name: Alice\r\n"
            b"Cookie: amber_web=abc\r\n"
            b"\r\n"
        )
        out = filter_request_head(head)
        lower = out.lower()
        self.assertNotIn(b"x-forwarded-", lower)
        self.assertNotIn(b"tailscale-", lower)
        self.assertIn(b"cookie: amber_web=abc", lower)
        self.assertIn(b"connection: close", lower)
        self.assertTrue(out.startswith(b"GET /api/sessions HTTP/1.1\r\n"))
        self.assertTrue(out.endswith(b"\r\n\r\n"))

    def test_keeps_body_bytes_already_read_with_the_head(self):
        head = (
            b"POST /api/auth HTTP/1.1\r\n"
            b"Content-Length: 4\r\n"
            b"Tailscale-User-Login: spoof\r\n"
            b"\r\n"
            b"toknEXTRA"
        )
        out = filter_request_head(head)
        self.assertTrue(out.endswith(b"toknEXTRA"))
        self.assertNotIn(b"Tailscale-User-Login", out)

    def test_rejects_incomplete_head(self):
        with self.assertRaises(ValueError):
            filter_request_head(b"GET / HTTP/1.1\r\nHost: x\r\n")


if __name__ == "__main__":
    unittest.main()
