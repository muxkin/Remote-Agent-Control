/** Package the selected artwork without redrawing it. Requires ImageMagick 7. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const source = 'assets/branding/agent-space-master.png';
for (const size of [32, 180, 192, 512])
  execFileSync('magick', [
    source,
    '-resize',
    `${size}x${size}`,
    '-strip',
    `src/web/public/app-icon-${size}.png`,
  ]);
execFileSync('magick', [
  source,
  '-define',
  'icon:auto-resize=256,128,64,48,32,16',
  'assets/branding/agent-space.ico',
]);
// PNG-backed ICNS representations supported by modern macOS.
const chunks = [];
for (const [type, size] of [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
]) {
  const png = execFileSync('magick', [source, '-resize', `${size}x${size}`, '-strip', 'png:-'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32BE(png.length + 8, 4);
  chunks.push(header, png);
}
const header = Buffer.alloc(8);
header.write('icns');
header.writeUInt32BE(8 + chunks.reduce((n, b) => n + b.length, 0), 4);
writeFileSync('assets/branding/agent-space.icns', Buffer.concat([header, ...chunks]));
console.log(`Packaged icon assets from ${source}`);
