import { constants } from 'node:fs';
import { mkdir, copyFile, writeFile, chmod } from 'node:fs/promises';

await mkdir('local', { recursive: true, mode: 0o700 });
await writeFile('local/.gitignore', '*\n', { mode: 0o600 });
try {
  await copyFile('.env.example', 'local/gateway.env', constants.COPYFILE_EXCL);
  await chmod('local/gateway.env', 0o600);
  console.log('Created local/gateway.env. Edit its placeholders before connecting a phone.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Kept existing local/gateway.env.');
}
