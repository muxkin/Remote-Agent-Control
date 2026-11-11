import type { Config } from './config.js';
import { desktopPairingImage, desktopPairingLink } from './pairing-display.js';
import type { Store } from './store.js';

/** Owns only tickets minted by this manager. CLI tickets and paired devices are independent. */
export class DesktopPairing {
  private ticket?: { code: string; expiresAt: number };

  constructor(
    private config: Pick<Config, 'origin' | 'stateDir'>,
    private store: Store,
    private announce: () => void,
  ) {}

  get status() {
    const ticket = this.ticket;
    if (!ticket) return null;
    return {
      expiresAt: ticket.expiresAt,
      state:
        Date.now() >= ticket.expiresAt
          ? 'expired'
          : this.store.pairingPending(ticket.code)
            ? 'ready'
            : 'used',
    };
  }

  create(format?: 'image'): Promise<{ image: string; expiresAt: number }>;
  create(format: 'link'): Promise<{ link: string; expiresAt: number }>;
  async create(format: 'image' | 'link' = 'image') {
    this.discard();
    const ticket = (this.ticket = this.store.mintPairing());
    try {
      const value =
        format === 'image'
          ? { image: await desktopPairingImage(this.config, ticket.code) }
          : { link: await desktopPairingLink(this.config, ticket.code) };
      if (this.ticket !== ticket) throw Error('二维码已失效，请重新生成');
      this.announce();
      return { ...value, expiresAt: ticket.expiresAt };
    } catch (error) {
      if (this.ticket === ticket) this.discard();
      throw error;
    }
  }

  discard() {
    if (!this.ticket) return;
    this.store.discardPairing(this.ticket.code);
    this.ticket = undefined;
    this.announce();
  }
}
