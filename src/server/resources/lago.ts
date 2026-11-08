import type { ResourcePolicy, ResourcePolicyProvider } from '../../shared/resources.js';

export interface LagoConfig {
  url: string;
  apiKey: string;
  instance: string;
  defaultPlan: string;
}

// Rails interprets a literal dot in an external ID as a response-format suffix.
const segment = (value: string) => encodeURIComponent(value).replace(/\./g, '%2E');

/** Only the operator configures this adapter. No browser value selects a customer, plan, or limit. */
export class LagoResourcePolicy implements ResourcePolicyProvider {
  constructor(
    private config: LagoConfig,
    private http: typeof fetch = fetch,
  ) {
    const url = new URL(config.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw Error('Invalid billing service URL');
    if (!config.apiKey || !config.instance || !config.defaultPlan)
      throw Error('Incomplete billing configuration');
  }
  private async request(path: string, body?: unknown) {
    // Worker globals require their native receiver, not the policy instance as `this`.
    const http = this.http;
    const response = await http(`${this.config.url.replace(/\/$/, '')}/api/v1${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Pocket-Resource-Policy/1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 404 && !body && path.startsWith('/customers/')) return undefined;
    if (!response.ok) {
      // Operational diagnostics only: never log customer IDs, credentials, or response bodies.
      console.warn('Billing policy request failed', path.split('/')[1], response.status);
      throw Error('Billing policy service unavailable');
    }
    return response.json() as Promise<any>;
  }
  async resolve(subject: string): Promise<ResourcePolicy> {
    const id = `${this.config.instance}:${subject}`,
      encoded = segment(id);
    let customer = await this.request(`/customers/${encoded}`);
    if (!customer) {
      // Deterministic external IDs make retried initial provisioning idempotent.
      customer = await this.request('/customers', {
        customer: {
          external_id: id,
          name: id,
          metadata: [{ key: 'pocket_instance', value: this.config.instance }],
        },
      });
    }
    let subscriptions = await this.request(
      `/subscriptions?external_customer_id=${encoded}&status[]=active&per_page=100`,
    );
    if (
      !subscriptions?.subscriptions?.length &&
      customer?.customer?.metadata?.some(
        (m: any) => m.key === 'pocket_instance' && m.value === this.config.instance,
      )
    ) {
      const history = await this.request(
        `/subscriptions?external_customer_id=${encoded}&status[]=active&status[]=pending&status[]=terminated&status[]=canceled&status[]=incomplete&per_page=1`,
      );
      if (Array.isArray(history?.subscriptions) && !history.subscriptions.length) {
        // Retry an interrupted first provisioning; any subscription history prevents reinstating a cancelled plan.
        await this.request('/subscriptions', {
          subscription: { external_customer_id: id, external_id: id, plan_code: this.config.defaultPlan },
        });
        subscriptions = await this.request(
          `/subscriptions?external_customer_id=${encoded}&status[]=active&per_page=100`,
        );
      }
    }
    const active = subscriptions?.subscriptions;
    // Cancellation never silently reinstates the default plan. Ambiguous multiple subscriptions fail closed.
    if (!Array.isArray(active) || active.length !== 1)
      return { label: '未启用资源套餐', storageBytes: 0, relayBytes: 0, timeZone: 'UTC' };
    const subscription = active[0];
    const plan =
      subscription.plan ??
      (subscription.plan_code
        ? (await this.request(`/plans/${segment(subscription.plan_code)}`))?.plan
        : undefined);
    const result = await this.request(`/subscriptions/${segment(subscription.external_id)}/entitlements`);
    const value = (feature: string, privilege: string) =>
      result?.entitlements
        ?.find((e: any) => e.code === feature)
        ?.privileges?.find((p: any) => p.code === privilege)?.value;
    const integer = (v: unknown) => {
      if (!Number.isSafeInteger(v) || (v as number) < 0) throw Error('Invalid resource policy');
      return v as number;
    };
    const timeZone = value('relay', 'time_zone');
    if (typeof timeZone !== 'string') throw Error('Missing quota timezone');
    new Intl.DateTimeFormat('en', { timeZone }).format();
    return {
      label: String(plan?.name || subscription.name || '资源套餐'),
      storageBytes: integer(value('storage', 'max_bytes')),
      relayBytes: integer(value('relay', 'max_bytes')),
      timeZone,
    };
  }
}

export type ResourceEnvironment = Partial<
  Record<
    'POCKET_LAGO_URL' | 'POCKET_LAGO_API_KEY' | 'POCKET_LAGO_DEFAULT_PLAN' | 'POCKET_RESOURCE_INSTANCE',
    string
  >
>;

export function resourceProvider(env: ResourceEnvironment): ResourcePolicyProvider | undefined {
  if (!env.POCKET_LAGO_URL && !env.POCKET_LAGO_API_KEY && !env.POCKET_LAGO_DEFAULT_PLAN) return;
  return new LagoResourcePolicy({
    url: env.POCKET_LAGO_URL!,
    apiKey: env.POCKET_LAGO_API_KEY!,
    instance: env.POCKET_RESOURCE_INSTANCE!,
    defaultPlan: env.POCKET_LAGO_DEFAULT_PLAN!,
  });
}
