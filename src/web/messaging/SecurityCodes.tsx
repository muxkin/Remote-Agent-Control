import { useEffect, useState } from 'react';
import type { ChatUser } from '../../shared/messaging';
import { fingerprint } from '../../shared/account-crypto';
import { messaging } from './context';
import { Dialog } from './ui';
export function SecurityCodes({ users, onClose }: { users: ChatUser[]; onClose: () => void }) {
  const [codes, setCodes] = useState<{ name: string; code: string }[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void Promise.all(
      users.map(async (user) => ({
        name: `${user.displayName} · ${user.id}`,
        code: (await fingerprint(await messaging.account.publicKeys(user.id))).match(/.{1,4}/g)!.join(' '),
      })),
    )
      .then((value) => {
        if (alive) setCodes(value);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [users]);
  return (
    <Dialog title="加密安全码" onClose={onClose}>
      <p>
        通过见面或其他可信渠道，与对方账户中显示的安全码核对。首次联系时的公钥来自服务器；核对可防止身份被替换。
      </p>
      {codes.map((value) => (
        <div key={value.name}>
          <strong>{value.name}</strong>
          <p style={{ overflowWrap: 'anywhere', fontFamily: 'monospace' }}>{value.code}</p>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
