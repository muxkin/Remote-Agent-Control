# Agent 实时音视频通话

打开与自己 Agent 的一对一会话，标题栏提供“语音”和“视频”入口。选定模式后，页面会显示当前接听状态。个人用户发起，Agent 接听。音视频通过 WebRTC 双向传输，识别、推理、语音合成、视频理解或生成由 Agent 的媒体处理器自行完成。

通话中可查看时长、静音、关闭或开启摄像头和挂断。浏览器在点击“开始语音通话”或“开始视频通话”后请求设备权限。挂断、离开页面、权限拒绝或连接失败会释放媒体设备。通话时长从 WebRTC 连通时开始计时。Agent 离线时，页面禁用开始按钮，仍可返回文字聊天。

## 接入现有 Agent

先按 [即时聊天文档](MESSAGING.md) 注册加密 Agent，保管好它的私有状态文件。已有文字 Agent 可以使用同一身份另起通话进程：

```sh
npm run im:call -- --state /private/my-agent.json --handler /private/media-handler.mjs
```

处理器是本地模块，声明真实可用的能力，并处理传入/传出的音视频轨道：

```js
export const capabilities = { audio: true, video: true };
export async function onCall({ call, peer, signal }) {
  // peer 是 werift RTCPeerConnection；应迅速安装轨道处理器并返回。
  // peer.onTrack.subscribe(track => ...)：接收用户的 RTP 音视频。
  // peer.addTrack(outputTrack)：发送 Agent 生成的音频/视频轨道。
  // 模型接收 PCM/图像时，应在这里或独立媒体服务里完成 RTP/编解码转换。
  // 返回 false 拒接，返回函数释放模型、编解码器及媒体资源。
  return () => {
    /* release resources */
  };
}
```

这是媒体处理器接口，并非内置模型。不要只声明能力却未安装媒体处理器；不要把回声测试当成智能对话。也可以使用其他 WebRTC 实现，直接复用 `src/client/calls.ts` 的 `AgentCallsClient` 和以下协议。

## 协议与生命周期

所有路径位于 `/api/im`，沿用账号会话 Cookie 或 Agent Bearer 凭据。SDP 和 ICE candidate 必须通过 `AgentCallsClient.send/decode` 完成加密和签名；上下文为 `call:<call ID>:<signal ID>`，收件人必须精确匹配通话双方。信令不会成为普通聊天消息。

| 接口                                       | 用途                                                               |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `PUT /calls/presence`                      | Agent 声明 `{video, available}`，有效 90 秒，建议每 30 秒续期      |
| `GET /conversations/:id/call-capabilities` | 查询该会话 Agent 的在线接听能力                                    |
| `GET /calls/ice`                           | 获取当前实例的 ICE 配置及短期 TURN 凭据                            |
| `POST /conversations/:id/calls`            | 个人发起 `{id: UUID, mode: "audio"或"video"}`；相同 ID 可安全重试  |
| `GET /calls`                               | 当前账号未结束的通话；Agent 可每秒轮询                             |
| `PATCH /calls/:id`                         | `{action:"accept"或"heartbeat"或"end",reason?}`；只有 Agent 能接听 |
| `POST /calls/:id/signals`                  | 加密信令 `{id: UUID, encrypted}`；相同 ID 和密文可安全重试         |
| `GET /calls/:id?after=N`                   | 通话状态、后续信令和 cursor，建议每秒轮询                          |

双方每 20 秒发送一次心跳。响铃 45 秒无人接听、任一方 90 秒无心跳或单次通话达到一小时会自动结束。一方正通话时不接受并行呼叫。挂断即删除暂存信令；已结束的通话元数据保留最多一天后清理。撤销 Agent 凭据会结束其通话并清除在线能力。恢复网络后应重新呼叫。

媒体不通过聊天附件存储，不录制音视频。WebRTC 使用 DTLS-SRTP；端到端加密信令保护网络地址和协商内容，服务器仍可见参与者、类型及生命周期。处理器如何使用或保存媒体由 Agent 自身实现决定。

## 跨网络配置与迁移

Node/VPS 与 Cloudflare 使用相同业务模块、协议和前端。ICE 地址来自实例配置，没有固定 Cloudflare 域名。可在 Node 环境文件、Worker vars/secrets 或其他部署系统注入：

```dotenv
POCKET_IM_CALL_STUN_URLS=stun:stun.example.com:3478
POCKET_IM_CALL_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
# 与支持 TURN REST 的中继服务共享，仅设置在服务端
POCKET_IM_CALL_TURN_SECRET=replace-with-private-shared-secret
```

逗号分隔多个地址。TURN secret 在服务端生成限时账号密码，原始 secret 不发给浏览器。未配置时使用本地 ICE 候选；局域网测试通过不能保证手机蜂窝网络或不同 NAT 下能够接通。正式跨网络使用应部署/配置可达的 STUN/TURN 服务。TURN 媒体流量由配置的中继服务承担，不占用聊天附件配额。

## 联系人策略

`POCKET_IM_HUMAN_CONTACTS` 默认关闭（缺省或 `false`）。服务端只允许个人与其名下 Agent 建立联系人和新对话；自己的多个 Agent 可以协作。禁止通过直接调用接口、旧私聊、旧群聊或跨账号 Agent 绕过限制。原有跨账号历史保留为只读，不删除用户数据。前端隐藏添加朋友入口。只有实例管理员显式设置 `true` 才恢复可选的人际聊天功能；通话始终限定人与 Agent。

## 验证

`test/contracts/agent-calls.ts` 同时在 Node 和 Cloudflare workerd 执行，覆盖鉴权、默认联系人策略、能力声明、忙线、加密信令、结束及撤销。构建前端后运行 `npm run test:im-calls`，测试会启动本机 Chrome、隔离数据库和合成媒体，验证 WebRTC 双向音视频传输、设备释放、缓存刷新与手机布局。使用远程 CDP 浏览器时，通过 `TEST_CDP_URL` 和 `TEST_BIND` 指定浏览器和它可达的 Tailscale 地址。真实语音模型、物理手机和跨 NAT 连接需要分别验收。
