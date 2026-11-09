import type { RequestResponse } from './types.js';
import type { LocalAttachment } from './backend.js';
export type BackendCommand =
  | { kind: 'control'; control: import('./controls.js').ControlAction }
  | { kind: 'rename'; title: string }
  | { kind: 'fork'; lastTurnId?: string }
  | { kind: 'send'; text: string; attachments: LocalAttachment[]; skillIds: string[]; pluginIds: string[] }
  | { kind: 'steer'; text: string; expectedTurnId: string; attachments?: LocalAttachment[] }
  | { kind: 'interrupt'; expectedTurnId: string }
  | { kind: 'respond'; response: RequestResponse }
  | {
      kind: 'settings';
      model: string;
      effort: string;
      mode?: 'default' | 'plan';
      serviceTier?: string;
      expectedModel: string | null;
      expectedEffort: string | null;
      expectedMode?: 'default' | 'plan';
      expectedServiceTier?: string | null;
    }
  | { kind: 'queue'; text: string; expectedQueueFingerprint: string }
  | { kind: 'queue-remove'; messageId: string; expectedQueueFingerprint: string }
  | {
      kind: 'create';
      prompt: string;
      title?: string;
      projectId?: string;
      model?: string;
      thinking?: string;
      permission?: string;
      agentPreset?: string;
      plan?: boolean;
    }
  | { kind: 'open' };
/** The persisted input is the validated shared command, never an upstream RPC envelope. */
export function commandInput(kind: BackendCommand['kind'], input: string): BackendCommand {
  if (kind === 'interrupt') return { kind, expectedTurnId: input };
  if (kind === 'open') return { kind };
  const payload = JSON.parse(input.startsWith('\u001e') ? input.slice(1) : input);
  return kind === 'respond' ? { kind, response: payload } : { kind, ...payload };
}
