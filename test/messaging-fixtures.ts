/** Persistence business-rule fixtures use readable opaque payloads; HTTP/crypto tests use the real encrypted client. */
import { MessagingStore as ProductionStore } from '../src/server/messaging/store.js';
export class MessagingStore extends ProductionStore {
  override validateEncryption() {}
}
