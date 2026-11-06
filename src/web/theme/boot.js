// Runs before stylesheets/React. The palette engine refreshes this validated paint cache.
(() => {
  try {
    const data = JSON.parse(localStorage.getItem('pocket-appearance-v1') || 'null');
    if (!data || data.version !== 1) return;
    const mode =
      data.mode === 'dark' || data.mode === 'light'
        ? data.mode
        : matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    const colors = data.paint && data.paint[mode];
    if (!colors || typeof colors !== 'object') return;
    for (const [key, value] of Object.entries(colors).slice(0, 40)) {
      if (/^--[a-z-]{1,30}$/.test(key) && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value))
        document.documentElement.style.setProperty(key, value);
    }
    document.documentElement.dataset.colorMode = mode;
    document.documentElement.style.colorScheme = mode;
    if (/^#[0-9a-f]{6}$/i.test(colors['--surface']))
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors['--surface']);
  } catch {
    /* Unavailable or stale storage must not prevent opening the app. */
  }
})();
