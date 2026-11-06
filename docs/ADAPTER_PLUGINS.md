# 独立 Agent 接入插件

网关负责配对、加密、操作记录、同步和文件传输。SDK 定义产品无关的会话接口；产品协议和系统连接器分别位于 `packages/adapter-codex`、`packages/adapter-dsh`。默认附带两款官方插件。每个配置实例有独立 Node 宿主、配置、状态目录与订阅；宿主只连接已有 Agent。

```mermaid
flowchart LR
  UI[共享聊天界面] <--> G[加密网关与操作记录]
  G <--> P[稳定实例代理与监督器]
  P <--> C[Codex 插件宿主]
  P <--> D1[DSH 实例一宿主]
  P <--> D2[DSH 实例二宿主]
  C <--> CD[已有 Codex 桌面]
  D1 <--> DW1[已有 DSH Web]
  D2 <--> DW2[已有 DSH Web]
```

## 配置与迁移

旧 `POCKET_BACKENDS_FILE` 中的 DSH 配置自动映射，原有 `codex-local`、DSH ID、配对、草稿、缓存、操作与文件路径保持不变。Codex 的旧环境变量也自动映射到它自己的实例配置。默认客户端仍定位 `codex-local`。

通用配置使用 `POCKET_ADAPTERS_FILE=/absolute/path/instances.json`：

```json
[
  {
    "id": "dsh-one",
    "name": "我的 DSH",
    "plugin": "@agent-remote/adapter-dsh",
    "version": "1.0.0",
    "config": { "url": "http://127.0.0.1:3080", "version": "0.2.1-rc.5" },
    "secrets": { "token": "DSH_ONE_TOKEN" }
  },
  {
    "id": "another-agent",
    "name": "另一个 Agent",
    "plugin": "my-agent-adapter",
    "version": "1.0.0",
    "config": {},
    "secrets": {}
  }
]
```

未列出 `codex-local` 时自动保留默认 Codex。新增/删除实例或修改连接配置后重启网关；已配置实例的插件升级由监督器在线应用。首次绑定取配置中的明确版本，之后以主机私有 registry 的版本绑定为准，修改配置版本不会暗中升级。`codex-local` 保留给原 Codex，不能改指其他产品。

凭据只解析进对应宿主的初始化消息，不写入公开实例描述或插件版本 registry。宿主环境使用允许列表，不继承网关配对密钥、`NODE_OPTIONS` 或其他实例 token。插件是本机受信任代码，进程隔离不等于安全沙箱。

## 安装、升级与回滚

Node 24 或更高版本；Codex 连接还需要 Python 3。`npm run build` 构建三个包与网关。发布包可由 `npm run package:adapters` 生成，位于 `dist/adapters`，附 SHA-256 校验文件。

```sh
npm run adapter -- list
npm run adapter -- install /absolute/path/agent-remote-adapter-dsh-1.0.0.tgz
npm run adapter -- install my-agent-adapter@1.2.3
npm run adapter -- upgrade dsh-one @agent-remote/adapter-dsh@1.1.0
npm run adapter -- rollback dsh-one
```

安装只接受本地 `.tgz`/`.tar.gz` 或明确的 npm 版本，不接受 tag、范围或 Git URL。包先安装到暂存目录，禁用安装脚本，检查入口边界、SDK 版本、模块依赖和工厂导出后才登记。已经存在的同名同版本不能覆盖。默认附带版本无需再次安装。第一批发布以 GitHub Release 的 npm 兼容 tarball 交付；不要求配置公共 npm 账号。

升级命令写入本机私有请求队列。监督器暂停该实例的新写请求，等待在途分发结束；超过等待窗口则延后并保留原宿主。安全交接后替换宿主并恢复订阅，启动失败自动回到旧包。命令返回具体结果；网关离线时明确显示排队及结果文件路径，不宣称已应用。

旧包和版本绑定保留。`rollback` 仅替换插件及其兼容元数据，不回滚网关操作数据库或原生会话。不同 `stateVersion` 的私有状态格式被拒绝，需要开发者提供并明确执行迁移。没有自动升级或手机插件市场。

## IPC 与恢复边界

宿主使用固定 Node IPC 方法表，传递 SDK 请求、结果和归一化事件。查询异步，订阅以标识管理；函数与 EventEmitter 不跨进程。界面读取代理缓存的状态和快照。附件源仍经原有授权及分块加密通道，浏览器得不到上游地址或凭据。

进程代次同时校验在回复和事件上。宿主崩溃/心跳停止时，仅对应实例暂时不可用；重新连接后重建订阅与快照。已分发的写操作返回“结果待确认”，不自动重发创建、发送或审批。网关已有的持久操作去重和启动恢复继续适用。实例 SDK 不兼容或缺少安装包不会停用其他实例。

权限、预设、创建规则、计划模式、模型与工具菜单从目录/能力声明读取。第三个插件可使用现有公共聊天能力而不改前端。超出现有公共能力的新交互仍需扩展 SDK 与共享组件；不加载浏览器插件 JS，不转发任意上游 RPC。存储适配器继续使用原有独立契约。

## 验证记录（2026-11-06）

- 原有 199 项回归已通过；新增真实宿主测试覆盖三实例同 ID、崩溃、挂起、订阅恢复、迟到代次、未知写结果、重复点击、升级等待/回退、私有状态拒绝迁移、配置迁移及监督器应用。
- SDK、Codex、DSH 的 tarball 各自在仓库外独立安装，模块和 SDK 声明均可加载。
- 第三个测试插件从仓库外发布包加载，使用同一个已构建前端完成加密聊天、刷新恢复和能力菜单；未修改核心产品分支、未重新构建前端。
- 真实 Linux Codex 与两个独立 DSH 宿主同时连接；测试会话历史、权限、模型及快照同步通过。杀死一个 DSH 宿主后自动恢复，另一个保持连接。此轮未向真实会话发送测试消息或反馈，也未启动/关闭原生 Agent。
- 手机视口权限菜单、计划/目标/反馈/导出入口，以及现有配对、草稿、审批、计划卡片、刷新恢复和 320–1280 像素布局回归通过。Android/iOS 真机、macOS/Windows 真桌面仍需另行验收；三系统 CI 的宿主与 Socket/Pipe 契约测试独立记录。

宿主 IPC 参考 [Node child_process.fork](https://nodejs.org/api/child_process.html#child_processforkmodulepath-args-options)；安装流程参考 [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/)。
