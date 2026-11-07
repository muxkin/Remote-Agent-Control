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
  addFiles('src/client');
  addFiles('src/shared');
  addFiles('packages/adapter-sdk/src');
  hash.update(readFileSync('package-lock.json')).update(readFileSync('vite.config.ts'));
  const buildId = hash.digest('hex').slice(0, 16);
  const themeBoot = readFileSync('src/web/theme/boot.js', 'utf8');
  const startup = readFileSync('src/web/startup.js', 'utf8');
  const startupFile = `assets/startup-${createHash('sha256').update(startup).digest('hex').slice(0, 12)}.js`;
  const themeBootFile = `assets/theme-boot-${createHash('sha256').update(themeBoot).digest('hex').slice(0, 12)}.js`;
  return {
    define: { __POCKET_WEB_BUILD_ID__: JSON.stringify(buildId) },
    root: 'src/web',
    base: assets.base,
    build: {
      outDir: '../../dist/web',
      emptyOutDir: true,
      // Small math fonts must remain files: the app's font CSP intentionally excludes data: URLs.
      assetsInlineLimit: (path) => (/\.(?:woff2?|ttf|otf)$/i.test(path) ? false : undefined),
      rollupOptions: {
        output: {
          manualChunks(id) {
            // Stable foundations keep their cache across application-only releases.
            if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-vendor';
            if (id.includes('/node_modules/@material/material-color-utilities/')) return 'theme-vendor';
          },
        },
      },
    },
    plugins: [
      {
        name: 'theme-prepaint',
        transformIndexHtml: {
          order: 'post',
          handler(html, context) {
            // A classic, blocking script paints saved colors before the CSS/React bundles.
            // Keep the small boot scripts and initial stylesheet independent of CDN failures.
            const src = context.server ? '/theme/boot.js' : `/${themeBootFile}`;
            const recoverySrc = context.server ? '/startup.js' : `/${startupFile}`;
            if (!context.server && assets.origin) {
              // Public icons are shipped with the HTML, not the hashed CDN asset manifest.
              html = html.replace(`src="${assets.base}app-icon-192.png"`, 'src="/app-icon-192.png"');
              html = html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, (tag) =>
                tag.replace(/href="[^"]+"/, (href) => href.replace(assets.base, '/')),
              );
            }
            return html.replace(
              '</title>',
              `</title>\n    <script src="${src}"></script>\n    <script src="${recoverySrc}"></script>${assets.origin ? `\n    <link rel="preconnect" href="${assets.origin}" crossorigin>` : ''}`,
            );
          },
        },
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: themeBootFile, source: themeBoot });
          this.emitFile({ type: 'asset', fileName: startupFile, source: startup });
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
