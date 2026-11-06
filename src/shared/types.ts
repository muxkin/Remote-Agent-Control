export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  turnId?: string;
  clientMessageId?: string;
  phase?: string;
  details?: string;
  truncated?: boolean;
  deferred?: boolean;
  changes?: FileDiff[];
  output?: string;
  attachments?: { name: string; path: string }[];
  skills?: string[];
  plugins?: string[];
}
export interface ConversationRequest {
  id: string;
  fingerprint?: string;
  kind:
    | 'command'
    | 'file'
    | 'question'
    | 'async-question'
    | 'permissions'
    | 'elicitation'
    | 'plan'
    | 'unsupported';
  title: string;
  description: string;
  turnId: string | null;
  questions?: {
    id: string;
    header: string;
    question: string;
    secret?: boolean;
    options: { label: string; description: string }[];
  }[];
  actionable: boolean;
  decisions?: ApprovalDecision[];
  changes?: FileDiff[];
  permissionOptions?: { id: string; label: string; details: string }[];
  form?: { schema: Record<string, any>; mode: string };
  url?: string;
}
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export interface FileDiff {
  path: string;
  kind: string;
  diff: string;
}
export interface RequestResponse {
  targetRequestId: string;
  expectedTurnId: string | null;
  expectedFingerprint?: string;
  planDecision?: 'implement' | 'revise';
  feedback?: string;
  decision?: ApprovalDecision;
  answers?: Record<string, string[]>;
  permissionIds?: string[];
  scope?: 'turn' | 'session';
  action?: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown> | null;
}
export interface ThreadSummary {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  projectId?: string | null;
  projectName?: string | null;
}
export interface ProjectSummary {
  id: string;
  name: string;
  count: number;
}
export interface SkillChoice {
  id: string;
  name: string;
  description: string;
  source: string;
  displayName?: string;
  sourceKind?: 'project' | 'personal' | 'system' | 'plugin';
}
export interface PluginChoice {
  id: string;
  name: string;
  description: string;
}
export interface ThreadView extends ThreadSummary {
  messages: Message[];
  revision: number;
  owner: boolean;
  synchronized: boolean;
  activeTurnId: string | null;
  runtimeStatus: string;
  model: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  pendingRequests: number;
  requests?: ConversationRequest[];
  mode?: string;
  queuedMessages?: { id: string; text: string; status: string; reason?: string }[];
  queueFingerprint?: string;
  canSend: boolean;
  canInterrupt: boolean;
  reason: string | null;
}
export interface GatewayStatus {
  connected: boolean;
  desktopVersion: string | null;
  supportedVersion: boolean;
  writesEnabled: boolean;
  reason: string | null;
  capabilities: {
    send: boolean;
    steer: boolean;
    interrupt: boolean;
    modelSettings: boolean;
    questions: boolean;
    approvals: boolean;
    permissionRequests: 'experimental' | false;
    openThread: boolean;
    elicitationForms: 'experimental' | false;
    newThread: boolean;
    queue: boolean;
  };
}
export type OperationState =
  'received' | 'dispatching' | 'accepted' | 'completed' | 'interrupted' | 'failed' | 'rejected' | 'uncertain';
export interface Operation {
  backendId?: string;
  id: string;
  threadId: string;
  kind:
    'send' | 'steer' | 'interrupt' | 'settings' | 'respond' | 'queue' | 'queue-remove' | 'open' | 'create';
  state: OperationState;
  resultThreadId?: string;
  turnId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export type ServerEvent =
  | { type: 'control-receipt'; requestId: string; operation?: Operation; error?: string; notSent?: boolean }
  | { type: 'transport'; p2pAvailable: boolean; stunUrls: string[] }
  | { type: 'p2p-answer'; sdp: string }
  | { type: 'status'; status: GatewayStatus }
  | { type: 'thread'; thread: ThreadView }
  | { type: 'threadDelta'; delta: ThreadDelta }
  | { type: 'operation'; operation: Operation }
  | { type: 'error'; message: string };
export interface ThreadDelta {
  thread: Pick<ThreadView, 'id' | 'revision'> & Partial<Omit<ThreadView, 'messages' | 'id' | 'revision'>>;
  baseRevision: number;
  changes: ({ type: 'put'; message: Message } | { type: 'append'; id: string; text: string })[];
  order?: string[];
}
