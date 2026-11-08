import type { BackendIcon as IconValue } from '../shared/backends';
import { Icon } from './Icon';
import { backendStyle } from '../shared/backend-appearance';
import codex from './assets/agents/codex.png';
import dsh from './assets/agents/dsh.svg?no-inline';
import dshDark from './assets/agents/dsh-dark.svg?no-inline';
import claude from './assets/agents/claude.svg?no-inline';
import openclaw from './assets/agents/openclaw.svg?no-inline';
const marks = {
  codex: { src: codex, icon: 'code' },
  dsh: { src: dsh, icon: 'terminal' },
  claude: { src: claude, icon: 'sun' },
  openclaw: { src: openclaw, icon: 'puzzle' },
};

export function BackendIcon({ icon, product = '' }: { icon: IconValue; product?: string }) {
  const style = backendStyle(product);
  const mark = style === 'generic' ? undefined : marks[style];
  const official = icon.kind === 'builtin' && mark?.icon === icon.value;
  return (
    <span
      className={`backend-icon surface-icon ${icon.kind}${official ? ' official' : ''}`}
      data-agent-style={style}
      aria-hidden="true"
    >
      {official ? (
        <>
          <img
            className={style === 'dsh' ? 'official-mark-light' : undefined}
            src={mark.src}
            alt=""
            draggable={false}
          />
          {style === 'dsh' && <img className="official-mark-dark" src={dshDark} alt="" draggable={false} />}
        </>
      ) : icon.kind === 'image' ? (
        <img src={icon.value} alt="" draggable={false} />
      ) : icon.kind === 'emoji' ? (
        <span>{icon.value}</span>
      ) : (
        <Icon name={icon.value} size={25} />
      )}
    </span>
  );
}
