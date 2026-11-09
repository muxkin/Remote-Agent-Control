import { useEffect, useState, type CSSProperties } from 'react';
import { Icon } from '../Icon';
import './donation.css';
interface SupportPlatform {
  name: string;
  creator?: string;
  url?: string;
  enabled: boolean;
}
interface WechatReward {
  recipient: string;
  qr: string;
  previewCrop?: { x: number; y: number; size: number };
}
interface SupportConfig {
  platform?: SupportPlatform;
  wechat?: WechatReward;
}
function safeURL(value: unknown, image = false): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return;
  try {
    const url = image ? new URL(value, location.origin) : new URL(value);
    if (url.username || url.password) return;
    if (image) {
      if (url.origin === location.origin && ['http:', 'https:'].includes(url.protocol)) return url.href;
    } else if (url.protocol === 'https:') return url.href;
  } catch {
    /* Never expose an invalid public configuration as a payment link. */
  }
}
function parseConfig(value: any): SupportConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
  const config: SupportConfig = {},
    p = value.platform,
    w = value.wechat;
  if (p && typeof p.name === 'string' && p.name.trim()) {
    const url = safeURL(p.url);
    config.platform = {
      name: p.name.trim().slice(0, 40),
      creator: typeof p.creator === 'string' ? p.creator.trim().slice(0, 80) : undefined,
      url,
      enabled: p.enabled === true && !!url,
    };
  }
  const qr = safeURL(w?.qr, true);
  if (qr && typeof w.recipient === 'string' && w.recipient.trim()) {
    const c = w.previewCrop;
    const crop =
      c &&
      [c.x, c.y, c.size].every(Number.isFinite) &&
      c.x >= 0 &&
      c.y >= 0 &&
      c.size >= 0.25 &&
      c.size <= 1 &&
      c.x + c.size <= 1 &&
      c.y + c.size <= 1
        ? { x: c.x, y: c.y, size: c.size }
        : undefined;
    config.wechat = { qr, recipient: w.recipient.trim().slice(0, 80), previewCrop: crop };
  }
  return config;
}
export default function DonationPage() {
  const [config, setConfig] = useState<SupportConfig>({});
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [revision, setRevision] = useState(0);
  const [imageError, setImageError] = useState(false);
  const [imageRevision, setImageRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void fetch('/support.json', { cache: 'no-cache', signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw Error();
        const next = parseConfig(await r.json());
        if (controller.signal.aborted) return;
        setConfig(next);
        setImageError(false);
        setState('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('error');
      });
    return () => controller.abort();
  }, [revision]);
  const { platform, wechat } = config;
  const crop = wechat?.previewCrop;
  const imageStyle: CSSProperties | undefined = crop
    ? {
        width: `${100 / crop.size}%`,
        left: `${(-100 * crop.x) / crop.size}%`,
        top: `${(-100 * crop.y) / crop.size}%`,
      }
    : undefined;
  const imageURL = wechat
    ? wechat.qr + (imageRevision ? `${wechat.qr.includes('?') ? '&' : '?'}retry=${imageRevision}` : '')
    : '';
  function retryImage() {
    setImageError(false);
    setImageRevision((n) => n + 1);
  }
  return (
    <div className="support-page">
      <section className="support-intro">
        <span className="support-heart">
          <Icon name="heart" size={25} />
        </span>
        <h2>支持 Agent 空间</h2>
        <p>
          如果它让你与 AI 的交流更轻松，
          <br />
          欢迎随心支持，让项目继续成长。
        </p>
      </section>
      {state === 'loading' && (
        <p className="support-notice" role="status">
          正在加载支持方式…
        </p>
      )}
      {state === 'error' && (
        <div className="support-notice" role="status">
          <p>支持方式暂时无法加载。</p>
          <button className="secondary" onClick={() => setRevision((n) => n + 1)}>
            重试
          </button>
        </div>
      )}
      {state === 'ready' && (
        <>
          {wechat && (
            <section className="reward-card" aria-labelledby="wechat-reward-title">
              <div className="reward-heading">
                <h3 id="wechat-reward-title">微信赞赏</h3>
                <span>随心支持</span>
              </div>
              {imageError ? (
                <div className="reward-image-error" role="status">
                  <Icon name="heart" size={28} />
                  <p>赞赏码暂时无法加载</p>
                  <button className="secondary" onClick={retryImage}>
                    重新加载赞赏码
                  </button>
                </div>
              ) : (
                <div className="reward-code">
                  <span className="reward-code-frame">
                    <img
                      src={imageURL}
                      alt={`${wechat.recipient}的微信赞赏码`}
                      style={imageStyle}
                      className={crop ? 'reward-code-image cropped' : 'reward-code-image'}
                      onError={() => setImageError(true)}
                    />
                  </span>
                </div>
              )}
              <p className="reward-recipient">{wechat.recipient}的赞赏码</p>
              {!imageError && (
                <p className="reward-help">
                  长按图片保存，再在微信扫一扫中
                  <br />
                  从相册选择。
                </p>
              )}
            </section>
          )}
          {platform &&
            (platform.enabled ? (
              <a
                className="support-platform-card"
                href={platform.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`前往${platform.name}（新窗口）`}
              >
                <span className="support-platform-icon">
                  <Icon name="heart" size={23} />
                </span>
                <span className="support-platform-text">
                  <strong>在{platform.name}支持</strong>
                  <small>{platform.creator ? `${platform.creator} · ` : ''}查看创作与赞助方案</small>
                </span>
                <Icon name="arrow" size={20} />
              </a>
            ) : (
              <div className="support-notice" role="status">
                {platform.name}主页正在准备中。
              </div>
            ))}
          {!wechat && !platform && (
            <p className="support-notice" role="status">
              支持方式正在准备中，谢谢你的心意。
            </p>
          )}
        </>
      )}
      <section className="support-purpose">
        <h3>每一份支持，都用在持续改进上</h3>
        <p>改进跨端体验与适配器，支持开发、测试和服务维护。</p>
        <div>
          <span>
            <Icon name="monitor" size={17} />
            跨端体验
          </span>
          <span>
            <Icon name="code" size={17} />
            持续开发
          </span>
          <span>
            <Icon name="shield" size={17} />
            服务维护
          </span>
        </div>
      </section>
      <p className="support-footnote">
        支持完全自愿，不改变现有功能或账户额度。
        <br />
        反馈和分享，同样是对项目的支持。
      </p>
    </div>
  );
}
