#!/usr/bin/env python3
"""Local byte relay. Validates SO_PEERCRED on the actual socket being relayed.

Never starts Codex, creates a socket, or acquires thread ownership. stdout is
the existing Desktop IPC byte stream; stderr contains sanitized lifecycle data.
"""
import json
import os
import selectors
import socket
import stat
import struct
import sys


def main():
    path, expected_exe = sys.argv[1:3]
    uid = os.getuid()
    directory_modes = {0o700, 0o755} if sys.argv[3:] == ["--app-tools"] else {0o700}
    for candidate, expected_modes in [(os.path.dirname(path), directory_modes), (path, {0o600})]:
        info = os.lstat(candidate)
        if info.st_uid != uid or stat.S_IMODE(info.st_mode) not in expected_modes or stat.S_ISLNK(info.st_mode):
            raise RuntimeError('unsafe-socket-permissions')
    if not stat.S_ISSOCK(os.lstat(path).st_mode):
        raise RuntimeError('not-a-socket')
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(5)
    sock.connect(path)
    pid, peer_uid, _ = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    if peer_uid != uid or os.readlink(f'/proc/{pid}/exe') != expected_exe:
        raise RuntimeError('unexpected-socket-peer')
    print(json.dumps({'type': 'ready', 'pid': pid, 'uid': uid}), file=sys.stderr, flush=True)
    sock.setblocking(False)
    os.set_blocking(0, False)
    os.set_blocking(1, False)
    selector = selectors.DefaultSelector()
    selector.register(0, selectors.EVENT_READ)
    selector.register(sock, selectors.EVENT_READ)
    to_socket = bytearray()
    to_stdout = bytearray()
    stdout_registered = False
    while True:
        for key, mask in selector.select():
            if key.fileobj == 0:
                data = os.read(0, 65536)
                if not data:
                    return
                to_socket.extend(data)
            elif key.fileobj == sock:
                if mask & selectors.EVENT_READ:
                    data = sock.recv(65536)
                    if not data:
                        return
                    to_stdout.extend(data)
                if mask & selectors.EVENT_WRITE and to_socket:
                    del to_socket[:sock.send(to_socket)]
            elif key.fileobj == 1 and to_stdout:
                del to_stdout[:os.write(1, to_stdout)]
        if len(to_socket) + len(to_stdout) > 32 * 1024 * 1024:
            raise RuntimeError('relay-backpressure-limit')
        selector.modify(sock, selectors.EVENT_READ | (selectors.EVENT_WRITE if to_socket else 0))
        if to_stdout and not stdout_registered:
            selector.register(1, selectors.EVENT_WRITE)
            stdout_registered = True
        elif not to_stdout and stdout_registered:
            selector.unregister(1)
            stdout_registered = False


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError) as exc:
        print(json.dumps({'type': 'error', 'error': str(exc)[:200]}), file=sys.stderr, flush=True)
        sys.exit(1)
