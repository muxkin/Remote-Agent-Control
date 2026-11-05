import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { base64, unbase64, createIdentity, identityKey, type Identity } from '../shared/secure-channel.js';
import { platformRuntime, type PlatformRuntime } from './platform.js';

export async function hostIdentity(
  directory: string,
  runtime: PlatformRuntime = platformRuntime(),
): Promise<Identity> {
  runtime.privateDirectory(directory);
  const path = join(directory, 'device-identity-v2.json');
  try {
    runtime.privateFile(path);
    const value = JSON.parse(await readFile(path, 'utf8'));
    const identity = { peerId: value.peerId, privateKey: unbase64(value.privateKey) };
    identityKey(identity);
    return identity;
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  const identity = await createIdentity();
  try {
    await writeFile(
      path,
      JSON.stringify({ peerId: identity.peerId, privateKey: base64(identity.privateKey) }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error: any) {
    if (error.code === 'EEXIST') return hostIdentity(directory, runtime);
    throw error;
  }
  return identity;
}
