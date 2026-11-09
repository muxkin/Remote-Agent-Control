import type { MemoryCitationEntry, Message } from './types.js';

const memoryOpen = '<oai-mem-citation>';
const memoryClose = '</oai-mem-citation>';
const memoryEnvelope =
  /^<oai-mem-citation>\s*<citation_entries>([\s\S]*?)<\/citation_entries>\s*<rollout_ids>[\s\S]*?<\/rollout_ids>\s*<\/oai-mem-citation>$/;

/** Older rollouts and cached views may lack the native content-kind metadata. */
export function isCodexWorkspaceContext(text: string): boolean {
  if (!text.includes('<environment_context>')) return false;
  const value = text.trim();
  if (value.startsWith('<environment_context>') && value.endsWith('</environment_context>')) {
    // Match a single generated envelope, leaving quoted XML and ordinary prompts alone.
    return (
      value.indexOf('</environment_context>') === value.length - '</environment_context>'.length &&
      ((/<current_date>\d{4}-\d{2}-\d{2}<\/current_date>/.test(value) &&
        /<timezone>[^<]+<\/timezone>/.test(value)) ||
        (/<cwd>[^<]+<\/cwd>/.test(value) && /<shell>[^<]+<\/shell>/.test(value)))
    );
  }
  return (
    /^# AGENTS\.md instructions\b/.test(value) &&
    /<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>\s*<environment_context>[\s\S]*<\/environment_context>$/.test(value)
  );
}

function insideCodeFence(text: string) {
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    const [, run, info] = marker;
    if (!fence) fence = run;
    else if (run[0] === fence[0] && run.length >= fence.length && !info.trim()) fence = undefined;
  }
  return !!fence;
}

function citationEntry(path: unknown, start: unknown, end: unknown, note: unknown): MemoryCitationEntry[] {
  if (typeof path !== 'string' || typeof start !== 'number' || typeof end !== 'number') return [];
  const source = path.trim().split(/[\\/]/).at(-1);
  if (!source || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
    return [];
  return [
    {
      source: source.slice(0, 160),
      lineStart: start,
      lineEnd: end,
      note: typeof note === 'string' ? note.trim().slice(0, 600) : '',
    },
  ];
}

export function codexNativeMemory(value: unknown): Message['codex'] {
  if (!value || typeof value !== 'object' || !('entries' in value) || !Array.isArray(value.entries))
    return undefined;
  const entries = value.entries
    .slice(0, 32)
    .flatMap((entry) =>
      entry && typeof entry === 'object'
        ? citationEntry(entry.path, entry.lineStart, entry.lineEnd, entry.note)
        : [],
    );
  return entries.length ? { kind: 'memory', entries } : undefined;
}

/** Split the native footer before Markdown rendering or preview truncation. */
export function codexAnswer(text: string, incomplete = false): Pick<Message, 'text' | 'codex'> {
  const start = text.lastIndexOf(memoryOpen);
  if (start < 0 || (start > 0 && text[start - 1] !== '\n')) return { text };
  const suffix = text.slice(start).trimEnd();
  const body = suffix.slice(memoryOpen.length).trimStart();
  const complete = memoryEnvelope.exec(suffix);
  const streaming =
    incomplete && !suffix.includes(memoryClose) && (!body || body.startsWith('<citation_entries'));
  if ((!complete && !streaming) || insideCodeFence(text.slice(0, start))) return { text };
  const entries = (complete?.[1].trim().split(/\r?\n/) ?? []).slice(0, 32).flatMap((line) => {
    const match = /^(.*?):(\d+)(?:-(\d+))?\|note=\[(.*)\]$/.exec(line.trim());
    return match ? citationEntry(match[1], Number(match[2]), Number(match[3] ?? match[2]), match[4]) : [];
  });
  return {
    text: text.slice(0, start).trimEnd(),
    ...(entries.length ? { codex: { kind: 'memory', entries } } : {}),
  };
}

/** Display fallback for transcripts cached before adapter normalization. */
export function codexDisplayMessage(message: Message, streaming = false): Message | null {
  // A development build stored environment events as structured messages.
  const cachedKind = (message.codex as { kind: string } | undefined)?.kind;
  if (cachedKind === 'environment') return null;
  if (message.codex) return message;
  const { role, text } = message;
  if (role === 'user' && isCodexWorkspaceContext(text)) return null;
  if (role !== 'assistant') return message;
  const answer = codexAnswer(text, streaming || message.truncated);
  if (answer.text === text) return message;
  return answer.text || answer.codex || message.attachments?.length ? { ...message, ...answer } : null;
}
