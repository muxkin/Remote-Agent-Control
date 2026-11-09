const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { updateURL } = require('./settings.cjs');
const preview = process.env.POCKET_DESKTOP_PREVIEW === '1';
const feed = preview ? null : updateURL(process.env.POCKET_DESKTOP_BUILD_FEED || '');
module.exports = {
  appId: 'org.agent-space.adapter',
  productName: 'Agent Space Adapter',
  directories: { output: '../dist/desktop', buildResources: '../assets/branding' },
  files: ['*.cjs', '*.html', '*.css', '*.js', 'release.json', 'package.json'],
  extraResources: [
    { from: '../dist/desktop-payload', to: 'gateway' },
    // The resource copier skips node_modules at the root of each source directory.
    { from: '../dist/desktop-payload/node_modules', to: 'gateway/node_modules' },
  ],
  afterPack({ appOutDir, packager }) {
    const gateway = join(packager.getResourcesDir(appOutDir), 'gateway');
    const { dependencies } = JSON.parse(readFileSync(join(gateway, 'package.json'), 'utf8'));
    for (const name of Object.keys(dependencies))
      if (!existsSync(join(gateway, 'node_modules', name, 'package.json')))
        throw Error(`Packaged gateway is missing runtime dependency ${name}`);
  },
  publish: feed ? [{ provider: 'generic', url: feed }] : null,
  artifactName: 'AgentSpace-${version}-${os}-${arch}.${ext}',
  win: { target: ['nsis'], signAndEditExecutable: true },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
  },
  mac: { target: ['dmg', 'zip'], category: 'public.app-category.developer-tools', hardenedRuntime: true },
  linux: {
    target: ['AppImage'],
    category: 'Utility',
    icon: '../src/web/public/app-icon-512.png',
    syncDesktopName: true,
  },
};
