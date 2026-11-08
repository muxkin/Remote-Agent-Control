import type { MessagingDatabase } from './database.js';
import { SEALED_PREFIX } from '../../shared/account-crypto.js';

/** Refuse mixed data models at startup. Only the offline migration tool can convert old records. */
export function assertEncryptedDatabase(db: Pick<MessagingDatabase, 'prepare'>) {
  const account = db
    .prepare(
      'SELECT 1 FROM im_users u LEFT JOIN im_account_crypto c ON c.user_id=u.id WHERE c.user_id IS NULL LIMIT 1',
    )
    .get();
  const message = db
    .prepare('SELECT 1 FROM im_messages WHERE substr(text,1,?)<>? LIMIT 1')
    .get(SEALED_PREFIX.length, SEALED_PREFIX);
  const file = db
    .prepare(
      'SELECT 1 FROM im_files WHERE encrypted IS NULL UNION ALL SELECT 1 FROM im_stickers WHERE encrypted IS NULL LIMIT 1',
    )
    .get();
  if (account || message || file)
    throw Error(
      '账号数据需要一次性加密迁移。请停止中继，按 docs/ACCOUNT_MIGRATION.md 完成迁移后再启动；原数据未被删除。',
    );
}
