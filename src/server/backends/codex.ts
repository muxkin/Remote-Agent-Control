import type { BackendCommand } from './commands.js';
import { EventEmitter } from 'node:events';
import type { Config } from '../config.js';
import type { DesktopBackend } from '../desktop-backend.js';
import type { HistoryIndex } from '../history.js';
import { SkillCatalog } from '../skills.js';
import { PluginCatalog } from '../plugins.js';
import { modelCatalog, validateModelSettings } from '../models.js';
import { SelectionError } from '../selection-error.js';
import { DEFAULT_BACKEND, type BackendInfo, type CapabilityName } from '../../shared/backends.js';
import type { AgentBackend, BackendHistory } from './types.js';
import type { Operation } from '../../shared/types.js';

export class CodexBackend extends EventEmitter implements AgentBackend {
  readonly id = DEFAULT_BACKEND;
  readonly history: BackendHistory;
  private skillCatalog: SkillCatalog;
  private pluginCatalog: PluginCatalog;
  private forwarders: [string, (...args: any[]) => void][] = [];
  constructor(
    private config: Config,
    private desktop: DesktopBackend,
    private index: HistoryIndex,
  ) {
    super();
    this.history = {
      get: (id) => {
        const row = index.get(id);
        if (!row) return null;
        const { rolloutPath: _, ...summary } = row;
        return summary;
      },
      list: (...args) => index.list(...args),
      page: (...args) => index.page(...args),
      projects: () => index.projects(),
    };
    this.skillCatalog = new SkillCatalog(config.codexHome);
    this.pluginCatalog = new PluginCatalog(config.codexHome);
    for (const event of ['thread', 'status', 'observations']) {
      const listener = (...args: any[]) => this.emit(event, ...args);
      this.forwarders.push([event, listener]);
      desktop.on(event, listener);
    }
  }
  async start() {
    await (this.desktop as DesktopBackend & { start?: () => Promise<void> }).start?.();
  }
  stop() {
    for (const [event, listener] of this.forwarders) this.desktop.off(event, listener);
    (this.desktop as DesktopBackend & { stop?: () => void }).stop?.();
    this.index.close();
  }
  status() {
    return this.desktop.status();
  }
  info(): BackendInfo {
    const s = this.status(),
      platform = this.desktop.capabilities.platform;
    const mapping = {
      send: 'send',
      steer: 'steer',
      interrupt: 'interrupt',
      respond: 'approvals',
      settings: 'modelSettings',
      queue: 'queue',
      create: 'newThread',
      open: 'openThread',
    } as const;
    const capabilities = {} as BackendInfo['capabilities'];
    for (const name of [
      'history',
      'send',
      'steer',
      'interrupt',
      'respond',
      'settings',
      'queue',
      'create',
      'open',
      'attachments',
      'skills',
      'plugins',
    ] as CapabilityName[]) {
      const available = name in mapping ? !!s.capabilities[mapping[name as keyof typeof mapping]] : true;
      capabilities[name] = available
        ? { state: platform === 'linux' ? 'supported' : 'experimental' }
        : { state: 'unavailable', reason: s.reason ?? '当前桌面未提供此能力' };
    }
    return {
      id: this.id,
      product: 'codex',
      name: 'Codex',
      connected: s.connected,
      version: s.desktopVersion,
      profile: `codex/${platform}/${s.desktopVersion ?? 'unknown'}/follower-v1`,
      capabilities,
    };
  }
  acquire(id: string) {
    return this.desktop.acquire(id);
  }
  view(id: string) {
    return this.desktop.view(id);
  }
  waitForView(id: string, timeout?: number) {
    return this.desktop.waitForView(id, timeout);
  }
  projects(id: string) {
    return this.desktop.projects(id);
  }
  openThread(id: string) {
    return this.desktop.openThread(id);
  }
  execute(id: string, command: BackendCommand, requestId: string) {
    const { kind, ...value } = command;
    const input =
      command.kind === 'open'
        ? ''
        : command.kind === 'interrupt'
          ? command.expectedTurnId
          : command.kind === 'respond'
            ? JSON.stringify(command.response)
            : (kind === 'send' ? '\u001e' : '') + JSON.stringify(value);
    return this.desktop.control(id, kind, input, requestId);
  }
  inlineMedia(id: string, ref: string) {
    return this.desktop.inlineMedia(id, ref);
  }
  fullMessage(id: string, messageId: string) {
    return this.desktop.fullMessage(id, messageId);
  }
  models() {
    return modelCatalog(this.config.codexHome);
  }
  async skills(id: string) {
    const excluded = this.desktop.disabledPlugins(id);
    return (await this.skillCatalog.list(this.index.get(id)!.cwd))
      .filter((s) => !excluded.includes(s.pluginId ?? ''))
      .map(({ id, name, description, source, displayName, sourceKind }) => ({
        id,
        name,
        description,
        source,
        displayName,
        sourceKind,
      }));
  }
  async plugins(id: string) {
    const excluded = this.desktop.disabledPlugins(id);
    return (await this.pluginCatalog.list(this.index.get(id)!.cwd))
      .filter((p) => !excluded.includes(p.remoteId) && !excluded.includes(p.nativeId))
      .map(({ id, name, description }) => ({ id, name, description }));
  }
  async validateSelection(id: string, skills: string[], plugins: string[]) {
    const cwd = this.index.get(id)!.cwd,
      excluded = this.desktop.disabledPlugins(id);
    await this.skillCatalog.selected(cwd, skills, excluded);
    await this.pluginCatalog.selected(cwd, plugins, excluded);
  }
  validateSettings(value: { model: string; effort: string; serviceTier?: string }) {
    return validateModelSettings(this.config.codexHome, value);
  }
  async validateCreation(value: { model?: string; thinking?: string }) {
    if (value.thinking && !value.model) throw new SelectionError('请先选择模型');
    if (value.model) {
      const model = (await this.models()).models.find((m) => m.id === value.model);
      if (!model || (value.thinking && !model.efforts.includes(value.thinking)))
        throw new SelectionError('模型或推理强度不在桌面目录中，请重新选择');
    }
  }
}
