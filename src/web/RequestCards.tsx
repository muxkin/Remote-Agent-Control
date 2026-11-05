import { useState } from 'react';
import { QuestionCard } from './QuestionCard';
import type { Operation, ConversationRequest, RequestResponse } from '../shared/types';
import { DiffView } from './DiffView';
export type { RequestResponse } from '../shared/types';

export function RequestCards({
  requests,
  disabled,
  onRespond,
  response,
  onDraftChange,
}: {
  onDraftChange?: (id: string, dirty: boolean) => void;
  response?: Operation;
  requests: ConversationRequest[];
  disabled: boolean;
  onRespond: (response: RequestResponse) => void;
}) {
  return (
    <div className="request-cards">
      {requests.map((request) =>
        ['question', 'async-question'].includes(request.kind) && request.questions?.length ? (
          <QuestionCard
            key={`${request.id}:${request.fingerprint}`}
            request={request}
            disabled={disabled}
            onRespond={onRespond}
            response={response}
            onDraftChange={onDraftChange}
          />
        ) : (
          <RequestCard
            key={`${request.id}:${request.fingerprint}`}
            request={request}
            disabled={disabled}
            onRespond={onRespond}
          />
        ),
      )}
    </div>
  );
}
function RequestCard({
  request,
  disabled,
  onRespond,
}: {
  request: ConversationRequest;
  disabled: boolean;
  onRespond: (response: RequestResponse) => void;
}) {
  const [permissionIds, setPermissionIds] = useState<string[]>([]);
  const [scope, setScope] = useState<'turn' | 'session'>('turn');
  const [content, setContent] = useState<Record<string, unknown>>({});
  const [formError, setFormError] = useState('');
  const target = {
    targetRequestId: request.id,
    expectedTurnId: request.turnId,
    expectedFingerprint: request.fingerprint,
  };
  function reject() {
    onRespond({
      ...target,
      ...(request.kind === 'permissions'
        ? { permissionIds: [], scope: 'turn' as const }
        : request.kind === 'elicitation'
          ? { action: 'decline' as const, content: null }
          : {
              decision: request.decisions?.includes('decline') ? ('decline' as const) : ('cancel' as const),
            }),
    });
  }
  return (
    <section className="request-card" data-request-kind={request.kind}>
      <h3>{request.title}</h3>
      {request.description && <pre>{request.description}</pre>}
      {request.changes && <DiffView changes={request.changes} />}
      {request.kind === 'permissions' && (
        <fieldset disabled={disabled}>
          <legend>选择本次授予的权限</legend>
          {request.permissionOptions?.map((option) => (
            <label className="question-option" key={option.id}>
              <input
                type="checkbox"
                checked={permissionIds.includes(option.id)}
                onChange={(event) =>
                  setPermissionIds((old) =>
                    event.target.checked ? [...old, option.id] : old.filter((id) => id !== option.id),
                  )
                }
              />
              <span>
                {option.label}
                <pre>{option.details}</pre>
              </span>
            </label>
          ))}
          <label>
            有效范围
            <select
              aria-label="权限有效范围"
              value={scope}
              onChange={(event) => setScope(event.target.value as 'turn' | 'session')}
            >
              <option value="turn">当前任务</option>
              <option value="session">当前会话的后续任务</option>
            </select>
          </label>
        </fieldset>
      )}
      {request.form && (
        <SchemaForm
          schema={request.form.schema}
          disabled={disabled}
          onChange={setContent}
          onError={setFormError}
        />
      )}
      {request.url && (
        <p>
          <a href={request.url} target="_blank" rel="noreferrer">
            打开验证页面
          </a>
          ，在页面完成后再确认。
        </p>
      )}
      {formError && <p role="alert">{formError}</p>}
      {!request.actionable || !['command', 'file', 'permissions', 'elicitation'].includes(request.kind) ? (
        <p>此类交互需要在桌面完成，当前可查看状态。</p>
      ) : (
        <div className="request-actions">
          <button
            className="secondary"
            disabled={
              disabled ||
              (['command', 'file'].includes(request.kind) &&
                !request.decisions?.some((value) => value === 'decline' || value === 'cancel'))
            }
            onClick={reject}
          >
            拒绝
          </button>
          {request.kind === 'permissions' ? (
            <button
              className="primary"
              disabled={disabled || !permissionIds.length}
              onClick={() => onRespond({ ...target, permissionIds, scope })}
            >
              授予所选权限
            </button>
          ) : request.kind === 'elicitation' ? (
            <button
              className="primary"
              disabled={disabled || !!formError}
              onClick={() =>
                onRespond({ ...target, action: 'accept', content: request.form ? content : null })
              }
            >
              {request.url ? '已在页面完成' : '提交表单'}
            </button>
          ) : (
            <>
              {request.decisions?.includes('acceptForSession') && (
                <button
                  className="secondary"
                  disabled={disabled}
                  onClick={() => onRespond({ ...target, decision: 'acceptForSession' })}
                >
                  允许此会话
                </button>
              )}
              {request.decisions?.includes('accept') && (
                <button
                  className="primary"
                  disabled={disabled}
                  onClick={() => onRespond({ ...target, decision: 'accept' })}
                >
                  允许本次
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
function SchemaForm({
  schema,
  disabled,
  onChange,
  onError,
}: {
  schema: Record<string, any>;
  disabled: boolean;
  onChange: (value: Record<string, unknown>) => void;
  onError: (value: string) => void;
}) {
  const [value, setValue] = useState<Record<string, unknown>>({});
  const properties = Object.entries(schema.properties ?? {}) as [string, Record<string, any>][];
  const simple =
    schema.type === 'object' &&
    properties.every(([, field]) => ['string', 'number', 'integer', 'boolean'].includes(field.type));
  function update(key: string, next: unknown) {
    const updated = { ...value, [key]: next };
    setValue(updated);
    onChange(updated);
  }
  if (!simple)
    return (
      <label>
        表单内容（JSON）
        <textarea
          disabled={disabled}
          aria-label="表单 JSON"
          defaultValue="{}"
          onChange={(event) => {
            try {
              const parsed = JSON.parse(event.target.value);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
              onChange(parsed);
              onError('');
            } catch {
              onError('请输入有效的 JSON 对象');
            }
          }}
        />
      </label>
    );
  return (
    <fieldset disabled={disabled} className="elicitation-form">
      <legend>填写连接器请求的内容</legend>
      {properties.map(([key, field]) => (
        <label key={key}>
          {field.title ?? key}
          {schema.required?.includes(key) ? ' *' : ''}
          {field.description && <small>{field.description}</small>}
          {Array.isArray(field.enum) ? (
            <select
              aria-label={field.title ?? key}
              value={value[key] === undefined ? '' : JSON.stringify(value[key])}
              onChange={(event) =>
                update(key, event.target.value ? JSON.parse(event.target.value) : undefined)
              }
            >
              <option value="">请选择</option>
              {field.enum.map((option: unknown, index: number) => (
                <option key={index} value={JSON.stringify(option)}>
                  {field.enumNames?.[index] ?? String(option)}
                </option>
              ))}
            </select>
          ) : field.type === 'boolean' ? (
            <select
              aria-label={field.title ?? key}
              value={value[key] === undefined ? '' : String(value[key])}
              onChange={(event) =>
                update(key, event.target.value === '' ? undefined : event.target.value === 'true')
              }
            >
              <option value="">请选择</option>
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          ) : (
            <input
              aria-label={field.title ?? key}
              autoComplete="off"
              type={field.type === 'string' ? (field.format === 'password' ? 'password' : 'text') : 'number'}
              step={field.type === 'integer' ? 1 : 'any'}
              min={field.minimum}
              max={field.maximum}
              maxLength={field.maxLength}
              value={String(value[key] ?? '')}
              onChange={(event) =>
                update(
                  key,
                  field.type === 'string'
                    ? event.target.value
                    : event.target.value === ''
                      ? undefined
                      : Number(event.target.value),
                )
              }
            />
          )}
        </label>
      ))}
    </fieldset>
  );
}
