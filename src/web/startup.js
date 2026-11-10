// Small same-origin recovery UI, independent of Vue and the asset CDN.
(() => {
  let timer;
  function install() {
    const root = document.getElementById('app-startup');
    if (!root) return;
    const status = root.querySelector('[data-startup-status]');
    const retry = root.querySelector('button');
    const show = () => {
      status.textContent = navigator.onLine
        ? '启动资源加载较慢，可以重新加载后再试。'
        : '当前离线，联网后可以重新加载。';
      retry.hidden = false;
    };
    retry.addEventListener('click', () => location.reload());
    timer = setTimeout(show, 8000);
    window.addEventListener('offline', show);
    window.addEventListener('online', show);
    const ready = () => {
      clearTimeout(timer);
      window.removeEventListener('offline', show);
      window.removeEventListener('online', show);
    };
    window.addEventListener('pocket:app-ready', ready, { once: true });
    if (!navigator.onLine) show();
  }
  if (document.readyState === 'loading')
    document.addEventListener('readystatechange', function check() {
      if (document.readyState !== 'loading') {
        document.removeEventListener('readystatechange', check);
        install();
      }
    });
  else install();
})();
