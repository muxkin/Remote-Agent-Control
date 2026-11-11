import { shallowRef } from 'vue';
import { watchRender } from './render-effects';

import type { Operation, SkillChoice, PluginChoice } from '../shared/types';
export type ChatDraft = {
  text: string;
  uploads: { id: string; name: string; path?: string }[];
  skills: SkillChoice[];
  plugins: PluginChoice[];
};
const empty: ChatDraft = { text: '', uploads: [], skills: [], plugins: [] };
type Outgoing = { draft: ChatDraft; operation: Operation };
type DraftSlot = { draft: ChatDraft; outgoing?: Outgoing };

function hasContent(draft: ChatDraft) {
  return !!(draft.text.trim() || draft.uploads.length || draft.skills.length || draft.plugins.length);
}

export function useChatDrafts() {
  const currentDrafts = shallowRef<{ device: string; drafts: Record<string, DraftSlot> }>({
    device: '',
    drafts: {},
  });
  const readStorage = watchRender();
  const persistDrafts = watchRender();
  return (device: string, thread: string | null) => {
    const state = currentDrafts.value;
    readStorage(() => {
      if (!device) return;
      const drafts: Record<string, DraftSlot> = {};
      try {
        const parsed = JSON.parse(
          (localStorage.getItem(`pocket-drafts:${device}`) ??
            sessionStorage.getItem(`pocket-drafts:${device}`)) ||
            '{}',
        );
        for (const [id, entry] of Object.entries(parsed) as [string, DraftSlot & ChatDraft][]) {
          const d = entry?.draft ?? entry;
          if (
            typeof d?.text === 'string' &&
            Array.isArray(d.uploads) &&
            Array.isArray(d.skills) &&
            Array.isArray(d.plugins)
          )
            drafts[id] = {
              draft: d,
              outgoing: entry.outgoing && {
                ...entry.outgoing,
                operation: ['received', 'dispatching'].includes(entry.outgoing.operation.state)
                  ? { ...entry.outgoing.operation, state: 'uncertain' }
                  : entry.outgoing.operation,
              },
            };
        }
      } catch {
        /* Memory drafts still work if browser storage is unavailable. */
      }
      currentDrafts.value = { device, drafts };
    }, [device]);
    persistDrafts(() => {
      if (!device || state.device !== device) return;
      try {
        localStorage.setItem(`pocket-drafts:${device}`, JSON.stringify(state.drafts));
      } catch {
        /* Reload notice still protects unsaved input. */
      }
    }, [device, state]);
    function updateSlot(id: string, change: (slot: DraftSlot) => DraftSlot, durable = false) {
      const old = currentDrafts.value;
      if (old.device !== device) {
        if (durable) throw Error('草稿尚未就绪');
        return;
      }
      const current = old.drafts[id] ?? { draft: empty };
      const next = change(current);
      if (next === current) return;
      const state = {
        device,
        drafts: { ...old.drafts, [id]: next },
      };
      if (durable) localStorage.setItem(`pocket-drafts:${device}`, JSON.stringify(state.drafts));
      currentDrafts.value = state;
    }
    const slot = thread && state.device === device ? state.drafts[thread] : undefined;
    const update = (id: string, change: Partial<ChatDraft> | ((d: ChatDraft) => ChatDraft)) =>
      updateSlot(id, (current) => ({
        ...current,
        draft: typeof change === 'function' ? change(current.draft) : { ...current.draft, ...change },
      }));
    return {
      draft: slot?.draft ?? empty,
      outgoing: slot?.outgoing,
      update,
      submit: (operation: Operation, draft: ChatDraft, retry: boolean) =>
        updateSlot(
          operation.threadId,
          (current) => ({
            draft: retry ? current.draft : empty,
            outgoing: { operation, draft },
          }),
          true,
        ),
      settle: (operation: Operation) =>
        updateSlot(operation.threadId, (current) => {
          const outgoing = current.outgoing;
          if (outgoing?.operation.id !== operation.id) return current;
          if (
            ['completed', 'interrupted'].includes(operation.state) ||
            (operation.state === 'accepted' && operation.kind !== 'send')
          )
            return { draft: current.draft };
          return { ...current, outgoing: { ...outgoing, operation } };
        }),
      clearOutgoing: (operation: Operation, restore = false) =>
        updateSlot(operation.threadId, (current) => {
          if (current.outgoing?.operation.id !== operation.id || (restore && hasContent(current.draft)))
            return current;
          return { draft: restore ? current.outgoing.draft : current.draft };
        }),
      clear: () => {
        currentDrafts.value = { device, drafts: {} };
      },
      hasDraft: Object.values(state.drafts).some(
        ({ draft, outgoing }) => hasContent(draft) || (!!outgoing && outgoing.operation.state !== 'accepted'),
      ),
    };
  };
}
