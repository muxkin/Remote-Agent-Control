# Codex adapter 1.0.1

Connects to an existing Codex desktop through verified Unix sockets (Linux/macOS) or named pipes (Windows). Includes the Python byte bridge and product-specific history, follower controls, permissions, model, skill and native plugin catalogs. It never launches or terminates Codex.

Configuration keys: `home`, `root`, `socket`, `executable`, `appTools`, `python`. Unset values use native discovery. Ambiguous verified endpoints require explicit selection. Product version is diagnostic only. Python 3 is required on the host. Linux has real desktop validation; macOS/Windows have connector contract tests and remain experimental pending real desktop acceptance.

New conversations inherit the native creation permissions. Existing conversation permissions use follower settings and native-state confirmation. This package does not modify global Codex defaults.

Install a release tarball with the gateway's `adapter install` command; bind/upgrade instances explicitly. Package dependencies and the private state format are versioned independently of the gateway. Contract tests live in this package's source `test/` directory.
