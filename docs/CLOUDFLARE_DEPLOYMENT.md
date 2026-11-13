# Cloudflare 部署

VPS 和 Cloudflare 是同一套应用的两种部署方式，使用同一份前端、消息业务和中转核心，差异仅在启动入口、基础设施适配及配置，见 [统一部署架构](DEPLOYMENT_ARCHITECTURE.md)。已有 VPS 服务继续使用 [VPS 部署指南](CLOUD_DEPLOYMENT.md)；这里用于新建独立 CF 实例，不搬迁或共享 VPS 数据库。前端、消息账户、加密协议和电脑 Gateway 保持相同逻辑。

## 运行结构

| 组件                   | CF 实现                                                        |
| ---------------------- | -------------------------------------------------------------- |
| Web/PWA                | Worker Static Assets，构建到 `dist/cloudflare-web`             |
| `/connect` 加密中继    | `RelayHub` Durable Object，control/bulk 双通道、休眠 WebSocket |
| `/api/im/*` 账户与消息 | `MessagingHub` Durable Object + SQLite，复用现有消息处理代码   |
| 消息附件、表情包、头像 | 私有 `IM_MEDIA` R2 bucket；下载仍经过账户/成员授权             |
| 头像缩放               | `IMAGES` binding，256 × 256 WebP                               |
| Agent Gateway          | 仍在用户电脑运行；主动连接选定的 CF 或 VPS 入口                |

手机仍先建立加密 WSS，再按现有设置尝试 STUN/WebRTC 直连；这次适配没有增加 TURN。工作台和消息模块都保留。电脑会话附件仍使用既有直连/WSS 或 Gateway 自行配置的对象存储。

CF 的 R2 用于持久保存**消息模块**的附件。为保留现有 10 MiB 上传上限，大文件不经过 DO SQLite BLOB 临时落库；消息正文和附件密钥仍由客户端加密。头像与现有服务一样不属于消息密文。当前完整 CF 配置需要 R2 和 Images，不把 R2 当实时中继。不要给消息 bucket 配置 24 小时自动删除规则，历史消息仍会引用这些对象。

## 新实例安装

本地构建工具需要 Node.js 24.15+。CF 云端不需要运行 Node 守护进程、反向代理或电脑插件宿主。

```bash
npm ci
npx wrangler login
```

编辑仓库根目录 `wrangler.jsonc`：

- `name`：自己的 Worker 名称。
- `vars.POCKET_PUBLIC_ORIGIN`：用户最终访问的精确 HTTPS origin，无路径、末尾斜杠。例如 `https://pocket.example.com` 或自己的 `https://<worker>.<subdomain>.workers.dev`。
- `r2_buckets[0].bucket_name`：自己的私有消息 bucket 名称。
- 自定义域名可添加 `"routes": [{ "pattern": "pocket.example.com", "custom_domain": true }]`；域名须在自己的 CF 账户中。使用 `workers.dev` 时无需添加此项。

创建与配置一致的 bucket，并设置独立主机注册密钥：

```bash
npx wrangler r2 bucket create pocket-im-media
npx wrangler secret put POCKET_RELAY_ENROLLMENT
# 可选：限制个人账户注册；不设置则开放自助注册。
npx wrangler secret put POCKET_IM_REGISTRATION_CODE
```

`POCKET_RELAY_ENROLLMENT` 使用随机生成且至少 32 字符的私有值，在部署者和获准接入的 Gateway 之间传递。不要使用 VPS 的凭据，也不要将凭据写进 `wrangler.jsonc`。确认账户已启用 R2，并可使用 Images binding；图片处理按 Cloudflare 的 [Images binding 规则](https://developers.cloudflare.com/images/optimization/binding/)计费。SQLite DO 同时支持 Free 和 Paid，具体配额、运行时长费用见 [DO 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)；本地测试不能证明生产流量在免费额度内。

```bash
npm run typecheck
npm run typecheck:cf
npm run test:cf
npm run build:cf     # 构建和部署 dry-run，不发布
npm run deploy:cf    # 发布自己的 CF 实例
```

CF 脚本不会自动读取 `local/gateway.env`，也不覆盖 VPS 的 `dist/web`。默认使用同源静态资源。需要专门的 CF 构建环境文件时显式设置 `POCKET_CF_ENV_FILE`；需要 CDN 时使用 `POCKET_CF_ASSET_BASE` 或在该文件中设置 `POCKET_ASSET_BASE`，并将相同值写入 Wrangler 的 `vars.POCKET_ASSET_BASE`、自行发布 CDN 文件。现有 Gateway 外部对象存储还需要在 `vars.POCKET_UPLOAD_ORIGINS` 中允许其精确 HTTPS origin。

需要提供站内划词翻译时，在 `vars.POCKET_TRANSLATION_URL` 中设置 Worker 可访问的 LibreTranslate HTTPS 地址，例如 `https://translate.example.com/translate`。服务需要密钥时，运行 `npx wrangler secret put POCKET_TRANSLATION_API_KEY`。所选文字仅在用户主动选择站内翻译时发给该服务。具体说明见 [VPS 部署指南](CLOUD_DEPLOYMENT.md#可选的站内划词翻译)。

## 接入电脑与消息账户

在**接入这个新实例的电脑**上配置自己的 `local/gateway.env`：

```dotenv
POCKET_PUBLIC_ORIGIN=https://pocket.example.com
POCKET_RELAY_ENROLLMENT=<这个CF实例的主机注册密钥>
POCKET_P2P=1
# 可选：按现有部署方式设置 STUN。
# POCKET_STUN_URLS=stun:stun.example.com:3479
```

然后按现有流程执行 `npm run build`、`npm start`、`npm run pair -- --open`，在 PWA 扫码添加电脑。只使用消息功能的用户可以直接注册消息账户，无需部署 Gateway。Agent 消息账户仍通过用户签发的一次性邀请接入，参见 [消息与 Agent API](MESSAGING.md)。VPS 和 CF 实例中的账户、UID、配对及消息独立，选择入口不等于跨实例同步。

## 本地测试与开发预览

`npm run test:cf` 使用隔离的 Miniflare/workerd、临时 SQLite/R2、模拟 Images 和测试 Gateway；不会读取真实桌面会话或使用 CF 云端数据。覆盖账户恢复、消息长轮询、9 MiB 密文附件、访问控制、头像、DO 重建/过期任务、真实 Noise 配对/RPC、休眠后中继、双通道和设备配额。自动化测试只监听 loopback。

需要向 Tailscale 设备展示预览时，创建忽略提交的 `.dev.vars`，写入测试注册密钥和准确的 HTTPS origin，例如 `https://100.x.y.z:8787`，再执行：

```bash
npm run dev:cf -- --ip "$(tailscale ip -4)" --local-protocol https --port 8787
```

使用测试账户，按 Wrangler 的本地 HTTPS 证书配置使访问设备信任证书。正式域名上线后还需验收 TLS、真实 Images 服务、移动网络的 WSS/直连、后台恢复和实际费用。本地运行时与打包检查不等于已通过公网部署或负载测试。

## 运维边界

每个部署固定一个中继 DO 和一个消息 DO，保留现有全局中继配额、单一消息数据库发号、幂等写入和事务语义。路由和配额通过 SQLite/套接字 attachment 在休眠后恢复；主机签名认证、一次性配对票据、每设备跨双通道 8 个连接的限制保持一致。断线后客户端与 Gateway 使用现有重连流程。消息流超时和交互卡片过期由 DO alarm 处理；长轮询保留原来的最多 25 秒等待，会影响 DO 活跃时长费用。

这不是跨区域数据库分片或多活部署。单个消息 DO 的存储、CPU、内存和请求处理能力受 [DO 平台限制](https://developers.cloudflare.com/durable-objects/platform/limits/)约束；适合先按独立小实例验收和测量。附件保存在 R2，消息、事件及账户元数据仍会增长。升级前备份/保留 DO SQLite 的恢复能力及关联 R2 对象；不要重命名 DO 类、binding、对象名称或删除 namespace 来“重新部署”，那会产生不同的数据实例。删除消息引用不等于立即清理底层对象，共享的对象清理队列会核对引用并重试底层删除。

代码默认不启用 Worker 请求日志。运维时也不要记录请求正文、Cookie、票据、配对链接或账号密钥。当前适配不包含旧 VPS 数据导入及双向同步。

## Optional resource policies

The same resource-policy interface is available on Cloudflare and Node. See [RESOURCE_LIMITS.md](RESOURCE_LIMITS.md) for server-only Lago bindings, quotas, monthly WSS metering and client-side decrypted export/manual cleanup. Membership amounts are managed in Lago.
