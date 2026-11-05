import { z } from 'zod';
export const hostIdSchema = z.string().regex(/^12D3KooW[1-9A-HJ-NP-Za-km-z]{40,60}$/);
export const laneSchema = z.enum(['control', 'bulk']);
export const routeSchema = z
  .object({
    ticket: z.string().regex(/^[a-zA-Z0-9_-]{32,128}$/),
    expires: z.number().int().positive(),
    peerId: hostIdSchema.optional(),
  })
  .strict();
export type RelayRoute = z.infer<typeof routeSchema>;
export function relayFrame(id: string, bytes: Uint8Array): Uint8Array {
  if (!z.string().uuid().safeParse(id).success) throw Error('Invalid relay stream');
  const frame = new Uint8Array(36 + bytes.length);
  frame.set(new TextEncoder().encode(id));
  frame.set(bytes, 36);
  return frame;
}
export function readRelayFrame(bytes: Uint8Array) {
  if (bytes.length <= 36 || bytes.length > 65536 + 36) throw Error('Invalid relay frame');
  const id = new TextDecoder().decode(bytes.subarray(0, 36));
  if (!z.string().uuid().safeParse(id).success) throw Error('Invalid relay stream');
  return { id, bytes: bytes.subarray(36) };
}
export const hostProof = (challenge: string, hostId: string, lane: string) =>
  new TextEncoder().encode(`codex-pocket/2/relay-host\n${challenge}\n${hostId}\n${lane}`);
