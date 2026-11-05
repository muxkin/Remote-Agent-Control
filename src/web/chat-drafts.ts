import { useCallback, useEffect, useState } from 'react';
import type { SkillChoice, PluginChoice } from '../shared/types';
export type ChatDraft = {
  text: string;
  uploads: { id: string; name: string }[];
  skills: SkillChoice[];
  plugins: PluginChoice[];
};
const empty: ChatDraft = { text: '', uploads: [], skills: [], plugins: [] };
export function useChatDrafts(device: string, thread: string | null) {
  const [state, setState] = useState<{ device: string; drafts: Record<string, ChatDraft> }>({
    device: '',
    drafts: {},
  });
  useEffect(() => {
    if (!device) return;
    let drafts: Record<string, ChatDraft> = {};
    try {
      const parsed = JSON.parse(sessionStorage.getItem(`pocket-drafts:${device}`) || '{}');
      for (const [id, d] of Object.entries(parsed) as [string, any][])
        if (
          typeof d?.text === 'string' &&
          Array.isArray(d.uploads) &&
          Array.isArray(d.skills) &&
          Array.isArray(d.plugins)
        )
          drafts[id] = d;
    } catch {
      /* Memory drafts still work if browser storage is unavailable. */
    }
    setState({ device, drafts });
  }, [device]);
  useEffect(() => {
    if (!device || state.device !== device) return;
    try {
      sessionStorage.setItem(`pocket-drafts:${device}`, JSON.stringify(state.drafts));
    } catch {
      /* Reload notice still protects unsaved input. */
    }
  }, [device, state]);
  const update = useCallback(
    (id: string, change: Partial<ChatDraft> | ((d: ChatDraft) => ChatDraft)) =>
      setState((old) => {
        const current = old.drafts[id] ?? empty;
        return {
          device,
          drafts: {
            ...old.drafts,
            [id]: typeof change === 'function' ? change(current) : { ...current, ...change },
          },
        };
      }),
    [device],
  );
  const draft = thread && state.device === device ? (state.drafts[thread] ?? empty) : empty;
  return {
    draft,
    update,
    clear: () => setState({ device, drafts: {} }),
    hasDraft: Object.values(state.drafts).some(
      (d) => d.text.trim() || d.uploads.length || d.skills.length || d.plugins.length,
    ),
  };
}
