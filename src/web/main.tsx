import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from './shell/AppShell';
import './style.css';
import './mobile-design.css';
import './mobile-v2.css';
import './shell/shell.css';

const icon = document.createElement('link');
icon.rel = 'icon';
icon.type = 'image/svg+xml';
icon.href = '/icon.svg';
document.head.append(icon);
const manifest = document.createElement('link');
manifest.rel = 'manifest';
manifest.href = '/manifest.webmanifest';
document.head.append(manifest);
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});

createRoot(document.getElementById('root')!).render(<AppShell />);
