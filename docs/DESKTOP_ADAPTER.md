# 电脑适配器与可迁移的更新分发

## 用户安装

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
