import type { BackendIcon as IconValue } from '../shared/backends';
import { Icon } from './Icon';

export function BackendIcon({ icon }: { icon: IconValue }) {
  return (
    <span className={`backend-icon surface-icon ${icon.kind}`} aria-hidden="true">
      {icon.kind === 'image' ? (
        <img src={icon.value} alt="" draggable={false} />
      ) : icon.kind === 'emoji' ? (
        <span>{icon.value}</span>
      ) : (
        <Icon name={icon.value} size={25} />
      )}
    </span>
  );
}
