import { Buffer } from 'node:buffer';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  desktopAuthorizationLifetime,
  desktopAuthorizationProof,
  type AccountDesktop,
  type DesktopAuthorization,
} from '../shared/desktop-authorization.js';
import type { MessagingDatabase } from './messaging/database.js';

type Approval = 'ok' | 'expired' | 'invalid' | 'conflict' | 'limit';
export interface DesktopAuthorizations {
  approve(account: string, request: DesktopAuthorization): Promise<Approval>;
  list(account: string): AccountDesktop[] | Promise<AccountDesktop[]>;
  ready(account: string, hostId: string, ticket: string): boolean | Promise<boolean>;
  revoke(account: string, hostId: string): boolean | Promise<boolean>;
}

export class DesktopEnrollmentStore {
  constructor(
    private db: Pick<MessagingDatabase, 'exec' | 'prepare'>,
    private origin: string,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS desktop_enrollments (
        host TEXT PRIMARY KEY, account TEXT NOT NULL, name TEXT NOT NULL,
        ticket TEXT NOT NULL, issued INTEGER NOT NULL, revoked INTEGER
      );
      CREATE INDEX IF NOT EXISTS desktop_enrollments_owner ON desktop_enrollments(account);
    `);
  }

  status(hostId: string): boolean | undefined {
    const row = this.db.prepare('SELECT revoked FROM desktop_enrollments WHERE host=?').get(hostId);
    return row && row.revoked === null;
  }

  async approve(account: string, request: DesktopAuthorization): Promise<Approval> {
    const expires = request.issuedAt + desktopAuthorizationLifetime;
    if (expires <= Date.now() || request.issuedAt > Date.now() + 30_000) return 'expired';
    try {
      const key = peerIdFromString(request.hostId).publicKey;
      if (
        !key ||
        !(await key.verify(
          desktopAuthorizationProof(this.origin, request),
          Buffer.from(request.signature, 'base64'),
        ))
      )
        return 'invalid';
    } catch {
      return 'invalid';
    }
    if (expires <= Date.now()) return 'expired';

    // Everything below is synchronous. A host can only be claimed by one account.
    const current = this.db.prepare('SELECT * FROM desktop_enrollments WHERE host=?').get(request.hostId);
    if (current && current.account !== account) return 'conflict';
    if (current?.revoked === null && current.ticket === request.ticket) return 'ok';
    if (current && request.issuedAt <= Math.max(Number(current.issued), Number(current.revoked ?? 0)))
      return 'expired';
    if ((!current || current.revoked !== null) && this.list(account).length >= 100) return 'limit';
    this.db
      .prepare(
        `
      INSERT INTO desktop_enrollments VALUES (?,?,?,?,?,NULL)
      ON CONFLICT(host) DO UPDATE SET name=excluded.name, ticket=excluded.ticket, issued=excluded.issued,
        revoked=NULL
    `,
      )
      .run(request.hostId, account, request.name, request.ticket, request.issuedAt);
    return 'ok';
  }

  list(account: string): AccountDesktop[] {
    return this.db
      .prepare(
        `
      SELECT host, name FROM desktop_enrollments WHERE account=? AND revoked IS NULL ORDER BY issued DESC
    `,
      )
      .all(account)
      .map(({ host, name }) => ({ hostId: String(host), name: String(name) }));
  }

  ownsRequest(account: string, hostId: string, ticket: string): boolean {
    return !!this.db
      .prepare(
        `
      SELECT 1 FROM desktop_enrollments WHERE account=? AND host=? AND ticket=? AND revoked IS NULL
    `,
      )
      .get(account, hostId, ticket);
  }

  revoke(account: string, hostId: string): boolean {
    return !!this.db
      .prepare(
        `
      UPDATE desktop_enrollments SET revoked=MAX(COALESCE(revoked, 0), issued, ?)
      WHERE account=? AND host=?
    `,
      )
      .run(Date.now(), account, hostId).changes;
  }
}
