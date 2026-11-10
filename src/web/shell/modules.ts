import type { IconName } from '../icon-paths';

/** Built-in modules are shipped code. No arbitrary remote JavaScript or desktop RPC. */
export const modules: {
  id: 'messages' | 'contacts' | 'workbench' | 'me';
  title: string;
  icon: IconName;
}[] = [
  { id: 'messages', title: '消息', icon: 'chat' },
  { id: 'contacts', title: '联系人', icon: 'contacts' },
  { id: 'workbench', title: '工作台', icon: 'grid' },
  { id: 'me', title: '我的', icon: 'user' },
];
export const workspaceTools = [
  { id: 'dsh', name: 'DSH', load: () => import('../CodexWorkspace') },
  { id: 'codex', name: 'Codex', load: () => import('../CodexWorkspace') },
] as const;
