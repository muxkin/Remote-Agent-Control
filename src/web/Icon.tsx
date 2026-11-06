import type { CSSProperties } from 'react';
const paths = {
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5',
  moon: 'M20.9 13a9 9 0 1 1-9.9-9.9A7 7 0 0 0 20.9 13Z',
  palette:
    'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.4-3.4 1.5 1.5 0 0 1 1.1-2.6H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9ZM7 10h.01M10 6.5h.01M15 7h.01M17.5 11h.01',
  upload: 'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5',
  copy: 'M9 9h11v12H9V9ZM5 15H3V3h11v2',
  document: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8M8 17h6',
  shield: 'M12 3 3 6v5c0 5 4 8 9 10 5-2 9-5 9-10V6l-9-3Zm-4 9 3 3 5-6',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 4h.01',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  chat: 'M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0Z',
  user: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 21v-2a8 8 0 0 1 16 0v2',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',

  back: 'm14 5-7 7 7 7',
  chevron: 'm9 5 7 7-7 7',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  refresh:
    'M3 12a9 9 0 0 1 9-9c2.5 0 4.8 1 6.5 2.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9c-2.5 0-4.8-1-6.5-2.7L3 16M3 21v-5h5',
  stack: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  attach: 'm9 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9M8 14l6-6',
  send: 'm4 3 17 9-17 9 3-9-3-9Zm3 9h14',
  monitor: 'M3 4h18v13H3V4Zm5 17h8m-4-4v4',
  close: 'm6 6 12 12M6 18 18 6',
  stop: 'M6 6h12v12H6z',
  check: 'm5 12 4 4L19 6',
  plus: 'M12 5v14M5 12h14',
  plusCircle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 8v8M8 12h8',
  up: 'M12 19V5m-6 6 6-6 6 6',
  pause: 'M9 5v14M15 5v14',
  down: 'm6 9 6 6 6-6',
  grid: 'M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h6v6h-6z',
  folder: 'M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z',
  book: 'M12 6C9 3 5 3 2 4v15c4-1 7-1 10 2 3-3 6-3 10-2V4c-3-1-7-1-10 2Zm0 0v15',
  puzzle: 'M4 4h5a3 3 0 1 1 6 0h5v5a3 3 0 1 0 0 6v5h-5a3 3 0 1 0-6 0H4v-5a3 3 0 1 1 0-6V4Z',
  plan: 'M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 9 3 3 5-6',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM16 16l5 5',
  sliders:
    'M3 6h3m4 0h11M3 12h11m4 0h3M3 18h5m4 0h9M8 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM16 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM10 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 11v6M12 7h.01',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l4 2',
} as const;
export function Icon({
  name,
  size = 22,
  style,
}: {
  name: keyof typeof paths;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 4 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
