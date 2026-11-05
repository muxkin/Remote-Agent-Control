import { privateOutput } from './private-output.js';
await privateOutput('.test-output');
/** RFC 5389 binding and TURN-disabled check; never print ICE addresses or credentials. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdir, writeFile } from 'node:fs/promises';
import { readConfig } from '../src/server/config.js';
import { chromium } from '@playwright/test';
import { RTCPeerConnection } from 'werift';
const url = process.argv[2] ?? readConfig().p2p?.stunUrls[0];
const match = /^stun:([^:/]+):(\d+)$/.exec(url ?? '');
assert.ok(match, 'Pass stun:hostname:port or configure POCKET_STUN_URLS');
const host = match[1],
  port = Number(match[2]);
assert.ok(port > 0 && port < 65536);
async function exchange(type: number, attributes = Buffer.alloc(0)): Promise<Buffer | null> {
  const transaction = randomBytes(12);
  const packet = Buffer.alloc(20 + attributes.length);
  packet.writeUInt16BE(type, 0);
  packet.writeUInt16BE(attributes.length, 2);
  packet.writeUInt32BE(0x2112a442, 4);
  transaction.copy(packet, 8);
  attributes.copy(packet, 20);
  const socket = createSocket('udp4');
  const retries: NodeJS.Timeout[] = [];
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), 4000);
      socket.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      socket.on('message', (response) => {
        if (response.length < 20 || !response.subarray(8, 20).equals(transaction)) return;
        clearTimeout(timer);
        resolve(response);
      });
      socket.send(packet, port, host);
      // UDP can lose a datagram; repeat the same transaction, not a new request.
      for (const delay of [500, 1500, 3000])
        retries.push(setTimeout(() => socket.send(packet, port, host), delay));
    });
  } finally {
    retries.forEach(clearTimeout);
    socket.close();
  }
}
const start = Date.now();
const binding = await exchange(1);
const report = {
  date: new Date().toISOString(),
  endpoint: url,
  checks: {
    publicStandardBinding: binding?.readUInt16BE(0) === 0x101,
    turnAllocationDisabled: false,
    browserReflexiveCandidate: false,
    gatewayReflexiveCandidate: false,
  },
  bindingMs: Date.now() - start,
};
if (report.checks.publicStandardBinding) {
  const allocation = await exchange(3, Buffer.from([0, 0x19, 0, 4, 17, 0, 0, 0]));
  report.checks.turnAllocationDisabled = allocation === null || allocation.readUInt16BE(0) === 0x113;
  const peer = new RTCPeerConnection({ iceServers: [{ urls: url! }], iceUseIpv6: false });
  try {
    peer.createDataChannel('stun-acceptance');
    await peer.setLocalDescription(await peer.createOffer());
    report.checks.gatewayReflexiveCandidate = / typ srflx /.test(peer.localDescription!.sdp);
  } finally {
    await peer.close();
  }
  const browser = await chromium.launch({ channel: process.env.POCKET_BROWSER_CHANNEL ?? 'chrome' });
  try {
    const page = await browser.newPage();
    report.checks.browserReflexiveCandidate = await page.evaluate(async (url) => {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: url }] });
      try {
        peer.createDataChannel('stun-acceptance');
        const gathered = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 8000);
          peer.onicegatheringstatechange = () => {
            if (peer.iceGatheringState === 'complete') {
              clearTimeout(timer);
              resolve();
            }
          };
        });
        await peer.setLocalDescription(await peer.createOffer());
        await gathered;
        return / typ srflx /.test(peer.localDescription!.sdp);
      } finally {
        peer.close();
      }
    }, url!);
  } finally {
    await browser.close();
  }
}
await mkdir('.test-output', { recursive: true, mode: 0o700 });
await writeFile('.test-output/stun-results.json', JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (!Object.values(report.checks).every(Boolean)) process.exitCode = 1;
