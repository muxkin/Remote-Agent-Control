#!/usr/bin/env python3
"""Local byte relay. Validates SO_PEERCRED on the actual socket being relayed.

Never starts Codex, creates a socket, or acquires thread ownership. stdout is
the existing Desktop IPC byte stream; stderr contains sanitized lifecycle data.
"""
import ctypes
import hashlib
import threading
import json
import os
import selectors
import socket
import stat
import struct
import sys


def windows_pipe(path, expected_exe):
    from ctypes import wintypes as w
    import msvcrt
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    a = ctypes.WinDLL('advapi32', use_last_error=True)
    def api(lib, name, restype, *argtypes):
        fn = getattr(lib, name); fn.restype = restype; fn.argtypes = argtypes
        return fn
    class Overlapped(ctypes.Structure):
        _fields_ = [('Internal', ctypes.c_size_t), ('InternalHigh', ctypes.c_size_t),
                    ('Offset', w.DWORD), ('OffsetHigh', w.DWORD), ('hEvent', w.HANDLE)]
    create = api(k, 'CreateFileW', w.HANDLE, w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p, w.DWORD, w.DWORD, w.HANDLE)
    close = api(k, 'CloseHandle', w.BOOL, w.HANDLE)
    server_pid = api(k, 'GetNamedPipeServerProcessId', w.BOOL, w.HANDLE, ctypes.POINTER(w.ULONG))
    open_process = api(k, 'OpenProcess', w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
    current = api(k, 'GetCurrentProcess', w.HANDLE)
    executable = api(k, 'QueryFullProcessImageNameW', w.BOOL, w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD))
    open_token = api(a, 'OpenProcessToken', w.BOOL, w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE))
    token_info = api(a, 'GetTokenInformation', w.BOOL, w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD))
    equal_sid = api(a, 'EqualSid', w.BOOL, ctypes.c_void_p, ctypes.c_void_p)
    read = api(k, 'ReadFile', w.BOOL, w.HANDLE, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.POINTER(Overlapped))
    write = api(k, 'WriteFile', w.BOOL, w.HANDLE, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.POINTER(Overlapped))
    create_event = api(k, 'CreateEventW', w.HANDLE, ctypes.c_void_p, w.BOOL, w.BOOL, w.LPCWSTR)
    result = api(k, 'GetOverlappedResult', w.BOOL, w.HANDLE, ctypes.POINTER(Overlapped), ctypes.POINTER(w.DWORD), w.BOOL)
    def user(process):
        token = w.HANDLE()
        if not open_token(process, 8, ctypes.byref(token)): raise RuntimeError('cannot-read-peer-token')
        try:
            size = w.DWORD(); token_info(token, 1, None, 0, ctypes.byref(size))
            if not size.value: raise RuntimeError('invalid-peer-token')
            buf = ctypes.create_string_buffer(size.value)
            if not token_info(token, 1, buf, size, ctypes.byref(size)): raise RuntimeError('cannot-read-peer-token')
            return buf
        finally: close(token)
    if not path.lower().startswith('\\\\.\\pipe\\'): raise RuntimeError('not-a-local-named-pipe')
    # Identification-only security context prevents the server impersonating this client.
    # Independent overlapped operations allow writes while the reader waits for input.
    handle = create(path, 0xc0000000, 0, None, 3, 0x00110000 | 0x40000000, None)
    if handle == ctypes.c_void_p(-1).value: raise RuntimeError('pipe-unavailable')
    def transfer(operation, buf, size):
        pending = Overlapped()
        pending.hEvent = create_event(None, True, False, None)
        if not pending.hEvent: raise RuntimeError('cannot-create-pipe-event')
        try:
            count = w.DWORD()
            if not operation(handle, buf, size, ctypes.byref(count), ctypes.byref(pending)):
                if ctypes.get_last_error() != 997: return 0  # ERROR_IO_PENDING
                if not result(handle, ctypes.byref(pending), ctypes.byref(count), True): return 0
            return count.value
        finally: close(pending.hEvent)
    try:
        pid = w.ULONG()
        if not server_pid(handle, ctypes.byref(pid)): raise RuntimeError('cannot-identify-pipe-server')
        process = open_process(0x1000, False, pid.value)
        if not process: raise RuntimeError('cannot-inspect-pipe-server')
        try:
            size = w.DWORD(32768); name = ctypes.create_unicode_buffer(size.value)
            if not executable(process, 0, name, ctypes.byref(size)): raise RuntimeError('cannot-inspect-peer-executable')
            peer, own = user(process), user(current())
            if not equal_sid(ctypes.cast(peer, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.cast(own, ctypes.POINTER(ctypes.c_void_p))[0]): raise RuntimeError('unexpected-pipe-user')
            if os.path.normcase(os.path.realpath(name.value)) != os.path.normcase(os.path.realpath(expected_exe)): raise RuntimeError('unexpected-pipe-executable')
        finally: close(process)
        for fd in (0, 1): msvcrt.setmode(fd, os.O_BINARY)
        print(json.dumps({'type': 'ready', 'pid': pid.value}), file=sys.stderr, flush=True)
        def downlink():
            buf = ctypes.create_string_buffer(65536)
            while True:
                count = transfer(read, buf, len(buf))
                if not count: break
                data = memoryview(buf.raw)[:count]
                while data: data = data[os.write(1, data):]
            os._exit(0)
        threading.Thread(target=downlink, daemon=True).start()
        while True:
            data = os.read(0, 65536)
            if not data: return
            while data:
                buf = ctypes.create_string_buffer(data)
                count = transfer(write, buf, len(data))
                if not count: return
                data = data[count:]
    finally: close(handle)


def verified_executable(peer_exe, expected_exe, pid):
    expected = os.path.realpath(expected_exe)
    if os.path.realpath(peer_exe) == expected:
        return True
    # Linux package upgrades unlink the running inode. Accept only the same
    # root-installed path, with both binaries and every parent still protected.
    # User-owned/replaced executables do not get this exception.
    if sys.platform != 'linux' or not peer_exe.endswith(' (deleted)'):
        return False
    if os.path.realpath(peer_exe[:-10]) != expected:
        return False
    try:
        for binary in [expected, f'/proc/{pid}/exe']:
            info = os.stat(binary)
            if info.st_uid != 0 or info.st_mode & 0o022 or not stat.S_ISREG(info.st_mode):
                return False
        directory = os.path.dirname(expected)
        while True:
            info = os.stat(directory)
            if info.st_uid != 0 or info.st_mode & 0o022 or not stat.S_ISDIR(info.st_mode):
                return False
            if directory == os.path.dirname(directory):
                return True
            directory = os.path.dirname(directory)
    except OSError:
        return False


def main():
    path, expected_exe = sys.argv[1:3]
    if sys.platform == 'win32':
        return windows_pipe(path, expected_exe)
    uid = os.getuid()
    directory_modes = {0o700, 0o755} if sys.argv[3:] == ['--app-tools'] else {0o700}
    for candidate, modes in [(os.path.dirname(path), directory_modes), (path, {0o600})]:
        info = os.lstat(candidate)
        if info.st_uid != uid or stat.S_IMODE(info.st_mode) not in modes or stat.S_ISLNK(info.st_mode):
            raise RuntimeError('unsafe-socket-permissions')
    if not stat.S_ISSOCK(os.lstat(path).st_mode): raise RuntimeError('not-a-socket')
    connect_path = path
    limit = 103 if sys.platform == 'darwin' else 107
    if len(path.encode()) > limit:
        original = os.path.realpath(os.path.dirname(path))
        base = '/tmp/codex-ipc-' + str(uid)
        info = os.lstat(base)
        if info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700 or not stat.S_ISDIR(info.st_mode): raise RuntimeError('unsafe-short-socket-directory')
        alias = os.path.join(base, hashlib.sha256(original.encode()).hexdigest())
        if os.lstat(alias).st_uid != uid or os.path.realpath(alias) != original: raise RuntimeError('unsafe-short-socket-alias')
        connect_path = os.path.join(alias, os.path.basename(path))
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(5); sock.connect(connect_path)
    if sys.platform == 'darwin':
        libc = ctypes.CDLL(None, use_errno=True)
        getpeereid = libc.getpeereid
        getpeereid.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
        peer_uid, peer_gid = ctypes.c_uint(), ctypes.c_uint()
        if getpeereid(sock.fileno(), ctypes.byref(peer_uid), ctypes.byref(peer_gid)): raise RuntimeError('cannot-read-peer-identity')
        peer_uid = peer_uid.value
        pid = struct.unpack('i', sock.getsockopt(0, 2, 4))[0]  # SOL_LOCAL / LOCAL_PEERPID
        proc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        proc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        buf = ctypes.create_string_buffer(4096)
        if proc.proc_pidpath(pid, buf, len(buf)) <= 0: raise RuntimeError('cannot-read-peer-executable')
        peer_exe = buf.value.decode()
    else:
        pid, peer_uid, _ = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        peer_exe = os.readlink(f'/proc/{pid}/exe')
    if peer_uid != uid or not verified_executable(peer_exe, expected_exe, pid): raise RuntimeError('unexpected-socket-peer')
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
