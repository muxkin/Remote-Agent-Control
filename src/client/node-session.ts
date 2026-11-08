import WebSocket from 'ws';
import { CipherWire, SecureChannel, type Identity, type Lane } from '../shared/secure-channel.js';
import { DeviceLink, type DeviceAuth } from '../shared/device-link.js';
/** Node acceptance/client adapter, sharing the exact same encrypted protocol as the PWA. */
export async function nodeSession(
  origin: string,
  hostId: string,
  identity: Identity,
  ticket: string,
  auth: DeviceAuth,
  lane: Lane = 'control',
  accountCredential?: string,
) {
  const url = new URL('/connect', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url, {
    headers: { Origin: origin },
    maxPayload: 131072,
    handshakeTimeout: 10000,
    perMessageDeflate: false,
  });
  const wire = new CipherWire(
    (bytes) =>
      new Promise<void>((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 2 * 1024 ** 2)
          return reject(Error('Relay unavailable'));
        socket.send(bytes, (error) => (error ? reject(error) : resolve()));
      }),
    () => socket.close(),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(Error('Relay join timeout'));
    }, 10000);
    socket.on('message', (raw, binary) => {
      if (binary) {
        wire.onData(new Uint8Array(raw as Buffer));
        return;
      }
      const message = JSON.parse(raw.toString());
      if (message.type === 'challenge') {
        void (async () => {
          let resourceToken: string | undefined;
          if (message.resources) {
            if (!accountCredential) throw Error('An account credential is required for metered relay');
            const response = await fetch(new URL('/api/im/resources/relay-ticket', origin), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accountCredential}` },
              body: JSON.stringify({ hostId, lane, ticket }),
            });
            const result = await response.json();
            if (!response.ok) throw Error(result.error ?? 'Relay quota unavailable');
            resourceToken = result.token;
          }
          if (socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                type: 'join',
                hostId,
                ticket,
                lane,
                ...(resourceToken ? { resourceToken } : {}),
              }),
            );
        })().catch((error) => {
          clearTimeout(timer);
          reject(error);
          socket.close();
        });
      } else if (message.type === 'joined') {
        clearTimeout(timer);
        resolve();
      }
    });
    socket.on('error', () => {
      clearTimeout(timer);
      reject(Error('Relay connection failed'));
    });
    socket.on('close', () => {
      clearTimeout(timer);
      wire.onTransportClosed();
      reject(Error('Relay closed'));
    });
  });
  return DeviceLink.authenticate(await SecureChannel.open(wire, identity, true, lane, hostId), auth);
}
