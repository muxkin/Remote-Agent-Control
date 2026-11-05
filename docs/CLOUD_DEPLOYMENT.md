# 云入口、P2P 与对象存储

云服务器提供 HTTPS 入口，Gateway 在运行桌面应用的电脑上监听 localhost。部署前请准备服务器、域名及服务器的 SSH 登录方式。

## 1. 本地配置

```bash
npm ci
npm run configure
```

编辑 `local/gateway.env`：

```dotenv
POCKET_PORT=4317
POCKET_PUBLIC_ORIGIN=https://codex.example.com
POCKET_P2P=1
```

默认读取 `local/gateway.env`，也可用 `POCKET_ENV_FILE` 指定其他配置文件。以 systemd 运行时通过 `EnvironmentFile` 注入相同配置。配置文件权限应为 `0600`。

## 2. HTTPS 与 SSH 反向隧道

```bash
npm run deploy:render -- --domain codex.example.com --ssh-host my-vps
```

默认输出至 `.deploy/`。`--out` 可修改位置，`--env-file` 可指定生成服务引用的配置文件；`--remote-port` 默认 14317。生成器不修改系统或连接服务器。

1. 将域名解析至自己的服务器，配置 HTTPS。生成的 Caddyfile 将请求转发到服务器回环端口；已有 Nginx 也可使用等价配置，需支持 WebSocket Upgrade。
2. 使用专用 SSH 账号与密钥。生成的 sshd 片段限制远程转发、回环监听和其他 SSH 能力；合并后先校验配置，再重载 SSH。
3. 校验服务器主机密钥，将 SSH 别名、私钥和 known_hosts 保存在本机 SSH 配置目录。
4. 在电脑构建应用，审阅后安装生成的两个 systemd 用户服务。网关和隧道的启动路径需与当前安装位置一致。
5. 确认公开入口可达，再运行 `npm run pair -- --open` 扫码。电脑需保持在线且 Desktop 正在运行。

```bash
npm run build
systemctl --user daemon-reload
systemctl --user enable --now codex-pocket-remote.service codex-pocket-tunnel.service
```

这些服务名来自生成模板。不要覆盖已有同名服务而未核对配置。

## 3. 可选 STUN / P2P

```dotenv
POCKET_STUN_URLS=stun:stun.example.com:3479
```

不硬编码公共 STUN。生成器可输出 coturn 的 `stun-only` 配置与专用服务，默认 UDP 3479，可用 `--stun-port` 调整。需安装 coturn，并在云安全组与主机防火墙放行实际 UDP 端口。

STUN 只帮助发现地址，不转发聊天或文件；本项目不配置 TURN。WSS 先提供正常同步，WebRTC 可用时再切换实时事件和控制，失败自动回退。不支持直连的 NAT 不影响基本功能。设置 `POCKET_P2P=0` 可关闭。

P2P 连接不意味着列表、历史、上传和所有媒体都通过直连。移动网连接成功率与实际流量应在自己的网络测量。

## 4. 可选静态资源 CDN

```dotenv
POCKET_ASSET_BASE=https://static.example.com/pocket/v1/
```

```bash
npm run build
npm run assets:prepare
```

构建与 Gateway 的资源配置必须一致。导出清单位于 `.deploy/asset-manifest.json`，对应文件位于 `.deploy/assets/`；可以使用自己的发布工具上传到静态托管服务。跨域脚本、字体需允许网页 Origin，哈希资源可配置不可变缓存。HTML、配置、设备数据库与会话记录保留在 Gateway。

如果已实现 [静态资源适配器](STORAGE_ADAPTER.md)，设置 `POCKET_ASSET_ADAPTER` 后可运行 `npm run assets:publish`。发布器仅上传清单中的哈希资源，校验导出文件和已经存在的对象内容。

先发布资源，再切换服务构建。旧页面可能仍需旧哈希资源，因此不要立即清除历史构建资源。

## 5. 可选私有会话媒体

默认通过经过认证的 Gateway 传输附件，不需要外部存储账号。手机上传使用分块传输，电脑校验 SHA-256 和文件大小后再交给桌面会话，单文件上限为 256 MiB。

需要分流附件时，可自行接入 [存储适配器](STORAGE_ADAPTER.md)，通过 `POCKET_MEDIA_ADAPTER` 指定本地模块。项目提供通用接口，不内置任何厂商实现或账号配置。

适配器必须使用私有存储，并提供限定对象、大小与有效期的上传凭证以及短期下载链接。浏览器可通过 HTTPS 直接访问存储，视频支持 Range；常见 UTF-8 文本附件显式声明 charset，原文件字节保留。存储的 CORS 配置需允许自己的网页 Origin。

## 6. 更新、验证与回退

- 更新前备份运行配置与旧构建。
- 在独立构建目录完成测试，发布 CDN 后再切换网关，避免覆盖正在运行的文件。
- 网关重启不停止桌面任务。手机恢复连接后重新获取状态；结果待确认时不能盲目重发。
- 回退时恢复上一构建及对应配置，保留设备数据库与原附件，不覆盖 Codex 数据库。

```bash
npm run test:cloud -- <test-thread-id>
npm run test:storage
npm run test:stun -- stun:stun.example.com:3479
```

存储测试需要已配置且支持删除临时对象的适配器，不包含浏览器 CORS 验证；`test:cloud` 默认只读。只有明确增加 `--restart-tunnel` 才会中断隧道以验证恢复，此时所有手机会短暂断线。
