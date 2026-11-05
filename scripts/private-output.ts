import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Generated local configuration and QA data exclude themselves, including this ignore file. */
export async function privateOutput(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, '.gitignore'), '*\n', { mode: 0o600 });
}
