import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.skipIf(process.platform === 'win32')(
  'retains strict executable verification across protected Linux package updates',
  () => {
    const output = execFileSync(
      process.env.POCKET_PYTHON ?? 'python3',
      [
        '-I',
        '-B',
        '-c',
        `
import importlib.util, os, stat
from types import SimpleNamespace
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('bridge', 'packages/adapter-codex/src/peer-bridge.py')
bridge = importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
expected = '/usr/lib/example/Agent'
def info(path):
    return SimpleNamespace(st_uid=0, st_mode=(stat.S_IFREG | 0o755) if path in [expected, '/proc/42/exe'] else (stat.S_IFDIR | 0o755))
with patch.object(bridge.sys, 'platform', 'linux'), patch.object(bridge.os.path, 'realpath', side_effect=lambda p: p), patch.object(bridge.os, 'stat', side_effect=info):
    assert bridge.verified_executable(expected, expected, 42)
    assert bridge.verified_executable(expected + ' (deleted)', expected, 42)
    assert not bridge.verified_executable('/tmp/Agent (deleted)', expected, 42)
    for bad_path in [expected, '/proc/42/exe', '/usr/lib/example']:
        for bad_uid, extra_mode in [(1000, 0), (0, 0o002), (0, 0o020)]:
            def bad_info(path):
                value = info(path)
                return SimpleNamespace(st_uid=bad_uid, st_mode=value.st_mode | extra_mode) if path == bad_path else value
            with patch.object(bridge.os, 'stat', side_effect=bad_info):
                assert not bridge.verified_executable(expected + ' (deleted)', expected, 42)
    with patch.object(bridge.sys, 'platform', 'darwin'):
        assert not bridge.verified_executable(expected + ' (deleted)', expected, 42)
print('verified')
`,
      ],
      { encoding: 'utf8' },
    );
    expect(output.trim()).toBe('verified');
  },
);
