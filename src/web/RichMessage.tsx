import { h, shallowRef } from 'vue';
import { tsxComponent } from './tsx-component';
import { memoizeRender, watchRender, writeRef } from './render-effects';
import { remarkUserBreaks } from '../shared/remark-user-breaks';
import './code-block.css';
import { remarkChemicalFormulas } from '../shared/chemical-formulas';
import './math-typography.css';
import { markdownSource } from '../shared/markdown-source';
import { browserId } from './browser-id';
import { Icon } from './Icon';
import { defaultUrlTransform, renderMarkdown, type MarkdownComponents } from './markdown';
import remarkGfm from 'remark-gfm';
import DOMPurify from 'dompurify';
import { attachmentInfo, localReference, remarkFileCitations } from '../shared/attachments';
import { FileAttachment as LocalLink } from './FileAttachment';
import { Media } from './MediaAttachment';
import { useVisible } from './useVisible';
import { useAppearance } from './theme/use-appearance';
import { selectedTheme, themeTokens } from './theme/palette';

const htmlCache = new Map<string, string>();
const CodeBlock = tsxComponent(function CodeBlock(_props: {
  text: string;
  language: string;
  streaming: boolean;
}) {
  const readAppearance = useAppearance();
  const readDiagramPalette = memoizeRender();
  const wrapState = shallowRef(false);
  const setWrap = writeRef(wrapState);
  const copiedState = shallowRef(false);
  const setCopied = writeRef(copiedState);
  const copyTimer: { current: ReturnType<typeof setTimeout> | undefined } = { current: undefined };
  const { ref, visible: intersectionVisible } = useVisible();
  const htmlState = shallowRef('');
  const setHtml = writeRef(htmlState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const afterRender = watchRender();
  const watchHtml = watchRender();
  return ({ text, language, streaming }) => {
    const { settings, resolved } = readAppearance.value;
    const diagramPalette = readDiagramPalette(
      () => (language === 'mermaid' ? themeTokens(selectedTheme(settings, resolved)) : null),
      [language, settings, resolved],
    );
    const wrap = wrapState.value;
    const copied = copiedState.value;

    afterRender(() => () => clearTimeout(copyTimer.current), []);
    const visible = intersectionVisible.value;
    const html = htmlState.value;
    const error = errorState.value;
    watchHtml(() => {
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
        class={`code-block ${language === 'mermaid' ? 'diagram' : ''} ${wrap ? 'code-wrap' : ''}`}
      >
        <div class="code-toolbar">
          <span class="code-language">
            <Icon name="code" size={15} />
            {language || '纯文本'}
          </span>
          <span class="code-line-count">{text.split('\n').length} 行</span>
          <div class="code-actions">
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
        <div class="code-content" tabindex={0} role="region" aria-label="代码内容">
          {html && !streaming ? (
            <div innerHTML={html} />
          ) : (
            <pre>
              <code>{text}</code>
            </pre>
          )}
        </div>
        {error && (
          <div class="code-copy-status" role="status">
            {error}
          </div>
        )}
      </div>
    );
  };
});
export { Media } from './MediaAttachment';
export { FileAttachment as LocalLink } from './FileAttachment';
export default tsxComponent(function RichMessage(_props: {
  text: string;
  threadId: string;
  streaming?: boolean;
  preserveLineBreaks?: boolean;
}) {
  const mathState = shallowRef<typeof import('./math-plugins').default | null>(null);
  const setMath = writeRef(mathState);
  const readComponents = memoizeRender();
  const watchMath = watchRender();
  return ({ text, threadId, streaming = false, preserveLineBreaks = false }) => {
    const math = mathState.value;
    watchMath(() => {
      if (/\$|\\[[(]/.test(text)) void import('./math-plugins').then((module) => setMath(module.default));
    }, [text]);
    const components = readComponents<MarkdownComponents>(
      () => ({
        pre: ({ children }) => <>{children}</>,
        input: ({ checked }) => (
          <span class="task-check" role="checkbox" aria-checked={!!checked} aria-disabled="true">
            {checked && <Icon name="check" size={14} />}
          </span>
        ),
        code: ({ class: className, children }) => {
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
              {() => <>{children}</>}
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
                <div class="markdown-paragraph">
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
          return h('div', { class: 'markdown-paragraph' }, Array.isArray(children) ? children : [children]);
        },
      }),
      [threadId, streaming],
    );
    const source = markdownSource(text);
    return (
      <div
        class="markdown"
        onClick={math ? (event) => math.copyFormulaFromEvent(event) : undefined}
        onKeydown={math ? (event) => math.copyFormulaFromEvent(event) : undefined}
      >
        {renderMarkdown(source, {
          remarkPlugins: [
            ...(preserveLineBreaks ? [remarkUserBreaks] : []),
            remarkFileCitations,
            remarkGfm,
            remarkChemicalFormulas,
            ...(math ? [math.remarkMath] : []),
          ],
          rehypePlugins: math
            ? [
                [math.rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false }],
                math.rehypeMathCopy,
              ]
            : [],
          urlTransform: (url) => (localReference(url) ? url : defaultUrlTransform(url)),
          components,
        })}
      </div>
    );
  };
});
