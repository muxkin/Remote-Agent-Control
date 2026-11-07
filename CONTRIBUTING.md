# 开发与贡献

项目使用 Node.js 24+。提交改动前运行：

```bash
npm ci
npm test
npm run typecheck
POCKET_ENV_FILE=/dev/null npm run build
```

不要在运行中的发行目录执行试验构建；先构建到隔离目录并验证，再切换发行包。网页开发预览绑定本机 Tailscale 地址，供自己的 Tailscale 设备访问。

## 目录结构

| 目录         | 内容                                                       |
| ------------ | ---------------------------------------------------------- |
| `src/web`    | 现有界面、DeviceSession、持久缓存、文件内容提供器          |
| `src/server` | GatewayCore、主机连接、独立云端中继、桌面与平台接口        |
| `src/shared` | 业务协议、Noise 通道、增量与文件编码                       |
| `src/client` | 公网验证使用的加密 Node 客户端                             |
| `test`       | 单元、业务与真实 WSS 协议夹具；`legacy` 仅保留 v1 回归夹具 |
| `scripts`    | 浏览器测试、诊断、密文存储验证与部署工具                   |

## v2 验证

浏览器测试需要 Chrome。生成独立的同源前端构建后运行隔离测试：

```bash
POCKET_ENV_FILE=/dev/null npx vite build --outDir ../../.implementation/web
npm run test:browser
npm run test:frontend
npm run test:layout
npm run test:composer
npm run test:delivery
npm run test:messaging
npm run test:messaging-design
```

`test:browser` 与 `test:v2` 为同一套测试。它启动 loopback 上的临时中继和模拟桌面，不操作真实桌面会话，覆盖连接复用、直连/中继切换、文件和缓存。不要把测试夹具作为外部预览服务。`TEST_WEB_ROOT` 指定本次验收的构建目录，`TEST_PORT` 可指定隔离端口；需要跨设备预览时将 `TEST_BIND` 设为本机 Tailscale 地址。

`test:delivery` 注入慢响应、结果未知、明确拒绝和迟到回执，验证发送提示、草稿保留及刷新后的请求日志；`test:messaging-design` 使用合成图片验证头像同步、表情面板和窄屏布局，不依赖个人素材。ACP 附件与流式辅助模块测试包含在默认 `npm test` 中。

以下测试读取私有部署配置：

```bash
npm run test:cloud -- <existing-thread-uuid>
npm run test:public-browser -- <existing-thread-uuid>
npm run test:storage
```

前两项只读真实桌面会话，验证后撤销临时测试设备；浏览器测试会填写但不会提交新会话草稿。存储测试创建可删除的合成密文对象，不使用真实附件。结果保存在私有 `.test-output` 目录，发布报告前需脱敏。

`test:legacy:*` 和相应脚本仅作为 v1 历史材料，依赖旧 HTTP 页面/接口，不能针对 v2 线上入口运行或计为 v2 验收。v1 的控制测试会修改专用测试会话，仍要求原有 `--allow-control` 显式开关；不能指向工作会话。

真实手机、蜂窝网络、后台恢复、浏览器配额回收和 Windows/macOS 协议必须另做实测。当前结果和缺口见 [v2 验证记录](docs/VALIDATION_V2.md)。

## 提交问题和改动

问题描述请附桌面版本、浏览器版本、复现步骤，以及预期和实际行为。日志与截图应移除凭证、真实会话内容和个人路径。

PR 请说明用户可见的变化与验证方式。涉及桌面内部协议的改动，应保持会话归属校验、请求去重和未知结果保护；未知协议不能自动退回另一个 Agent 执行。

## 发布检查

在干净的工作目录使用官方 npm registry 安装并运行上述检查。构建时设置 `POCKET_ENV_FILE=/dev/null`，同时清除继承的 `POCKET_*` 部署变量，避免把私人 CDN 地址写入静态资源。

暂存待发布文件后运行 `npm run check:public`。检查针对 Git 暂存区，拒绝配置、身份/数据库、私有部署目录、诊断输出及已知凭据模式，并在本机环境文件存在时检测其中的敏感值。不要强制添加被忽略的目录或把环境文件复制成普通源码文件。

自动检查不能证明没有泄露：仍需复核 Git 历史、提交者邮箱、截图与二进制元数据，以及新引入的外部服务地址。只发布通用示例配置；中继、STUN、存储适配器和 CDN 均由部署者配置，不能内置个人服务。发布包只从通过检查的 Git 树生成，不打包整个工作目录。
