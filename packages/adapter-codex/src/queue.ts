import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export function queueFingerprint(messages: any[]) {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}
export async function readNativeQueue(home: string, id: string): Promise<any[]> {
  const data = await readFile(join(home, '.codex-global-state.json'), 'utf8');
  if (data.length > 32 * 1024 * 1024) throw Error('Queue state too large');
  const state = JSON.parse(data)['queued-follow-ups'];
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw Error('Native queue unavailable');
  const messages = state[id] ?? [];
  if (!Array.isArray(messages)) throw Error('Invalid native queue');
  return messages;
}
export function queuedMessage(id: string, text: string, state: any) {
  return {
    id,
    text,
    cwd: state.cwd,
    acceptedAtMs: Date.now(),
    requiresExistingOwner: true,
    context: {
      prompt: text,
      fileAttachments: [],
      addedFiles: [],
      imageAttachments: [],
      appshotContexts: [],
      mcpAppModelContextAttachments: [],
      pastedTextAttachments: [],
      uploadedFileAttachments: [],
      commentAttachments: [],
      workspaceRoots: state.currentPermissions?.runtimeWorkspaceRoots ?? [state.cwd],
    },
    submissionOptions: {
      usePermissionSelection: false,
      shouldSendPermissionOverrides: false,
      collaborationMode: state.latestCollaborationMode,
    },
    submissionIntent: 'queue',
    submission: { hostId: 'local', status: 'queued', queueModeOverride: 'queue-only' },
  };
}
