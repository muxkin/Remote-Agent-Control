export type CodexVoiceMode = 'fork';

export type CodexVoiceEvent =
  | { type: 'answer'; sdp: string }
  | { type: 'started'; voiceThreadId: string }
  // Each update contains the complete transcript segment so far.
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; final: boolean }
  | { type: 'closed' }
  | { type: 'error'; message: string };
