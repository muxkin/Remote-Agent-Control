# 电脑适配器与可迁移的更新分发

## Rust + Ely 原生预览

原生适配器位于 `desktop/native`。Windows、Linux 和 macOS 安装包与 CI 生成的便携包使用相同的 Ely 界面，并附带共享网关、Node、Python 和官方插件。Ely 管理托盘、自启动、配对和更新，Agent 由独立插件宿主连接。源码或无网关负载的构建仍可运行独立 Rust Codex 网关。两种模式使用相同的 Noise 配对协议和 SQLite 状态目录。

### 原生安装包

[原生预览发布页](https://github.com/muxkin/Remote-Agent-Control/releases)列出可下载的实际产物。已发布的 0.2.7 提供 Windows 和 Linux 便携包。以下安装包由新的构建流程生成，随通过验收的后续预览标签发布。

| 平台 | 安装包 | 安装方式 |
| --- | --- | --- |
| Windows x64 | `*-windows-x64-setup.exe` | 当前用户安装，安装后从开始菜单打开。从托盘退出适配器后可重新安装或卸载。 |
| macOS Apple Silicon / Intel | `*-macos-arm64.dmg` / `*-macos-x64.dmg` | 将应用拖入 Applications，再打开。以 macOS 14 为构建目标。 |
| Linux x64 | `*-linux-x64.deb` | Ubuntu 24.04 或满足依赖的系统运行 `sudo apt install ./AgentSpace-Native-<版本>-linux-x64.deb`，再从应用菜单打开。 |

安装版与便携版使用同一原生状态目录。切换前先从托盘退出原进程。如果便携版已开启自启动，先关闭，再在安装版启用，使自启动指向安装位置。卸载保留身份、配对和附件数据。Windows 预览安装包没有发布者签名。macOS 预览应用使用本地临时签名（ad-hoc），未经过 Apple 公证。预览安装器通过 GitHub Releases 提供 SHA-256 校验。启用发布密钥的安装版可自动获取更新。

### Agent 插件

安装版沿用[插件 SDK 和监督器](ADAPTER_PLUGINS.md)。默认启用 `codex-local`，DSH 和第三方插件可按实例配置。同一种插件可以同时运行多个实例，各有独立宿主、凭据、数据目录和版本绑定。Ely 的概览和诊断显示各实例的连接状态。

把实例数组保存为原生状态目录下的 `instances.json`，并在同目录下的私有 `gateway.env` 设置对应凭据。现有 `POCKET_ADAPTERS_FILE` 和 `POCKET_BACKENDS_FILE` 可继续使用，优先于默认文件。修改实例配置后重启适配器。终端中的 `agent-space-native --adapter list`、`install`、`upgrade` 和 `rollback` 调用原有插件 CLI。官方插件随整包更新交付，监督器按实例安全交接。

从独立 Rust 网关切换时，安装版继续读取同一设备身份、配对、操作记录和已完成的上传。原生上传仍按设备及会话校验归属，并验证文件摘要。上传中的文件需要重新发送。原有 Rust `transport.env` 专用存储设置应按共享网关的 `gateway.env` 配置映射，已有数据目录保持原位。

### 独立 Agent 的消息和通话

独立 Agent 继续使用原来的加密账号状态文件。已有接入可改用 `agent-space-native --im` 和 `agent-space-native --im-call`，参数与原 CLI 一致。需要桌面端代管时，在原生状态目录放置私有 `im-agents.json`，或用 `POCKET_NATIVE_IM_AGENTS` 指向绝对路径。

```json
[
  {
    "id": "research",
    "state": "/private/research-agent.json",
    "messageHandler": "/private/message-handler.mjs",
    "callHandler": "/private/media-handler.mjs"
  }
]
```

每个配置独立运行，可只启用消息或通话。消息模块导出 `onMessage(event, { messaging, signal })`，需要回复时沿用稳定请求 ID。进度在处理成功后提交，首次接入从当前 cursor 开始，也可通过配置中的 `cursor` 迁移已有进度。通话模块沿用 [Agent 通话处理器](AGENT_CALLS.md)。可选 `environmentFile` 仅加载该 Agent 的私有环境。迁移前退出同一身份的旧接听进程。消息处理或通话结束前，桌面更新会等待。

### 原生安装版自动更新

附带 Ed25519 公钥的安装包默认启用更新。后台首次启动后检查，之后每四小时检查一次。默认跟随当前服务地址，使用 `/downloads/desktop/native/<平台>/<架构>/latest.json`。可在私有 `gateway.env` 用 `POCKET_NATIVE_UPDATE_BASE_URL` 指定 HTTPS 更新根目录，或用 `POCKET_NATIVE_UPDATES=0` 关闭，修改后重启。

更新先验证签名、平台、架构和版本，再从同源下载并验证长度与 SHA-512。安装前向网关确认手机连接、恢复宽限期和在途写操作均已结束。网关停止接入并退出后，独立更新进程才安装并重新启动适配器。使用平台证书的 Windows 安装版还验证 Authenticode。使用 Developer ID 的 macOS 安装版还验证 Gatekeeper。使用发布密钥的 Windows 和 macOS 安装版通过 Ed25519 清单及安装包 SHA-512 验证更新，macOS 另外验证应用内的临时签名。系统正常执行自己的启动策略。Linux DEB 在设置页点「安装已下载更新」，由 apt 和 PolicyKit 授权安装。便携包和缺少发布公钥的构建通过手动更新。

打包时用 `POCKET_NATIVE_GATEWAY_PAYLOAD` 指向已准备的共享网关，`POCKET_NATIVE_UPDATE_PUBLIC_KEY_FILE` 指向 Ed25519 公钥 PEM。CI 可用仓库变量 `POCKET_NATIVE_UPDATE_PUBLIC_KEY` 提供公钥。签名私钥只由发布者在本地持有。发布使用同一 Node/R2 工具，向原有命令增加 `--native-version <版本>`，并以 `POCKET_NATIVE_UPDATE_SIGNING_KEY_FILE` 指定私钥文件。先发布不可覆盖的安装包，再发布签名清单。原有 Electron 清单和下载索引继续独立维护。正式发布前需提升原生版本号并完成各平台安装验收。

仅发布 Windows 和 macOS 的预览安装器时，推送与 Cargo 版本一致的 `native-preview-installers-v<版本>` 标签。CI 以 `--installer --release-key-only` 打包内置发布公钥的 Windows x64 EXE、macOS Apple Silicon 和 Intel DMG，并发布安装器和 SHA-256 文件。验收后使用 `publish.mjs --native-version <版本> --release-key-only` 在可信机器上签署更新清单。更新私钥仅保存在发布机器上。

正式包使用 `native-package.mjs … --installer --signed`。Linux 以 Ed25519 签名清单验证 DEB。Windows 在签名机的证书存储配置 `POCKET_NATIVE_WINDOWS_SIGN_CERT_SHA1`、`POCKET_NATIVE_WINDOWS_TIMESTAMP_URL`，必要时指定 `POCKET_NATIVE_SIGNTOOL`。macOS 在签名机配置 `POCKET_NATIVE_MAC_SIGN_IDENTITY` 和 `POCKET_NATIVE_MAC_NOTARY_PROFILE`，先签名并公证应用，再制作并公证 DMG。发布前在目标系统复核签名。

### 本地构建与功能范围

```bash
cd desktop/native
cargo build --release --locked
```

在 Linux 运行 `./target/release/agent-space-native`，在 Windows 运行 `target\release\agent-space-native.exe`。设置页可输入服务地址和接入密钥，也可用 `POCKET_NATIVE_ORIGIN` 和 `POCKET_NATIVE_ENROLLMENT` 预填。用 `--configure` 重新选择服务。登录自启动应在程序放到固定路径后开启。托盘可用时，关闭窗口会从任务栏移除窗口，连接继续运行。托盘可以重新打开界面，也可以退出适配器。登录自启动直接进入托盘。Linux 桌面入口和 Windows 可执行文件均使用 Agent 空间图标。

默认状态目录为平台用户数据目录下的 `agent-space-native-preview`，也可用 `POCKET_NATIVE_STATE_DIR` 选择独立私有目录。Windows 会检查当前用户和 SYSTEM 的 ACL，Linux 会检查目录和文件的属主与权限。用独立目录试用，以免两个网关以同一身份争用中继。

Codex 目录按 `POCKET_NATIVE_CODEX_HOME`、`CODEX_HOME`、`~/.codex` 的顺序选择。适配器可读取 JSONL 和 Zstandard 压缩会话历史，长回复支持按需展开。工作台的「继续此会话」通过桌面工具打开历史会话，取得实时快照后即可发送、追加和中断。上传使用独立加密数据通道，支持分块校验和断点续传。同一配对设备可下载它在该会话中上传的文件，包括已完成且摘要匹配的旧版上传。会话内嵌媒体和明确引用的工作区附件也使用同一加密传输。可用 `POCKET_NATIVE_LEGACY_STATE` 指定旧版状态目录。用 `POCKET_NATIVE_CODEX_SOCKET` 和 `POCKET_NATIVE_CODEX_EXECUTABLE` 覆盖端点和程序路径，或用 `POCKET_NATIVE_READ_ONLY=1` 禁用实时控制。

项目名称和会话归属读取 Codex 的项目表及桌面保存的显式分组。打开、新建、改名、整段会话分支和用量读取使用经过验证的桌面应用工具。模型目录来自本机 Codex 桌面缓存，模型、推理强度、速度、计划模式及会话权限随桌面状态同步。技能和插件来自当前项目及本机已启用的目录，选择后随下一条新消息发送。Linux 自动发现应用工具端点，Windows 可用 `POCKET_NATIVE_CODEX_APP_TOOLS` 指定本机 Named Pipe。

实时会话和历史里的工具活动可按需查看命令、输出及可用的文件修改详情。查看过的图片归入工具活动。临时图片被清理后，如果同一会话记录中仍有与该次调用逐项匹配的图片数据，适配器可通过原有加密附件通道恢复。

实时会话支持命令和文件审批、按项授权、同步与异步提问、连接器表单、计划确认及原生消息队列。审批回复需匹配当前回合和请求指纹。队列修改前重新读取桌面状态，并在收到桌面确认后同步结果。指定回复分支需要支持 `lastTurnId` 的已验证 Codex CLI。适配器默认查找 Codex 桌面自带的二进制文件，也可用 `POCKET_NATIVE_CODEX_CLI` 指定本机绝对路径。

原生适配器默认尝试 WebRTC，直连和中继共用同一套 Noise 配对协议。可在私有状态目录的 `transport.env` 中设置 `POCKET_NATIVE_P2P=0` 关闭直连，或设置 `POCKET_STUN_URLS` 指定 STUN 服务。配置七牛私有桶后，无法直连时，大附件优先使用对象存储。通过 `POCKET_NATIVE_STORAGE_ENV_FILE` 引用既有网关私有配置，并用 `POCKET_NATIVE_QINIU_UPLOAD_URL` 指定桶所在区域的 HTTPS 上传源。Web 服务的 CSP 和对象存储的 CORS 需要允许该上传路径。对象上传默认按 25 MiB 分组，可用 `POCKET_NATIVE_STORAGE_BATCH_MIB` 调整到 50 MiB。支持该字段的新网页按配置分组，旧网页沿用 15 MiB。1 MiB 校验块保持兼容。

三系统的安装和协议验证入口见 `.github/workflows/desktop-native.yml`。Linux CI 安装 DEB 并用安装后的程序验证协议。macOS CI 挂载 DMG，校验应用包并用其中的程序验证 Socket 对端和协议。Windows CI 验证安装、重装和卸载，并用同一提交的控制台构建验证 Named Pipe 和协议。Windows 和 macOS 的桌面实机验收仍需单独完成。

独立 Rust 便携模式继续面向 Codex。Windows 和 macOS 签名发行及自动安装仍需实机验收。

在仓库根目录运行 `POCKET_NATIVE_TEST_IPC=1 node --import tsx scripts/desktop/native-smoke.ts`，可验证旧身份和配对、新配对、历史、原生会话控制、文件传输和重启恢复。设置 `POCKET_NATIVE_TEST_RELAY=cloudflare` 可使用同一个夹具验证 Cloudflare Worker。Linux 便携包以 Ubuntu 24.04 为构建基线，运行需要 glibc 2.39 或更新版本及系统 XCB、XKB 库。图形构建需要 XKB、Fontconfig 等系统开发库。用 `cargo build --no-default-features --release --locked` 可构建只运行网关的版本，通过 `--headless` 启动。

只运行网关时，可以在 Alpine 等原生 musl 构建环境中使用 `cargo build --release --locked --no-default-features --target x86_64-unknown-linux-musl` 生成静态可执行文件。跨目标构建还需要 musl C 编译器来构建 SQLite 等依赖。Ely 图形版需要动态加载系统的 Vulkan 等图形库。Alpine 上已用 `CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_RUSTFLAGS='-C target-feature=-crt-static'` 构建并启动窗口，需要该系统的 musl 图形运行库。

## 原有 Electron 安装版

在网页“我的 → 电脑适配器”选择已发布的平台安装包。Windows 使用每用户 NSIS 安装程序，macOS 使用 DMG，Linux 使用 AppImage（首次运行需允许执行）。安装包内置 Node、Python、编译后的 Gateway 和官方插件，不要求用户克隆源码、安装 npm 依赖或手动升级插件。

首次打开，填写服务地址；新电脑还需要服务管理员提供的接入密钥。密钥通过系统密钥环加密保存，不写入公开安装包。已安装 Agent 的配置、设备身份和配对沿用原有目录。已有源码版后台服务时，先退出旧 Gateway，再使用桌面管理器，不能同时运行两个监督器；不要删除原数据目录。

点击“生成配对二维码”，在手机上扫码连接。关闭管理器窗口后继续在托盘运行；托盘菜单可退出。默认在用户登录电脑时启动，“登录电脑时自动启动”可关闭。Codex 等原生 Agent 仍须运行。

从源码版服务接管时，如果原服务通过环境文件配置了额外的 Agent、附件存储或自定义状态路径，可以在桌面管理器的用户配置 `settings.json` 里设置 `legacyGateway.environmentFile` 和 `legacyGateway.workingDirectory`。两者使用原服务 `EnvironmentFile` 和 `WorkingDirectory` 的绝对路径。另将 `origin` 设置为原服务的 HTTPS 地址。网关继续读取原私有环境文件，原有相对路径以原工作目录解析。切换前退出旧网关并关闭它的登录自启动，再启动桌面管理器并检查现有配对。

自动更新默认启用，也可关闭。后台每四小时检查自有 HTTPS 发布目录，只下载同源安装包。electron-updater 校验安装包 SHA-512；Windows/macOS 发布还需要平台代码签名。下载后，等待手机会话断开、恢复宽限期结束且没有正在分发的操作，再要求 Gateway 再次确认空闲、停止接入并退出。仅替换适配器程序，不中断原生 Agent 任务，不删除账户、配置或配对数据。

## 更新源与迁移

运行时不固定使用安装包中的域名。默认更新地址由**当前服务地址**计算：`<服务地址>/downloads/desktop/<平台>/<架构>/`。服务从 Cloudflare 迁到 VPS、或反向迁移而域名不变时，无需改客户端配置；更换域名时，在管理器修改服务地址即可同步切换更新源。

如果业务服务和更新分发需要独立迁移，在“后台运行 → 更新来源”填写独立更新根目录（例如 `https://updates.example.com/downloads/desktop/`）。管理器自动补充当前平台和架构；留空恢复跟随服务地址。更新地址、自启动和更新开关保存在安装目录外，后续升级不会覆盖。切换来源时取消旧下载、丢弃旧源待安装状态，防止旧请求返回后继续安装。

`POCKET_DESKTOP_ORIGIN` 只是首次运行的预填服务地址。可选的 `POCKET_DESKTOP_UPDATE_BASE_URL` 也只是首次运行的独立更新源默认值；通常省略，以便跟随服务。预览包禁用更新。不要在源码里填个人域名、R2 bucket、接入密钥或部署凭据。

新域名必须先具备相同的发布目录与安装包，再修改客户端配置；原域名完全失效的客户端无法自动获知新域名，仍可在管理器手动改地址。尽可能保留稳定的服务或更新域名，只调整 DNS/后端。迁移时保留旧安装包和 blockmap，平台代码签名身份保持一致。

## 构建

在对应的操作系统和 CPU 架构构建。使用可迁移的 CPython 3.11+ 完整目录，例如 `uv python install 3.12` 的独立运行时；不要指向系统 Python 的单个可执行文件。Node 来自构建机当前的 Node 24.15+ 安装，发行版应使用官方 Node 二进制。

```bash
npm ci
npm --prefix desktop ci
npm run build
POCKET_DESKTOP_PYTHON=/absolute/path/to/relocatable-python npm run desktop:prepare
POCKET_DESKTOP_ORIGIN=https://your-instance.example \
  npm run desktop:package
```

Windows 的 Python 目录包含 `python.exe`；macOS/Linux 包含 `bin/python3` 及其标准库。打包脚本实际执行复制后的 Python 和 Node，验证运行环境可独立启动。发布目录不包含源码、环境文件、用户数据库或凭据。`dist/desktop-payload` 仅为构建中间目录。

电脑包仅包含 Gateway、独立插件宿主和官方插件压缩包；不携带 VPS 服务、数据库迁移工具和完整 Web 前端。桌面窗口从本地资源加载，工作台继续由现有部署提供。打包所需的 Node 依赖以实际入口的构建清单为准。

用 `node --import tsx scripts/desktop/payload-smoke.ts` 检查已准备的目录，也可把安装包解包后的 `resources/gateway` 作为参数传入。该检查使用临时数据库和中继，验证官方插件解包、网关注册、生成二维码和退出，不依赖本机运行的 Agent。

平台路径为 `win32|darwin|linux` 和 `x64|arm64`；各架构使用自己的更新清单。macOS 发布需要 DMG 与更新 ZIP；Windows 需要 EXE 与 blockmap；Linux 使用 AppImage。生产 Windows/macOS 构建必须设置 `CSC_LINK` / `WIN_CSC_LINK` / `CSC_NAME`，并按 electron-builder 文档配置证书密码、macOS notarization 等。无证书时可运行 `npm run desktop:package -- --preview` 生成仅用于验收的包，预览包不启用自动更新。不能把预览包当作正式发布。

## 发布到 Cloudflare

Worker 的 `/downloads/desktop/` 使用共享下载契约，只允许发布清单、固定格式的安装包和 blockmap，不暴露消息附件。支持 HEAD、ETag、单区间 Range 断点下载。清单不长期缓存，带版本的安装包不可覆盖。

默认使用现有 `IM_MEDIA` R2 bucket 的 `desktop-releases/` 独立前缀；也可配置 `DESKTOP_RELEASES` binding 指向独立发布 bucket。原消息 bucket 及其鉴权不变。无需开启整个 bucket 的公共访问，也无需 GitHub Release。Node 部署可在 `dist/desktop-releases` 放置相同文件，使用相同前端和下载接口。

先更新 Worker，再发布已验证的安装包：

```bash
npm run check:deployments
npm run deploy:cf -- --config /path/to/wrangler.jsonc
node scripts/desktop/publish.mjs \
  --config /path/to/wrangler.jsonc --bucket your-r2-bucket \
  --origin https://your-instance.example --platform linux --arch x64
```

发布脚本先核对清单中的 SHA-512 与文件长度，再上传安装包和 blockmap、确认可下载，最后更新平台清单和网页下载索引。它不会发布源码或调用 GitHub。若需要重发已存在的版本，应增加版本号，保留旧安装包。发布 Windows/macOS 时分别在相应系统签名、验收，再传到相同的 R2 目录结构。

## 发布到 VPS / Node

同一发布脚本也支持本地文件目录，无需 Cloudflare 账户或 R2。把正式签名安装包和对应清单复制到 VPS 的构建输入目录后运行：

```bash
node scripts/desktop/publish.mjs --directory /path/to/installers \
  --output /srv/agent-releases --platform linux --arch x64
# 在 Node relay 环境中设置（不是 Gateway）：
POCKET_DESKTOP_RELEASE_ROOT=/srv/agent-releases
```

目录下生成 `desktop-releases/`，发布时先验证哈希，先写安装包，最后原子替换清单。其他平台和旧版本保留。Node relay 使用与 Worker 相同的下载协议；未配置存储根目录时兼容 `dist/desktop-releases`，生产应使用独立持久目录以免构建清理。迁移 R2 的同名前缀到该目录即可，客户端无需区分存储类型。也可由 Nginx/CDN 直接托管同样的目录，但须保持 HTTPS、Range/HEAD 支持与清单不长期缓存。

## 实际可用性与验证边界

“我的 → 电脑适配器”只展示发布索引里真实存在的正式安装包；未发布平台明确显示待发布。安装程序的构建能力不代表该平台的 Codex 私有协议已经通过真机验收；现有 Windows/macOS 连接器仍按项目兼容矩阵标为实验性。

Codex 用量通过桌面原生 `get_usage_limits` 读取，展示账户共享额度和重置时间，不传递账户 ID、重置券标识或登录凭据。缺失窗口表示不可用，不显示为 0%。当前实测的工具只提供 Codex 额度，未确认独立 Dot 额度接口；不推算或伪造 Dot 数据。

历史附件在完整的所属 rollout（包括 zstd）中逐条授权，不再仅依赖最新一页或桌面 owner。成功读取过且不超过 32 MiB 的附件保留在本机私有缓存，按实例和会话隔离，总上限为 128 个文件、256 MiB，淘汰最久未使用的文件。原文件已经删除且从未缓存的附件无法恢复，页面明确提示重新发送。
