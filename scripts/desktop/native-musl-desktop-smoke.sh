#!/usr/bin/env bash
set -euo pipefail

archive=$1
image=$2
container=${POCKET_NATIVE_QA_CONTAINER:-docker}
scratch=$(mktemp -d)
cid=
cleanup() {
  if [[ -n "$cid" ]]; then "$container" rm -f "$cid" >/dev/null; fi
  rm -rf "$scratch"
}
trap cleanup EXIT

tar --zstd -xf "$archive" --strip-components=1 -C "$scratch"
cid=$("$container" run -d --network=none --volume "$scratch:/bundle:ro" "$image" sh -ec '
  export HOME=/tmp XDG_DATA_HOME=/tmp/share POCKET_NATIVE_STATE_DIR=/tmp/adapter-state
  unset DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS
  exec /bundle/agent-space-native --background
')
"$container" exec "$cid" sh -ec '
  for i in $(seq 1 30); do
    test -s /tmp/adapter-state/management.json && break
    sleep 1
  done
  export POCKET_NATIVE_STATE_DIR=/tmp/adapter-state
  /bundle/agent-space-native --print-settings > /tmp/local-link
  node --input-type=module <<\JS
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    const link = new URL((await readFile("/tmp/local-link", "utf8")).trim());
    assert.equal(link.hostname, "127.0.0.1");
    const page = await fetch(link.origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Agent 空间适配器/);
    const unauthenticated = await fetch(link.origin + "/api/status");
    assert.equal(unauthenticated.status, 401);
    const session = await fetch(link.origin + "/api/session", {
      method: "POST",
      headers: { Origin: link.origin, "Content-Type": "application/json" },
      body: JSON.stringify(link.hash.slice(1)),
    });
    assert.equal(session.status, 200);
    const { token } = await session.json();
    const status = await fetch(link.origin + "/api/status", { headers: { Authorization: "Bearer " + token } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).phase, "setup");
JS
  grep -Fx "Exec=\"/bundle/agent-space-native\"" /tmp/share/applications/org.agent-space.adapter.desktop
'
printf '%s\n' 'Static musl adapter opened browser settings in a container without a desktop session'
