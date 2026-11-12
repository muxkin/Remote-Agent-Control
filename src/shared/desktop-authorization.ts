import { z } from 'zod';
import { hostIdSchema } from './relay-protocol.js';

export const desktopAuthorizationLifetime = 5 * 60_000;
export const desktopTicketSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const desktopAuthorizationSchema = z
  .object({
    hostId: hostIdSchema,
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[^\u0000-\u001f\u007f]+$/u),
    ticket: desktopTicketSchema,
    issuedAt: z.number().int().positive(),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();

export type DesktopAuthorization = z.infer<typeof desktopAuthorizationSchema>;
export const desktopAuthorizationProof = (
  origin: string,
  { hostId, name, ticket, issuedAt }: Omit<DesktopAuthorization, 'signature'>,
) =>
  new TextEncoder().encode(
    `codex-pocket/desktop-enrollment/1\n${origin}\n${hostId}\n${name}\n${ticket}\n${issuedAt}`,
  );

export interface AccountDesktop {
  hostId: string;
  name: string;
}
