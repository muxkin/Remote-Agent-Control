import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import './scripts/env.mjs';
import { assetSettings } from './src/shared/assets';
export default defineConfig(() => {
  const env = process.env;
  const assets = assetSettings(env.POCKET_ASSET_BASE);
  const hash = createHash('sha256').update(assets.base);
  const addFiles = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) addFiles(path);
      else hash.update(path).update(readFileSync(path));
    }
  };
  addFiles('src/web');
  addFiles('src/shared');
  addFiles('packages/adapter-sdk/src');
  hash.update(readFileSync('package-lock.json')).update(readFileSync('vite.config.ts'));
  const buildId = hash.digest('hex').slice(0, 16);
  const themeBoot = readFileSync('src/web/theme/boot.js', 'utf8');
  const themeBootFile = `assets/theme-boot-${createHash('sha256').update(themeBoot).digest('hex').slice(0, 12)}.js`;
  return {
    define: { __POCKET_WEB_BUILD_ID__: JSON.stringify(buildId) },
    root: 'src/web',
    base: assets.base,
    build: { outDir: '../../dist/web', emptyOutDir: true },
    plugins: [
      {
        name: 'theme-prepaint',
        transformIndexHtml: {
          order: 'post',
          handler(html, context) {
            // A classic, blocking script paints saved colors before the CSS/React bundles.
            // Its content hash also makes it safe for the existing immutable asset CDN.
            const src = context.server ? '/theme/boot.js' : `${assets.base}${themeBootFile}`;
            return html.replace('</title>', `</title>\n    <script src="${src}"></script>`);
          },
        },
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: themeBootFile, source: themeBoot });
        },
      },
      {
        name: 'asset-origin',
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId }) });
          this.emitFile({ type: 'asset', fileName: 'asset-origin.json', source: JSON.stringify(assets) });
        },
      },
    ],
  };
});
