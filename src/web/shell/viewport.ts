import { useLayoutEffect } from 'react';

/** Fit the app to the visible area, including mobile browser chrome and the keyboard. */
export function useAppViewport() {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Preserve native pinch zoom rather than shrinking the interface while zoomed.
        if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
        const height = viewport?.height ?? window.innerHeight;
        document.documentElement.style.setProperty('--app-visible-height', `${height}px`);
        document.documentElement.style.setProperty('--app-visible-top', `${viewport?.offsetTop ?? 0}px`);
      });
    };
    update();
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      document.documentElement.style.removeProperty('--app-visible-height');
      document.documentElement.style.removeProperty('--app-visible-top');
    };
  }, []);
}
