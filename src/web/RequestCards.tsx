import { tsxComponent } from './tsx-component';
import { shallowRef } from 'vue';
import { writeRef } from './render-effects';

import { PlanRequestCard } from './PlanRequestCard';
import { QuestionCard } from './QuestionCard';
import type { Operation, ConversationRequest, RequestResponse } from '../shared/types';
import { DiffView } from './DiffView';
export type { RequestResponse } from '../shared/types';

export const RequestCards = tsxComponent(function RequestCards(_props: {
  onDraftChange?: (id: string, dirty: boolean) => void;
  response?: Operation;
  receiptLabel?: string;
  requests: ConversationRequest[];
  threadId?: string;
  disabled: boolean;
  onRespond: (response: RequestResponse) => void | Promise<string | undefined>;
}) {
  return ({ requests, threadId, disabled, onRespond, response, onDraftChange, receiptLabel }) => {
    return (
      <div class="request-cards">
        {requests.map((request) =>
          request.kind === 'plan' ? (
            <PlanRequestCard
              key={`${request.id}:${request.fingerprint}`}
              request={request}
              threadId={threadId ?? ''}
              disabled={disabled}
              onRespond={onRespond}
              onDraftChange={onDraftChange}
              response={response}
            />
          ) : ['question', 'async-question'].includes(request.kind) && request.questions?.length ? (
            <QuestionCard
              receiptLabel={receiptLabel}
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
  };
});
const RequestCard = tsxComponent(function RequestCard(_props: {
  request: ConversationRequest;
  disabled: boolean;
  onRespond: (response: RequestResponse) => void;
}) {
  const permissionIdsState = shallowRef<string[]>([]);
  const setPermissionIds = writeRef(permissionIdsState);
  const scopeState = shallowRef<'turn' | 'session'>('turn');
  const setScope = writeRef(scopeState);
  const contentState = shallowRef<Record<string, unknown>>({});
  const setContent = writeRef(contentState);
  const formErrorState = shallowRef('');
  const setFormError = writeRef(formErrorState);
  return ({ request, disabled, onRespond }) => {
    const permissionIds = permissionIdsState.value;
    const scope = scopeState.value;
    const content = contentState.value;
    const formError = formErrorState.value;
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
      <section class="request-card" data-request-kind={request.kind}>
        <h3>{request.title}</h3>
        {request.description && <pre>{request.description}</pre>}
        {request.changes && <DiffView changes={request.changes} />}
        {request.kind === 'permissions' && (
          <fieldset disabled={disabled}>
            <legend>选择本次授予的权限</legend>
            {request.permissionOptions?.map((option) => (
              <label class="question-option" key={option.id}>
                <input
                  type="checkbox"
                  checked={permissionIds.includes(option.id)}
                  onChange={(event) =>
                    setPermissionIds((old) =>
                      (event.currentTarget as HTMLInputElement).checked
                        ? [...old, option.id]
                        : old.filter((id) => id !== option.id),
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
                onChange={(event) =>
                  setScope((event.currentTarget as HTMLSelectElement).value as 'turn' | 'session')
                }
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
          <div class="request-actions">
            <button
              class="secondary"
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
                class="primary"
                disabled={disabled || !permissionIds.length}
                onClick={() => onRespond({ ...target, permissionIds, scope })}
              >
                授予所选权限
              </button>
            ) : request.kind === 'elicitation' ? (
              <button
                class="primary"
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
                    class="secondary"
                    disabled={disabled}
                    onClick={() => onRespond({ ...target, decision: 'acceptForSession' })}
                  >
                    允许此会话
                  </button>
                )}
                {request.decisions?.includes('accept') && (
                  <button
                    class="primary"
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
  };
});
const SchemaForm = tsxComponent(function SchemaForm(_props: {
  schema: Record<string, any>;
  disabled: boolean;
  onChange: (value: Record<string, unknown>) => void;
  onError: (value: string) => void;
}) {
  const valueState = shallowRef<Record<string, unknown>>({});
  const setValue = writeRef(valueState);
  return ({ schema, disabled, onChange, onError }) => {
    const value = valueState.value;
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
            onInput={(event) => {
              try {
                const parsed = JSON.parse((event.currentTarget as HTMLTextAreaElement).value);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
                onChange(parsed);
                onError('');
              } catch {
                onError('请输入有效的 JSON 对象');
              }
            }}
          >
            {'{}'}
          </textarea>
        </label>
      );
    return (
      <fieldset disabled={disabled} class="elicitation-form">
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
                  update(
                    key,
                    (event.currentTarget as HTMLSelectElement).value
                      ? JSON.parse((event.currentTarget as HTMLSelectElement).value)
                      : undefined,
                  )
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
                  update(
                    key,
                    (event.currentTarget as HTMLSelectElement).value === ''
                      ? undefined
                      : (event.currentTarget as HTMLSelectElement).value === 'true',
                  )
                }
              >
                <option value="">请选择</option>
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
            ) : (
              <input
                aria-label={field.title ?? key}
                autocomplete="off"
                type={
                  field.type === 'string' ? (field.format === 'password' ? 'password' : 'text') : 'number'
                }
                step={field.type === 'integer' ? 1 : 'any'}
                min={field.minimum}
                max={field.maximum}
                maxlength={field.maxLength}
                value={String(value[key] ?? '')}
                onInput={(event) =>
                  update(
                    key,
                    field.type === 'string'
                      ? (event.currentTarget as HTMLInputElement).value
                      : (event.currentTarget as HTMLInputElement).value === ''
                        ? undefined
                        : Number((event.currentTarget as HTMLInputElement).value),
                  )
                }
              />
            )}
          </label>
        ))}
      </fieldset>
    );
  };
});
