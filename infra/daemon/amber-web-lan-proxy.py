#!/usr/bin/env python3
"""TCP proxy: 0.0.0.0:7718 -> 127.0.0.1:7717.

Lets phones hit amber web by LAN IP without Tailscale Serve's Host-header
requirement. WebSocket upgrade is HTTP then raw TCP, so we rewrite only the
first request head, then pipe.

Serve-hop auth on amber web trusts `Tailscale-User-*` and `X-Forwarded-*`
because Serve injects them on loopback. This proxy is also loopback to the
backend, so a LAN client could spoof those headers and skip the fragment
token. Strip them here; Serve talks to 7717 directly and is unaffected.
"""
from __future__ import annotations

import select
import socket
import threading

LISTEN = ("0.0.0.0", 7718)
TARGET = ("127.0.0.1", 7717)
MAX_HEAD = 32 * 1024


def filter_request_head(buf: bytes) -> bytes:
    """Drop Tailscale-* / X-Forwarded-* and force Connection: close."""
    sep = buf.find(b"\r\n\r\n")
    if sep < 0:
        raise ValueError("incomplete HTTP head")
    head, body = buf[:sep], buf[sep + 4 :]
    lines = head.split(b"\r\n")
    if not lines:
        raise ValueError("empty HTTP head")
    kept = [lines[0]]
    for line in lines[1:]:
        if not line:
            continue
        name = line.split(b":", 1)[0].decode("latin1", "replace").strip().lower()
        if name.startswith("tailscale-") or name.startswith("x-forwarded-") or name == "connection":
            continue
        kept.append(line)
    kept.append(b"Connection: close")
    return b"\r\n".join(kept) + b"\r\n\r\n" + body


def _read_head(sock: socket.socket) -> bytes:
    buf = b""
    sock.settimeout(10)
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
        if len(buf) > MAX_HEAD:
            raise ValueError("HTTP head too large")
    sock.settimeout(None)
    return buf


def _pipe(a: socket.socket, b: socket.socket) -> None:
    try:
        while True:
            ready, _, _ = select.select([a, b], [], [], 60)
            if not ready:
                continue
            for src in ready:
                data = src.recv(65536)
                if not data:
                    return
                dst = b if src is a else a
                dst.sendall(data)
    except OSError:
        return
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                s.close()
            except OSError:
                pass


def _handle(client: socket.socket) -> None:
    try:
        raw = _read_head(client)
        if b"\r\n\r\n" not in raw:
            client.close()
            return
        forwarded = filter_request_head(raw)
        upstream = socket.create_connection(TARGET, timeout=5)
        upstream.sendall(forwarded)
    except (OSError, ValueError):
        client.close()
        return
    threading.Thread(target=_pipe, args=(client, upstream), daemon=True).start()


def main() -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(128)
    while True:
        client, _ = srv.accept()
        client.settimeout(None)
        threading.Thread(target=_handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
