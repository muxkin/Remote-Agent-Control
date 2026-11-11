import { tsxComponent } from './tsx-component';
import { type CSSProperties } from 'vue';

import { paths, type IconName } from './icon-paths';
export const Icon = tsxComponent(function Icon(_props: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return ({ name, size = 22, style }) => {
    return (
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width={name === 'more' ? 4 : 1.7}
        stroke-linecap="round"
        stroke-linejoin="round"
        style={style}
      >
        <path d={paths[name]} />
      </svg>
    );
  };
});
