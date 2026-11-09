/** Persistence business-rule fixtures use readable opaque payloads; HTTP/crypto tests use the real encrypted client. */
import { MessagingStore as ProductionStore } from '../src/server/messaging/store.js';
export class MessagingStore extends ProductionStore {
  override humanContacts = true; // Explicit social-mode fixtures; production defaults to Agent-only.
  override validateEncryption() {}
}
