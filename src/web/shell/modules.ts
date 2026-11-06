import type { ComponentProps } from 'react';
import type { Icon } from '../Icon';
/** Built-in modules are shipped code. No arbitrary remote JavaScript or desktop RPC. */
export const modules: {
  id: 'messages' | 'workbench' | 'me';
  title: string;
  icon: ComponentProps<typeof Icon>['name'];
}[] = [
  { id: 'messages', title: '消息', icon: 'chat' },
  { id: 'workbench', title: '工作台', icon: 'grid' },
  { id: 'me', title: '我的', icon: 'user' },
];
export interface AgentAddress {
  connectorId: string;
  instanceId: string;
  conversationId: string;
}
export interface AgentContact {
  id: string;
  name: string;
  avatar?: string;
}
export interface InstantMessage {
  id: string;
  contactId: string;
  text: string;
  sentAt: number;
  fromMe: boolean;
}
/** IM integrations keep their own conversation and delivery semantics, separate from tool execution. */
export interface MessagingConnector {
  id: string;
  contacts(): Promise<AgentContact[]>;
  history(address: AgentAddress, before?: string): Promise<{ messages: InstantMessage[]; cursor?: string }>;
  subscribe(address: AgentAddress, receive: (message: InstantMessage) => void): () => void;
  send(address: AgentAddress, message: { requestId: string; text: string }): Promise<{ id: string }>;
}
export const messagingConnectors: readonly MessagingConnector[] = [];
export const workspaceTools = [
  { id: 'dsh', name: 'DSH', load: () => import('../CodexWorkspace') },
  { id: 'codex', name: 'Codex', load: () => import('../CodexWorkspace') },
] as const;
