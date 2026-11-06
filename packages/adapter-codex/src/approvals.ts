import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { z } from 'zod';
import type { ApprovalDecision, ConversationRequest, RequestResponse } from '../../../src/shared/types.js';
import { DeliveryError } from './transport.js';

export { responseBody } from '../../../src/server/control-schemas.js';
export function requestFingerprint(request: any): string {
  return createHash('sha256')
    .update(JSON.stringify([request.id, request.method, request.params]))
    .digest('hex');
}
function permissionOptions(
  permissions: any,
): { id: string; label: string; details: string; value: any; key: string; child?: string }[] {
  const options: ReturnType<typeof permissionOptions> = [];
  if (!permissions || typeof permissions !== 'object') return options;
  for (const key of ['network', 'fileSystem']) {
    const value = permissions[key];
    if (!value || typeof value !== 'object') continue;
    if (key === 'fileSystem' && Object.keys(value).every((name) => ['read', 'write'].includes(name))) {
      for (const child of ['read', 'write'])
        if (Array.isArray(value[child]))
          value[child].forEach((path: unknown, index: number) => {
            if (typeof path === 'string')
              options.push({
                id: `${key}.${child}.${index}`,
                key,
                child,
                value: path,
                label: `${child === 'read' ? '读取' : '写入'} ${path}`,
                details: path,
              });
          });
    } else
      options.push({
        id: key,
        key,
        value,
        label: key === 'network' ? '请求的网络访问权限' : '请求的文件权限',
        details: JSON.stringify(value, null, 2),
      });
  }
  return options;
}
export function normalizeRequest(request: any, items: any[]): ConversationRequest {
  const p = request.params ?? {};
  const item = items.find((item) => item.id === p.itemId);
  let kind: ConversationRequest['kind'] = 'unsupported';
  const methods: Record<string, ConversationRequest['kind']> = {
    'item/commandExecution/requestApproval': 'command',
    'item/fileChange/requestApproval': 'file',
    'item/permissions/requestApproval': 'permissions',
    'item/tool/requestUserInput': 'question',
    'item/plan/requestImplementation': 'plan',
    'mcpServer/elicitation/request': 'elicitation',
  };
  kind = methods[request.method] ?? kind;
  const review =
    kind === 'file' ? (p.changes ?? item?.changes) : kind === 'command' ? (p.command ?? item?.command) : null;
  const description = [
    kind === 'plan' ? p.planContent : null,
    p.reason,
    p.message,
    kind === 'command' ? review : null,
    p.cwd ? `工作目录：${p.cwd}` : null,
    p.networkApprovalContext ? `网络请求：${JSON.stringify(p.networkApprovalContext)}` : null,
    p.additionalPermissions ? `附加权限：${JSON.stringify(p.additionalPermissions, null, 2)}` : null,
    p.grantRoot ? `授权目录：${p.grantRoot}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const decisions = (['accept', 'acceptForSession', 'decline', 'cancel'] as ApprovalDecision[]).filter(
    (decision) => !Array.isArray(p.availableDecisions) || p.availableDecisions.includes(decision),
  );
  const questions =
    kind === 'question'
      ? (p.questions ?? []).map((q: any) => ({
          id: q.id,
          header: q.header ?? '',
          question: q.question ?? '',
          secret: q.isSecret === true,
          options: (q.options ?? []).map((o: any) => ({ label: o.label, description: o.description ?? '' })),
        }))
      : undefined;
  const options = kind === 'permissions' ? permissionOptions(p.permissions) : undefined;
  const form =
    kind === 'elicitation' &&
    ['form', 'openai/form'].includes(p.mode) &&
    p.requestedSchema &&
    typeof p.requestedSchema === 'object'
      ? { mode: p.mode, schema: p.requestedSchema }
      : undefined;
  let url: string | undefined;
  if (kind === 'elicitation' && p.mode === 'url') {
    try {
      const parsed = new URL(p.url);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) url = parsed.href;
    } catch {}
  }
  const changes =
    kind === 'file' && Array.isArray(review)
      ? review.map((change: any) => ({
          path: String(change.path ?? ''),
          kind: String(change.kind?.type ?? change.kind ?? 'update'),
          diff: String(change.diff ?? ''),
        }))
      : undefined;
  const complete = description.length <= 100000 && JSON.stringify(changes ?? []).length <= 500000;
  return {
    id: String(request.id),
    fingerprint: requestFingerprint(request),
    kind,
    title: {
      command: p.networkApprovalContext ? '网络访问审批' : '命令执行审批',
      file: '文件修改审批',
      permissions: '权限申请',
      question: 'Codex 需要你的回答',
      'async-question': 'Codex 需要你的回答',
      elicitation: `${p.serverName ?? '连接器'} 需要确认`,
      plan: '计划等待批准',
      unsupported: '桌面交互请求',
    }[kind],
    description: complete ? description : description.slice(0, 100000) + '\n请在桌面查看完整审批。',
    turnId: p.turnId ?? null,
    questions,
    decisions,
    changes: complete ? changes : undefined,
    permissionOptions: options?.map(({ id, label, details }) => ({ id, label, details })),
    form,
    url,
    actionable:
      complete &&
      ((kind === 'plan' && typeof p.planContent === 'string' && !!p.planContent.trim() && !!p.turnId) ||
        kind === 'question' ||
        (kind === 'permissions' && !!options?.length) ||
        (kind === 'elicitation' && (!!form || !!url)) ||
        (kind === 'file' && !!changes?.length) ||
        (kind === 'command' && !!(review || p.networkApprovalContext))),
  };
}
function invalid(message: string): never {
  throw new DeliveryError(message, true);
}
export function approvalResponse(
  request: any,
  answer: RequestResponse,
): { method: string; payload: Record<string, unknown> } {
  if (
    (request.params?.turnId ?? null) !== answer.expectedTurnId ||
    request.completed ||
    (answer.expectedFingerprint && requestFingerprint(request) !== answer.expectedFingerprint)
  )
    invalid('此请求已变化或过期，请重新核对');
  const p = request.params ?? {};
  const base = { requestId: request.id };
  switch (request.method) {
    case 'item/tool/requestUserInput': {
      const questions = p.questions ?? [];
      if (
        !answer.answers ||
        Object.keys(answer.answers).some((key) => !questions.some((q: any) => q.id === key)) ||
        questions.some((q: any) => !answer.answers?.[q.id]?.length)
      )
        invalid('请回答所有当前问题');
      return {
        method: 'thread-follower-submit-user-input',
        payload: {
          ...base,
          response: {
            answers: Object.fromEntries(
              Object.entries(answer.answers).map(([key, value]) => [key, { answers: value }]),
            ),
          },
        },
      };
    }
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval': {
      if (
        !answer.decision ||
        !['accept', 'acceptForSession', 'decline', 'cancel'].includes(answer.decision) ||
        (p.availableDecisions && !p.availableDecisions.includes(answer.decision))
      )
        invalid('当前审批不允许此选择');
      return {
        method: `thread-follower-${request.method.includes('commandExecution') ? 'command' : 'file'}-approval-decision`,
        payload: { ...base, decision: answer.decision },
      };
    }
    case 'item/permissions/requestApproval': {
      if (!answer.permissionIds) invalid('缺少权限选择');
      const choices = permissionOptions(p.permissions);
      if (answer.permissionIds.some((id) => !choices.some((choice) => choice.id === id)))
        invalid('不能授予未请求的权限');
      const permissions: Record<string, any> = {};
      for (const choice of choices.filter((choice) => answer.permissionIds!.includes(choice.id))) {
        if (!choice.child) permissions[choice.key] = choice.value;
        else {
          permissions[choice.key] ??= {};
          permissions[choice.key][choice.child] ??= [];
          permissions[choice.key][choice.child].push(choice.value);
        }
      }
      return {
        method: 'thread-follower-permissions-request-approval-response',
        payload: { ...base, response: { permissions, scope: answer.scope ?? 'turn' } },
      };
    }
    case 'mcpServer/elicitation/request': {
      if (!answer.action || !['form', 'openai/form', 'url'].includes(p.mode)) invalid('此类确认需在桌面完成');
      if (answer.action === 'accept' && p.mode !== 'url') {
        if (!p.requestedSchema || !answer.content || JSON.stringify(p.requestedSchema).length > 50000)
          invalid('表单不可验证');
        try {
          const validator = new Ajv({
            strict: false,
            allErrors: false,
            ownProperties: true,
            validateFormats: true,
            formats: fullFormats,
          });
          if (!validator.validate(p.requestedSchema, answer.content)) invalid('表单内容与请求格式不符');
        } catch (error) {
          if (error instanceof DeliveryError) throw error;
          invalid('无法验证此表单，请在桌面完成');
        }
      }
      return {
        method: 'thread-follower-submit-mcp-server-elicitation-response',
        payload: {
          ...base,
          response: {
            action: answer.action,
            content: answer.action === 'accept' && p.mode !== 'url' ? answer.content : null,
          },
        },
      };
    }
    default:
      return invalid('此类请求尚需在桌面处理');
  }
}
