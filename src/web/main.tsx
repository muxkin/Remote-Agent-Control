import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from './shell/AppShell';
import './style.css';
import './mobile-design.css';
import './mobile-v2.css';
import './shell/shell.css';
import './composer-controls.css';

// Public metadata stays on the release origin, even when bundles use a CDN.
for (const [rel, href, type, sizes] of [
  ['icon', '/app-icon-32.png', 'image/png', '32x32'],
  ['apple-touch-icon', '/app-icon-180.png', 'image/png', '180x180'],
  ['manifest', '/manifest.webmanifest', 'application/manifest+json', ''],
]) {
  const link = document.createElement('link');
  Object.assign(link, { rel, href, type });
  if (sizes) link.sizes.value = sizes;
  document.head.append(link);
}
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});

createRoot(document.getElementById('root')!).render(<AppShell />);
