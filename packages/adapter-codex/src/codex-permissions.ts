import { createHash } from 'node:crypto';
import type { ControlState } from '../../../src/shared/controls.js';
export const codexPermissions = [
  { id: ':read-only', name: '只读' },
  { id: ':workspace', name: '工作区内修改' },
  { id: ':danger-full-access', name: '完全访问' },
];
export function codexPermissionState(settings: any): ControlState {
  const profile = settings?.activePermissionProfile?.id;
  const sandbox = settings?.sandboxPolicy?.type;
  const permission = profile ?? (sandbox ? 'custom' : null);
  return {
    permission,
    permissionRevision: permissionFingerprint(settings),
    permissionDescription: settings
      ? `沙箱：${sandbox ?? profile ?? '原生默认'}；审批：${typeof settings.approvalPolicy === 'string' ? settings.approvalPolicy : '自定义'}`
      : '沿用 Codex 创建权限',
  };
}
export function permissionFingerprint(settings: any) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        settings?.activePermissionProfile,
        settings?.sandboxPolicy,
        settings?.approvalPolicy,
        settings?.approvalsReviewer,
      ]),
    )
    .digest('hex');
}
