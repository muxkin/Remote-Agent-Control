# v2 部署与回滚

公网入口由独立云端服务提供；电脑离线时仍可打开 PWA、查看本地缓存。电脑只向云端建立 WSS，并尝试 WebRTC 直连。业务链路不再使用 SSH、反向端口映射或本机 HTTP 代理。服务器管理 SSH 保持独立。

## 配置与安装

电脑和云端均使用 Node.js 24+。电脑额外需要现有 Linux 桌面应用和 Python IPC 校验桥。运行 `npm ci`、`npm run build`。公共资源默认同源，不需要 CDN。启用 CDN 时，生产构建和运行的 `POCKET_ASSET_BASE` 必须一致；先发布 CDN 哈希文件，再切换 HTML。

电脑 `local/gateway.env`：

```dotenv
POCKET_PUBLIC_ORIGIN=https://codex.example.com
POCKET_RELAY_ENROLLMENT=<随机生成的至少32字节凭据>
POCKET_P2P=1
POCKET_STUN_URLS=stun:stun.example.com:3479
```

云端另建私有配置，不要复制电脑的环境文件或对象存储凭据：

```dotenv
POCKET_PUBLIC_ORIGIN=https://codex.example.com
POCKET_RELAY_ENROLLMENT=<相同的注册凭据>
POCKET_RELAY_BIND=127.0.0.1
POCKET_RELAY_PORT=4318
POCKET_RELAY_STATE=/var/lib/codex-pocket-relay
POCKET_WEB_ROOT=/opt/codex-pocket/current/dist/web
# 与构建一致的公共资源源：
# POCKET_ASSET_BASE=https://static.example.com/pocket/v1/
# 私有上传端点和密文下载域名，逗号分隔，均为精确 HTTPS origin：
# POCKET_UPLOAD_ORIGINS=https://upload.example.com,https://objects.example.com
```

运行 `npm run deploy:render -- --domain codex.example.com` 生成可审查的主机/中继 systemd 单元和反向代理示例。生成器不修改服务器。`--relay-root` 设置云端发行目录，`--relay-node` 设置云端 Node.js 的绝对路径（默认 `/usr/bin/node`）；请按实际安装位置调整。云端入口为 `dist/server/relay-main.js`；电脑入口为 `dist/server/main.js`。反向代理保留 Host、Origin 和 WebSocket Upgrade，关闭业务正文日志、请求缓冲和自动重试。只代理云端服务，不能再指向电脑端口。STUN 只做地址发现；不配置 TURN。

部署静态应用后启动云端服务，再启动电脑 Gateway。运行 `npm run pair -- --open`，手机重新扫码一次。配对密钥只在二维码 fragment 和端点内出现；禁止把二维码、身份私钥或完整环境文件写入公开日志。

开发预览绑定 Tailscale 地址；自动化隔离测试使用 loopback，不连接真实工作会话。公网服务必须使用 HTTPS。

## 对象存储

对象存储与 CDN 均为可选项，由自己的适配器和配置接入；不配置时附件使用加密直连/WSS，静态资源由云端入口同源提供。新附件只使用 `private-encrypted-v2/` 前缀，随机对象名、二进制类型，内容与文件名/密钥分开传输。适配器须支持私有下载、Range、浏览器 CORS、临时上传、删除及 24 小时过期策略。CORS 应允许应用的精确 origin 和 Range，并暴露 Content-Range。成功消费后删除；主机清理失败会重试，提供方生命周期负责电脑离线期间的遗留对象。

不得因升级直接删除旧附件。为 `private-uploads/` 和 `private-media/` 单独生成清单；只有本机副本存在且哈希一致才清理。没有核实副本的对象保留待处理；公共静态资源前缀必须排除。新版不签发旧明文下载链接。

## 切换与回滚

1. 保存当前源码/发行包、桌面环境文件、本机身份/操作数据库的 SQLite 一致性备份、Nginx 配置和服务单元。保留原始会话和附件目录。
2. 隔离验证新发行包。发布静态资源及云端服务，检查 `/health`、TLS 和未认证访问。
3. 切换本机 Gateway 和代理目标，完成加密配对、直连及纯中继验证。
4. 停用并移除项目专用 SSH 隧道单元、专用转发公钥/配置和旧端口映射。管理 SSH 不变。上一发行包和旧单元只保存在私有回滚目录，不作为第三条运行路径。
5. 保留数据库新增表及操作记录。回滚应用时不要覆盖恢复旧数据库，也不要自动重放结果不明确的操作。旧版无法使用新版设备身份，需要相应重新配对。

回滚需要同时恢复上一发行包、电脑环境、代理目标及其对应服务；先停止新版，确认原始会话/附件仍在，再启动上一版。旧隧道只可在明确执行回滚时恢复。不要清理仍有未确认操作的桌面数据。

## 验证

- `npm run typecheck`、`npm test`：协议、增量、权限、现有桌面行为及回归。
- 单独构建测试 Web：`POCKET_ENV_FILE=/dev/null npx vite build --outDir ../../.implementation/web`。
- `npm run test:v2`：独立模拟桌面，Chrome 移动视口，验证直连/中继、连接复用、缓存及上传。
- `node --import ./scripts/env.mjs --import tsx scripts/v2-storage-smoke.ts`：实际存储上的可删除密文测试对象，不使用真实附件。
- `npm run test:cloud -- <会话UUID>`：公网只读加密验收，临时设备随后撤销，不写入桌面会话。

旧 HTTP UI 脚本是 v1 历史验证材料，不能替代 v2 传输验收。真实 Android/iOS、蜂窝网络、后台挂起、配额回收和跨网络 IPv6 必须另记录实测结果，模拟器或本机直连不算真机验收。
