# 一套应用，两种云端运行方式

VPS/Node 和 Cloudflare 使用同一仓库、同一份业务源码和同一套前端。发布时应从同一源码版本构建；部署位置、启动入口、配置、数据库及对象存储可以不同。不维护“个人版业务代码”和“CF 商业版业务代码”。

电脑端使用纯 Rust Adapter 和独立的 Rust Codex、DSH 插件。桌面端的功能迁移和故障修复在 Rust 实现中完成，迁移验收包含实际运行进程、启动项、原有配对与会话访问。

## 共享边界

| 内容                                         | 唯一实现                                                | 运行方式差异                                   |
| -------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| Web/PWA、消息 UI、工作台                     | `src/web`                                               | 静态文件服务器 / Worker Static Assets          |
| 加密账户、附件解密与导出、客户端协议         | `src/client`、`src/shared`                              | 无平台专用功能分支                             |
| 账户、联系人、消息、附件、手动清理 API       | `src/server/messaging/service-core.ts`、`store-core.ts` | Fastify / Worker HTTP；本机 SQLite / DO SQLite |
| 中转认证、设备连接限额、路由、转发与断线处理 | `src/server/relay-core.ts`                              | Node `ws` / DO 休眠 WebSocket                  |
| 资源计量和额度执行                           | `src/server/resources/service.ts`                       | 使用相同数据库接口；CF 跨 DO 调用同一资源服务  |
| 后台等级与额度                               | `src/server/resources/lago.ts`                          | 同名环境变量 / Worker bindings，读取同一个接口 |
| 浏览器 CSP 与响应安全头                      | `src/server/edge-policy.ts`                             | 各运行时写入自己的 HTTP 响应                   |

`src/server/relay.ts` 和 `src/cloudflare/relay.ts` 只是运行适配器：接入连接、读写会话及路由存储、安排定时器或 alarm，然后调用相同的 `RelayCore`。协议解析、身份校验、配对票据、单设备连接数、流量执行等规则只在共享核心修改。

持久化、图片缩放和对象存储允许分别适配。Node 可以用本机 SQLite、对象存储适配器和 Sharp；CF 使用 DO SQLite、R2 和 Images。DO 名称、持久化结构和休眠会话字段保持兼容；统一源码不要求把两个部署的数据混在一起。

## 启动方式与参数

| 部署角色         | 构建、启动                                                               | 配置来源                                       |
| ---------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| VPS 云端服务     | `npm run build:server`、`npm run build:web`；`npm run relay`             | `POCKET_ENV_FILE` 指定的私有环境文件或进程环境 |
| CF 云端服务      | `npm run build:cf` 检查；`npm run deploy:cf -- --config <配置路径>` 发布 | Wrangler 配置、secrets、bindings               |
| 用户电脑 Gateway | `npm run build`；`npm start`                                             | 自己的 Gateway 环境文件                        |

两个云端入口都支持相同的资源策略参数：`POCKET_LAGO_URL`、`POCKET_LAGO_API_KEY`、`POCKET_LAGO_DEFAULT_PLAN`、`POCKET_RESOURCE_INSTANCE`。未配置资源策略的部署不启用会员额度；配置后使用后台设置的额度。这与选择 VPS 或 CF 无关。你的私人 VPS 可以不配置额度，对外实例可以配置额度，均无需修改或复制业务代码。

`dist/web` 与 `dist/cloudflare-web` 是不同部署的构建输出目录，来源都是 `src/web`。相同公开构建参数下，输出应逐文件一致；CDN 地址不同等明确配置差异会影响构建结果。CF 构建不会自动加载本机的私人 Gateway 配置。

## 防止后续分叉

1. 新功能及修复优先修改共享核心。新增平台代码必须是运行时或基础设施接口的适配，不能自行定义另一套账户、权限、额度或协议规则。
2. Node 和 CF 执行 `test/contracts/relay.ts` 中同一组真实 WebSocket 行为测试，另保留各自运行时的专用测试（例如 DO 休眠）。
3. CI 同时运行 Node 测试、CF 测试以及 `npm run check:deployments`。最后一项走实际 Node/CF 构建入口，逐文件校验同参数前端的 SHA-256，并检查 Worker 打包。
4. 运行中的两个实例可以有不同的发布时间，但后续升级仍取同一套源码。某个实例尚未更新不代表为它维护独立功能分支。

资源规则与后台操作见 [RESOURCE_LIMITS.md](RESOURCE_LIMITS.md)，部署操作分别见 [VPS](CLOUD_DEPLOYMENT.md) 和 [Cloudflare](CLOUDFLARE_DEPLOYMENT.md)。
