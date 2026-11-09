import { remarkUserBreaks } from '../shared/remark-user-breaks';
import './code-block.css';
import { remarkChemicalFormulas } from '../shared/chemical-formulas';
import './math-typography.css';
import { markdownSource } from '../shared/markdown-source';
import { browserId } from './browser-id';
import { Icon } from './Icon';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DOMPurify from 'dompurify';
import { attachmentInfo, localReference, remarkFileCitations } from '../shared/attachments';
import { FileAttachment as LocalLink } from './FileAttachment';
import { Media } from './MediaAttachment';
import { useVisible } from './useVisible';
import { useAppearance } from './theme/store';
import { selectedTheme, themeTokens } from './theme/palette';

const htmlCache = new Map<string, string>();
function CodeBlock({ text, language, streaming }: { text: string; language: string; streaming: boolean }) {
  const { settings, resolved } = useAppearance();
  const diagramPalette = useMemo(
    () => (language === 'mermaid' ? themeTokens(selectedTheme(settings, resolved)) : null),
    [language, settings, resolved],
  );
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const { ref, visible } = useVisible();
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setHtml('');
    setError('');
    if (!visible || streaming || !language) return;
    const key = language + (diagramPalette ? JSON.stringify(diagramPalette) : '') + '\n' + text;
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
            theme: 'base',
            themeVariables: {
              darkMode: resolved === 'dark',
              background: diagramPalette!['--surface'],
              primaryColor: diagramPalette!['--soft'],
              primaryTextColor: diagramPalette!['--on-soft'],
              primaryBorderColor: diagramPalette!['--outline'],
              lineColor: diagramPalette!['--muted'],
              textColor: diagramPalette!['--ink'],
              secondaryColor: diagramPalette!['--surface-hover'],
              tertiaryColor: diagramPalette!['--surface-active'],
            },
          });
          result = DOMPurify.sanitize((await mermaid.render(`diagram-${browserId()}`, text)).svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
          });
        } else {
          const shiki = await import('shiki/bundle/web');
          if (!(language in shiki.bundledLanguages)) return;
          const { createJavaScriptRegexEngine } = await import('shiki/engine/javascript');
          const highlighter = await shiki.createHighlighter({
            langs: [language as any],
            themes: ['github-light', 'github-dark'],
            engine: createJavaScriptRegexEngine(),
          });
          try {
            result = DOMPurify.sanitize(
              highlighter.codeToHtml(text, {
                lang: language,
                themes: { light: 'github-light', dark: 'github-dark' },
              }),
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
  }, [text, language, streaming, visible, diagramPalette]);
  return (
    <div
      ref={ref}
      className={`code-block ${language === 'mermaid' ? 'diagram' : ''} ${wrap ? 'code-wrap' : ''}`}
    >
      <div className="code-toolbar">
        <span className="code-language">
          <Icon name="code" size={15} />
          {language || '纯文本'}
        </span>
        <span className="code-line-count">{text.split('\n').length} 行</span>
        <div className="code-actions">
          {language !== 'mermaid' && (
            <button
              type="button"
              aria-label="代码自动换行"
              aria-pressed={wrap}
              onClick={() => setWrap(!wrap)}
            >
              换行
            </button>
          )}
          <button
            type="button"
            aria-label={copied ? '代码已复制' : '复制代码'}
            onClick={() => {
              void (async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  setCopied(true);
                  setError('');
                  clearTimeout(copyTimer.current);
                  copyTimer.current = setTimeout(() => setCopied(false), 2000);
                } catch {
                  setError('请选中代码手动复制');
                }
              })();
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>
      <div className="code-content" tabIndex={0} role="region" aria-label="代码内容">
        {html && !streaming ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>
            <code>{text}</code>
          </pre>
        )}
      </div>
      {error && (
        <div className="code-copy-status" role="status">
          {error}
        </div>
      )}
    </div>
  );
}
export { Media } from './MediaAttachment';
export { FileAttachment as LocalLink } from './FileAttachment';
export default memo(function RichMessage({
  text,
  threadId,
  streaming = false,
  preserveLineBreaks = false,
}: {
  text: string;
  threadId: string;
  streaming?: boolean;
  preserveLineBreaks?: boolean;
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
        const declared = /language-(\S+)/.exec(className ?? '')?.[1] ?? '';
        const language =
          declared ||
          (value.includes('\n') && /^\s*(?:curl\s|#!.*\b(?:bash|sh)\b)/.test(value) ? 'bash' : '');
        return language || value.includes('\n') ? (
          <CodeBlock text={value.replace(/\n$/, '')} language={language} streaming={streaming} />
        ) : (
          <code>{children}</code>
        );
      },
      img: ({ src, alt }) => (
        <Media src={typeof src === 'string' ? src : ''} label={alt ?? '图片'} threadId={threadId} />
      ),
      a: ({ href, children, node }) => {
        // Linked Markdown images still open the preview, without nested interactive controls.
        if (node?.children.some((child) => child.type === 'element' && child.tagName === 'img'))
          return <>{children}</>;
        if (!href) return <span>{children}</span>;
        if (/\.(mp4|webm|mov|m4v|mp3|wav|m4a|ogg|flac)(?:[?#]|$)/i.test(href))
          return <Media src={href} label={String(children)} threadId={threadId} />;
        return localReference(href) ? (
          <LocalLink href={href} threadId={threadId} card={!!node?.properties['data-file-citation']}>
            {children}
          </LocalLink>
        ) : (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
      p: ({ children, node }) => {
        const elements = node?.children.filter((child) => child.type !== 'text' || child.value.trim());
        const link = elements?.length === 1 ? elements[0] : undefined;
        if (link?.type === 'element' && link.tagName === 'a') {
          const href = link.properties.href;
          if (typeof href === 'string' && localReference(href) && attachmentInfo(href).media === 'image') {
            const label = link.children
              .map((child) => (child.type === 'text' ? child.value : ''))
              .join('')
              .trim();
            return (
              <div className="markdown-paragraph">
                <Media
                  src={href}
                  label={label || attachmentInfo(href).name}
                  threadId={threadId}
                  mediaType="image"
                />
              </div>
            );
          }
        }
        return <div className="markdown-paragraph">{children}</div>;
      },
    }),
    [threadId, streaming],
  );
  const source = markdownSource(text);
  return (
    <div
      className="markdown"
      onClick={math ? (event) => math.copyFormulaFromEvent(event.nativeEvent) : undefined}
      onKeyDown={math ? (event) => math.copyFormulaFromEvent(event.nativeEvent) : undefined}
    >
      <Markdown
        remarkPlugins={[
          ...(preserveLineBreaks ? [remarkUserBreaks] : []),
          ...(math
            ? [remarkFileCitations, remarkGfm, remarkChemicalFormulas, math.remarkMath]
            : [remarkFileCitations, remarkGfm, remarkChemicalFormulas]),
        ]}
        rehypePlugins={
          math
            ? [
                [math.rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false }],
                math.rehypeMathCopy,
              ]
            : []
        }
        urlTransform={(url) => (localReference(url) ? url : defaultUrlTransform(url))}
        components={components}
      >
        {source}
      </Markdown>
    </div>
  );
});
