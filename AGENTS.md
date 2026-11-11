# AGENTS.md

## Desktop adapter delivery

- Deliver and run the pure Rust desktop adapter with independent Rust Codex and DSH plugins. Desktop runtime packages must run without bundled Node or Python.
- Complete missing behavior and fix compatibility problems in the Rust implementation. Continue migration toward the existing adapter's full feature set.
- Preserve device identities, pairing records, credentials, instance configuration and attachments during migration.
- Verify the actual executable, plugin processes, application launcher and autostart entry after switching versions. A successful build or uploaded release alone does not complete a local runtime migration.

## One application, multiple deployment runtimes

- VPS/Node and Cloudflare must use the same frontend, client protocols and business logic. Do not maintain a personal-edition or Cloudflare-edition feature implementation.
- Put shared account, messaging, resource-policy and relay behavior in the common modules described in `docs/DEPLOYMENT_ARCHITECTURE.md`. Runtime-specific code is limited to entry points, I/O, storage, scheduling and platform bindings.
- Membership levels, quotas and whether an instance uses a resource provider are configuration choices, independent of deployment platform.
- Keep the shared relay contract tests enabled for both runtimes. For deployment/build changes, run `npm run check:deployments`; equal public build parameters must produce identical frontend files.
- Preserve existing deployment credentials, database identities and user data when changing adapters. A source refactor does not itself require restarting the user's personal service.

## Calcblog AI Journal

- For substantial Codex work, use `$calcblog-ai-journal` near the end of the task to append a concise sanitized log to calcblog when the skill is installed.
- Automatic logs should be short Markdown summaries of actions, verification, and blockers. Use `log --auto` so missing credentials or `CALCBLOG_AI_AUTO_LOG=0` skip cleanly.
- Use `ai-reports` only when the user asks for a report or the work naturally produces a durable report.
- Never upload secrets, tokens, private keys, cookies, raw terminal output, full diffs, or unredacted sensitive user data.
- Logging is non-blocking: do not let upload failure prevent completing the user's primary request.

如果需要制作网页预览服务，请绑定到 Tailscale 网段让 Tailscale 设备可访问。
