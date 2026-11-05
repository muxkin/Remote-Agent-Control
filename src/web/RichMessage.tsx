import { remoteFetch } from './device-session';
import { Icon } from './Icon';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DOMPurify from 'dompurify';

function useVisible() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, visible };
}
const htmlCache = new Map<string, string>();
function CodeBlock({ text, language, streaming }: { text: string; language: string; streaming: boolean }) {
  const { ref, visible } = useVisible();
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setHtml('');
    setError('');
    if (!visible || streaming || !language) return;
    const key = language + '\n' + text;
    const cached = htmlCache.get(key);
    if (cached) {
      setHtml(cached);
      return;
    }
    void (async () => {
      try {
        let result: string;
        if (language === 'mermaid') {
          const { default: mermaid } = await import('mermaid');
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            maxTextSize: 100000,
            htmlLabels: false,
            flowchart: { htmlLabels: false },
            theme: 'neutral',
          });
          result = DOMPurify.sanitize((await mermaid.render(`diagram-${crypto.randomUUID()}`, text)).svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
          });
        } else {
          const shiki = await import('shiki/bundle/web');
          if (!(language in shiki.bundledLanguages)) return;
          const { createJavaScriptRegexEngine } = await import('shiki/engine/javascript');
          const highlighter = await shiki.createHighlighter({
            langs: [language as any],
            themes: ['github-light'],
            engine: createJavaScriptRegexEngine(),
          });
          try {
            result = DOMPurify.sanitize(
              highlighter.codeToHtml(text, { lang: language, theme: 'github-light' }),
            );
          } finally {
            highlighter.dispose();
          }
        }
        if (!disposed) {
          setHtml(result);
          htmlCache.set(key, result);
          if (htmlCache.size > 64) htmlCache.delete(htmlCache.keys().next().value!);
        }
      } catch {
        if (!disposed) setError(language === 'mermaid' ? '图表暂无法解析，保留原文' : '');
      }
    })();
    return () => {
      disposed = true;
    };
  }, [text, language, streaming, visible]);
  return (
    <div ref={ref} className={`code-block ${language === 'mermaid' ? 'diagram' : ''}`}>
      <div className="code-toolbar">
        <span>{language || '代码'}</span>
        <button onClick={() => void navigator.clipboard.writeText(text)}>复制</button>
      </div>
      {html && !streaming ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{text}</code>
        </pre>
      )}
      {error && <small>{error}</small>}
    </div>
  );
}
const localReference = (url: string) =>
  (url.startsWith('/') && !url.startsWith('//')) ||
  url.startsWith('file:') ||
  url.startsWith('sandbox:') ||
  url.startsWith('./') ||
  url.startsWith('../') ||
  url.startsWith('pocket-inline:');
export function Media({ src, label, threadId }: { src: string; label: string; threadId: string }) {
  const { ref, visible } = useVisible();
  // Start external media only after visibility initialization, too. Otherwise a
  // fast failed load can be cleared by the first visibility effect.
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const expiresAt = useRef(0);
  const refreshing = useRef(false);
  const recovery = useRef<{ time: number; playing: boolean } | null>(null);
  function renew(element?: HTMLMediaElement) {
    if (refreshing.current) return;
    refreshing.current = true;
    recovery.current = element ? { time: element.currentTime, playing: !element.paused } : null;
    setError('');
    setRefresh((value) => value + 1);
  }
  function checkExpiry(element: HTMLMediaElement) {
    if (expiresAt.current && Date.now() + 10000 >= expiresAt.current) renew(element);
  }
  function failed(element?: HTMLMediaElement) {
    if (expiresAt.current && Date.now() + 10000 >= expiresAt.current) renew(element);
    else setError('附件加载失败，可重新获取访问链接');
  }
  function restore(element: HTMLMediaElement) {
    const previous = recovery.current;
    recovery.current = null;
    if (!previous) return;
    if (Number.isFinite(previous.time)) element.currentTime = previous.time;
    if (previous.playing) void element.play().catch(() => {});
  }
  useEffect(() => {
    if (!visible) return;
    if (!localReference(src)) {
      expiresAt.current = 0;
      setUrl(src);
      setError('');
      refreshing.current = false;
      return;
    }
    const controller = new AbortController();
    void remoteFetch(`/api/threads/${threadId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: src }),
      signal: controller.signal,
    })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? '附件不可用');
        expiresAt.current = body.expiresAt;
        setUrl(body.url);
        setError('');
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        refreshing.current = false;
      });
    return () => controller.abort();
  }, [src, threadId, visible, refresh]);
  const extension = src.split(/[?#]/)[0].split('.').at(-1)?.toLowerCase();
  return (
    <div className="media" ref={ref}>
      {url ? (
        ['mp4', 'webm', 'mov', 'm4v'].includes(extension ?? '') ? (
          <video
            key={`${url}:${localReference(src) ? '' : refresh}`}
            controls
            preload="metadata"
            src={url}
            aria-label={label}
            onPlay={(e) => checkExpiry(e.currentTarget)}
            onSeeking={(e) => checkExpiry(e.currentTarget)}
            onError={(e) => failed(e.currentTarget)}
            onLoadedMetadata={(e) => restore(e.currentTarget)}
          />
        ) : ['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(extension ?? '') ? (
          <audio
            key={`${url}:${localReference(src) ? '' : refresh}`}
            controls
            preload="none"
            src={url}
            aria-label={label}
            onPlay={(e) => checkExpiry(e.currentTarget)}
            onSeeking={(e) => checkExpiry(e.currentTarget)}
            onError={(e) => failed(e.currentTarget)}
            onLoadedMetadata={(e) => restore(e.currentTarget)}
          />
        ) : localReference(src) ? (
          <LocalLink href={src} threadId={threadId}>
            <img
              key={`${url}:${localReference(src) ? '' : refresh}`}
              loading="lazy"
              src={url}
              alt={label}
              referrerPolicy="no-referrer"
              onError={() => failed()}
            />
          </LocalLink>
        ) : (
          <a href={url} target="_blank" rel="noreferrer">
            <img
              key={`${url}:${localReference(src) ? '' : refresh}`}
              loading="lazy"
              src={url}
              alt={label}
              referrerPolicy="no-referrer"
              onError={() => failed()}
            />
          </a>
        )
      ) : (
        <span className="muted">{error ? '' : '正在加载附件…'}</span>
      )}
      {error && (
        <div role="alert">
          <small>{error}</small>
          <button type="button" className="secondary" onClick={() => renew()}>
            重新加载附件
          </button>
        </div>
      )}
    </div>
  );
}
export function LocalLink({
  href,
  children,
  threadId,
}: {
  href: string;
  children: React.ReactNode;
  threadId: string;
}) {
  const [error, setError] = useState('');
  async function open() {
    const tab = window.open('about:blank', '_blank');
    try {
      const response = await remoteFetch(`/api/threads/${threadId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: href }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? '文件不可用');
      if (tab) {
        tab.opener = null;
        tab.location.href = data.url;
      }
    } catch (e) {
      tab?.close();
      setError((e as Error).message);
    }
  }
  return (
    <>
      <button className="file-link" onClick={() => void open()}>
        {children}
      </button>
      {error && <small role="alert">{error}</small>}
    </>
  );
}
export default memo(function RichMessage({
  text,
  threadId,
  streaming = false,
}: {
  text: string;
  threadId: string;
  streaming?: boolean;
}) {
  const [math, setMath] = useState<typeof import('./math-plugins').default | null>(null);
  useEffect(() => {
    if (/\$|\\[[(]/.test(text)) void import('./math-plugins').then((module) => setMath(module.default));
  }, [text]);
  const components = useMemo<Components>(
    () => ({
      pre: ({ children }) => <>{children}</>,
      input: ({ checked }) => (
        <span className="task-check" role="checkbox" aria-checked={!!checked} aria-disabled="true">
          {checked && <Icon name="check" size={14} />}
        </span>
      ),
      code: ({ className, children }) => {
        const value = String(children ?? '');
        const language = /language-(\S+)/.exec(className ?? '')?.[1] ?? '';
        return language || value.includes('\n') ? (
          <CodeBlock text={value.replace(/\n$/, '')} language={language} streaming={streaming} />
        ) : (
          <code>{children}</code>
        );
      },
      img: ({ src, alt }) => (
        <Media src={typeof src === 'string' ? src : ''} label={alt ?? '图片'} threadId={threadId} />
      ),
      a: ({ href, children }) => {
        if (!href) return <span>{children}</span>;
        if (/\.(mp4|webm|mov|m4v|mp3|wav|m4a|ogg|flac)(?:[?#]|$)/i.test(href))
          return <Media src={href} label={String(children)} threadId={threadId} />;
        return localReference(href) ? (
          <LocalLink href={href} threadId={threadId}>
            {children}
          </LocalLink>
        ) : (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
      p: ({ children }) => <div className="markdown-paragraph">{children}</div>,
    }),
    [threadId, streaming],
  );
  // Codex also emits LaTeX's \(...\) and \[...\] delimiters.
  const source = text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body) => `\n$$\n${body}\n$$\n`)
            .replace(/\\\(([^\n]*?)\\\)/g, (_m, body) => `$${body}$`),
    )
    .join('');
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={math ? [remarkGfm, math.remarkMath] : [remarkGfm]}
        rehypePlugins={
          math ? [[math.rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false }]] : []
        }
        urlTransform={(url) => (localReference(url) ? url : defaultUrlTransform(url))}
        components={components}
      >
        {source}
      </Markdown>
    </div>
  );
});
