# 即时消息、联系人与账户

账号密钥、跨设备工作台同步、恢复码和加密协议见 [账号同步与加密存储](ACCOUNT_ENCRYPTION.md)。以下消息对象示例是加密客户端解密后的模型；生产入口不再接受旧版明文消息和附件。

人和 Agent 都是消息用户：都有永久数字字符串 `id`（UID）、唯一 `username` 和昵称，身份类型只影响注册与凭据管理。消息权限与电脑配对、桌面执行权限独立；注册消息账户不会得到任何主机控制权限。

## 当前实现与选型

2026-11-06 对照官方资料评估了以下方案：

| 方案                                                                            | 可复用能力                                                 | 本项目采用时的代价                                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Matrix](https://spec.matrix.org/v1.19/client-server-api/)                      | 标准化账户、房间、同步、访问令牌，以及加密消息协议         | 需要部署 homeserver，并对接房间、设备与密钥生命周期；适合以后需要开放互通时采用                                  |
| [Tinode](https://github.com/tinode/chat/blob/master/docs/API.md)                | 用户、主题、订阅、即时收发；创建账户时可直接登录取得令牌   | 需要独立服务和身份映射；是后续接入完整聊天后端的候选                                                             |
| [OpenIM](https://docs.openim.io/platform-api/user/creating-users/create-a-user) | 业务系统通过后台注册用户、发放用户令牌；客户端 SDK 负责 IM | 仍需自己的业务账户后端；其[部署栈](https://docs.openim.io/docs/guides/deployment/docker-compose)包含多个配套服务 |

当前选择内置 Fastify + SQLite 消息服务，复用现有运行环境，不增加独立 IM 服务依赖；生产媒体使用现有私有对象存储。它是本项目的单聊与群聊实现，**没有集成上述框架，也不宣称兼容它们的协议**。`src/shared/messaging.ts` 定义公共模型和 `MessagingClient` 接口；`EncryptedMessagingClient` 是浏览器和 Node 共用实现，内部以 `HttpMessagingClient` 承载密文请求。以后可以增加传输适配器；现有数据使用 [一次性加密迁移](ACCOUNT_MIGRATION.md)；第三方后端仍需要单独的适配实现。

本版支持：个人注册/登录/退出、自定义头像、昵称与改密、其他设备退出、Agent 邀请注册与凭据管理、联系人备注/屏蔽/移除、单聊、2–50 人群聊与成员管理、Markdown/代码、引用回复、@ 提及、文件与图片、Agent 流式回复与停止、历史搜索/分页、未读/已读、断线补拉与幂等发送。普通联系人支持真实个人账户。

## 账号身份与 UID

用户和 Agent 共用永久 UID 空间，其他对象继续使用 UUID。UID 在数据库中是 `TEXT`，在 JSON、TypeScript、浏览器和 CLI 中始终是字符串；没有 `INT` / `BIGINT` 转换，也不按固定长度截断、补零或校验。格式为无前导零的正十进制数字。`10000000` 只是新服务的起始值，位数会随进位自然增长。通用请求体大小限制仍适用。

分配器将 `last_uid` 作为十进制字符串保存，通过字符串逐位进位。在同一个 `BEGIN IMMEDIATE` 事务中完成读计数器、更新计数器和插入账户，并由用户表主键兜底。多个进程共享此账户数据库时仍按同一分配器分配；已提交的 UID 不因账户删除而回收。未来分片应由统一账号服务分配或原子领取互不重叠的号段，不能复制数据库后各自独立发号。

`ChatUser.id` 为本站 UID，例如 `"10000000"`；`ChatUser.address` 为服务范围内的完整标识，例如 `"10000000@chat.example.com"`。当前支持查找本服务的完整标识，其他服务的标识会拒绝，尚未实现跨站联邦。用户名可写作 `@chatuser`，必须包含字母，不能是纯数字，避免与 UID 混淆；昵称允许重复。密码和 Agent 凭据重置均不改变 UID。

登录和添加联系人使用 `identifier`，接受 UID、用户名、`@用户名` 或本站完整标识；相关 API 的 `userId`、`ownerId`、`mentions` 等字段只接受字符串 UID。新版本直接采用该结构，没有旧 UUID 账户兼容或迁移层。

## 人的使用方式

1. 打开“消息”，填写昵称、用户名和密码。无需邮箱或手机。用户名为 3–32 位字母、数字、`_` 或 `-`，至少包含一个字母，统一转换为小写；密码为 10–128 位。
2. 默认在“联系人 → 接入 Agent”邀请自己的助手；账号之间添加联系人已关闭。只有管理员显式开启 `POCKET_IM_HUMAN_CONTACTS=true` 后，才提供 UID / 用户名添加及朋友筛选。
3. 选择联系人，再点击“发消息”进入单聊。消息按服务端顺序保存；请求失败保留原文，重试复用请求标识。切换模块保留内存中的草稿，退出账户清除草稿。刷新后需重新输入未发送草稿。
4. 在“消息 → ＋ → 新建群聊”选择联系人；群资料中可改名、增删成员、转让群主与解散。新成员可解密加入后发送的加密消息；退出或被移除后无法读取群消息和附件。
5. 在“我的 → 个人资料”的账户设置中修改昵称、密码，查看和复制 UID、完整账号标识，退出当前或其他设备。改密自动撤销其他浏览器会话，当前会话保留。
6. 聊天顶部搜索记录；消息旁可以引用回复，群输入框的 @ 按钮选择成员。可选择或粘贴附件；正在回复时可以继续发送，也可以停止当前输出。

已有设备配对继续使用，不要求先注册消息账户。旧的浏览器本地昵称不作为服务端账户或登录凭据；注册时需要明确选择用户名和密码。

## Agent 的使用方式

用户在“联系人 → 接入 Agent”生成邀请，将注册说明交给 Agent。邀请 15 分钟有效，只能使用一次；同一用户重新生成邀请会使上一份失效。最新版 CLI 在本地生成身份密钥，在注册 POST 中附加 `vault`（公钥及密钥密文），获得自己的 `user`、邀请人 `owner` 和 `token`（`user.id` 与 `owner.id` 均是字符串 UID），并与邀请人互为联系人。

```http
POST /api/im/agents/register
Content-Type: application/json

{"invitation":"<一次性邀请>","username":"research-agent","displayName":"研究助手","vault":"<由加密客户端生成的 AccountVault 对象>"}
```

之后的请求使用 `Authorization: Bearer <token>`。令牌有效期一年；到期、丢失或泄露后，邀请人可在 Agent 接入页重置凭据。重置保留原身份、联系人和历史；撤销立即停止其收发，包含正在等待更新的请求。只允许邀请人管理其 Agent；Agent 不能签发新邀请。

### 命令行工具

仓库提供 `npm run im -- <command>`。注册时从环境变量读取邀请，成功后把凭据以 `0600` 权限写到独立状态文件，不将令牌打印到终端。每个 Agent 应使用独立 `--state` 文件。

```bash
# 在安全的运行环境中设置 POCKET_IM_INVITATION 为用户给出的邀请。
npm run im -- register --origin https://chat.example.com \
  --username research-agent --name 研究助手 --state /private/research-agent.json

npm run im -- contacts --state /private/research-agent.json
npm run im -- add-contact --account 10000001 --state /private/research-agent.json
npm run im -- chat --user <owner.id> --state /private/research-agent.json
npm run im -- send --conversation <conversation.id> --text '我已接入' \
  --request-id <稳定的请求标识> --state /private/research-agent.json
npm run im -- sync --cursor 0 --wait 25000 --state /private/research-agent.json
npm run im -- history --conversation <conversation.id> --state /private/research-agent.json
npm run im -- read --conversation <conversation.id> --sequence <message.sequence> \
  --state /private/research-agent.json
```

`sync` 返回当前用户的变更事件和 `cursor`，并在新事件到达时立即结束等待。调用方保存 cursor 后继续调用；`message` / `message.updated` 事件携带最新消息快照；同一批的同一消息只在最后一次事件附带正文，按 `id` 合并并保留更大的 `revision`。移出群后，旧事件不再返回该群正文。`GET /bootstrap` 原子读取当前账户、通讯录、会话与最新 cursor，适合新客户端首次进入；重连仍应保存并继续旧 cursor，再用历史补齐缺口。历史每页最多 50 条，按时间正序返回；有更早历史时包含 `before`，继续带该参数分页，直到到达已处理的消息位置。接收工具应按消息 `id` 去重，成功处理后再提交自己的进度；不要仅因收到事件就丢弃旧消息。

`send` 必须带 `clientId`（CLI 对应 `--request-id`）。同一发送者和 clientId 对应唯一消息；初始会话、正文、状态、附件、提及与引用都纳入请求指纹。相同创建请求重试返回当前消息（即使流式正文已更新）；换任何初始内容则返回 409。对于网络超时等结果不确定的情况，重用原 clientId 重试。CLI 未指定 request-id 时会生成新值，因此 Agent 的自动重试应显式提供稳定值。

也可以使用 `src/client/encrypted-messaging.ts` 中的 `EncryptedMessagingClient`，或者由任意支持 HTTP/JSON 的 Agent 工具调用接口。此工具不自动启动模型或执行收到的文本；如何回复由 Agent 自身决定。

## 流式回复

流式输出以一条消息的快照更新保存，不会为每段文字创建新消息。只允许 Agent 开始流式回复；只有原发送者可更新。人类会话成员与原发送者可以停止，停止后保留已有内容，后续更新被拒绝。Agent 应收到 `cancelled` 状态或 409 后停止自己的生成；服务器不能直接终止外部模型进程。

```ts
const client = new EncryptedMessagingClient(origin, token);
client.account.activate(saved.user, saved.secrets);
await client.account.refreshItems();
const { message } = await client.send(conversationId, '', stableRequestId, {
  state: 'streaming',
  replyTo: incomingMessageId,
});
// 仅对刚创建、尚未更新的消息执行；恢复时先检查 message.state/revision。
let text = '',
  revision = 0;
for await (const delta of modelOutput) {
  text += delta;
  await client.updateMessage(conversationId, message.id, ++revision, text, 'streaming');
}
await client.updateMessage(conversationId, message.id, ++revision, text, 'complete');
```

实际接入应合并小片段，建议每 200–500 ms 更新一次，每个 Agent 每分钟最多 600 次更新。网络失败时使用**相同 revision、完整正文和状态**重试；不要直接递增版本。409 时读取最新消息，确认取消或版本冲突。超过约 2 分钟无更新的流式消息会标记中断；长时间工具等待期间可发送递增版本的相同正文作为心跳。错误结束使用 `failed`。关闭群或移除发送者会将其进行中的回复设为 `cancelled` 并通知剩余成员。

Agent 在正文出现前也可以上报可公开的工具进度。给 `EncryptedMessagingClient.updateMessage` 传入第六个参数，CLI 对应 `--activities '[{"kind":"search","status":"in_progress"}]'`。传入最多八项的完整快照。省略时沿用已收到的进度，传空数组清除。类型为 `read`、`search`、`fetch`、`execute`、`edit` 或 `other`，状态为 `pending`、`in_progress`、`completed` 或 `failed`。进度与正文一起签名和加密，完成后可在同一条消息内展开查看。

ACP 接入可用 `scripts/im-bot-media.mjs` 的 `createAgentActivityTracker()` 接收 `tool_call` 和 `tool_call_update`，把 `tracker.snapshot()` 交给流式写入器的第三个参数，并从 PATCH 回调传给加密客户端。快照只包含类型和状态。工具标题、路径、参数、原始输出及 `agent_thought_chunk` 均不应转发。

CLI 对应：

```bash
npm run im -- stream-start --conversation CONVERSATION_ID --request-id STABLE_ID
npm run im -- stream-update --conversation CONVERSATION_ID --message MESSAGE_ID \
  --revision 1 --text '当前完整内容' --status streaming
npm run im -- stream-update --conversation CONVERSATION_ID --message MESSAGE_ID \
  --revision 2 --text '最终完整内容' --status complete
npm run im -- cancel --conversation CONVERSATION_ID --message MESSAGE_ID
npm run im -- group --name 讨论组 --members USER_ID,AGENT_ID
npm run im -- group-update --conversation CONVERSATION_ID --add USER_ID
npm run im -- upload --conversation CONVERSATION_ID --file ./result.csv
npm run im -- send --conversation CONVERSATION_ID --attachments FILE_ID --reply MESSAGE_ID
npm run im -- search --conversation CONVERSATION_ID --query 结果
```

这些命令均可附加 `--state /private/research-agent.json`。`send` 支持 `--mentions USER_ID,USER_ID`；`group-update` 支持 `--name`、`--remove`、`--owner` 和 `--close`。

## API

## 问题与一次性授权

消息可附带 `interaction` 卡片，指定会话中的另一位个人用户处理，群聊也不能由其他成员或 Agent 代答。复用工作台的题目面板：支持多题、单选、多选、自定义文字和提交前核对。授权卡片先打开操作详情，再选择“允许本次”或“拒绝”。发起人、接收人都可撤回未处理请求。

```json
{
  "clientId": "stable-request-id",
  "text": "确认交付方案",
  "interaction": {
    "kind": "question",
    "recipientId": "10000000",
    "title": "确认交付方案",
    "description": "请选择需要的文件格式。",
    "questions": [
      {
        "id": "format",
        "header": "格式",
        "question": "希望使用哪种格式？",
        "options": [
          { "label": "PDF", "description": "便于分享" },
          { "label": "Markdown", "description": "便于修改" }
        ]
      }
    ]
  }
}
```

将 `kind` 改为 `approval` 并省略 `questions` 即为授权请求；`description` 应明确具体动作、对象和影响。`expiresAt` 是毫秒时间戳，默认 24 小时，最多七天。请求不可修改；变更动作必须撤回并新建，不能复用旧授权。请求与流式内容、附件、表情包互斥。

个人用户通过 `POST /conversations/:id/messages/:messageId/respond` 提交 `{"answers":{"format":["PDF"]}}` 或 `{"decision":"approve"}` / `{"decision":"reject"}`。服务端校验身份、成员关系、有效期及终态，并在事务内持久化；相同回复重试不重复写入，不同回复冲突返回 409。撤回使用 `POST /conversations/:id/messages/:messageId/interaction/cancel`。移除相关成员或解散群聊会撤回尚未处理的卡片。

Agent 从 `message.updated` 的完整 `message.interaction` 中读取 `id`、`status`、`response`、`respondedBy`、`respondedAt`。状态为 `pending / answered / approved / rejected / cancelled / expired`。只有指定用户返回 `approved` 才表示本次操作获准；普通文本消息不等于授权。Agent 必须按交互 ID 持久化去重，并在实际执行前核对动作与结果；IM 服务记录和传递决定，具体工具执行仍由外部 Agent 实现。此授权不改变工作台或主机权限。

```sh
npm run im -- request --conversation CONVERSATION_ID --file request.json --request-id STABLE_ID
npm run im -- request-cancel --conversation CONVERSATION_ID --message MESSAGE_ID
```

CLI 的 `request.json` 只包含 `interaction` 对象，所有 UID 仍为字符串。每次 `/sync` 后保存并使用返回的 cursor，按消息 ID 和 revision 去重，不要回复自己的消息。

## Emoji、表情包与语音

- 输入框的笑脸按钮打开可搜索的 Emoji 与最近使用记录；选中后插入当前光标位置。
- “我的表情包”支持导入 PNG / JPEG / GIF / WebP，也可收藏会话中的图片。每个最多 2 MiB，每个账户最多 50 个；收藏跨设备同步，删除收藏不影响已经发送的消息。点击收藏发送只提交 `stickerId`，消息保留独立的权限记录，并复用收藏对象；加密表情发送到新消息时会按当前成员重新加密，避免把文件密钥授权给非会话成员。
- 麦克风按钮支持最长 2 分钟录音、停止、试听、重录、加入草稿后发送；离开或取消会停止麦克风，切到后台会停止并保留本次录音供试听。录音只在用户点击“添加到消息”后上传。
- 语音复用共享音频播放器，支持播放、暂停、进度与下载。Agent 可以收发音频附件；文件按字节识别 WAV、MP3、OGG、FLAC、WebM 及 M4A 容器。录音通过 `MediaRecorder.isTypeSupported` 选择浏览器支持的格式，麦克风需要 HTTPS 与用户授权。语音转写和合成由外部 Agent 自行处理；实时双向音视频接入见 [Agent 通话](AGENT_CALLS.md)。

`GET /stickers` 列出自己的收藏；`POST /stickers {conversationId,fileId}` 收藏有权读取的图片；`DELETE /stickers/:id` 删除收藏。发送消息附加 `stickerId`，不能同时附加其他附件。`GET /stickers/:id/file` 仅收藏者可读，已发送表情按普通会话附件权限读取。

```sh
npm run im -- stickers
npm run im -- sticker-save --conversation CONVERSATION_ID --attachments FILE_ID
npm run im -- send --conversation CONVERSATION_ID --sticker STICKER_ID --request-id STABLE_ID
npm run im -- sticker-remove --sticker STICKER_ID
npm run im -- upload --conversation CONVERSATION_ID --file voice.m4a
```

录音生命周期依据 [MDN MediaRecorder 文档](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)，最终音频在 `stop` 前的最后一次 `dataavailable` 到达后组装；不依赖每个数据片段精确计时。

统一前缀为 `/api/im`；错误响应为 `{ "error": "说明" }`。业务接口需要有效凭据。`GET /me` 没有凭据时返回 `{user:null}`，过期或无效凭据返回 401。

| 方法与路径                                           | 输入/用途                                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /status`                                        | 是否要求个人注册码                                                                                        |
| `POST /crypto/register`                              | `username, displayName, vault, auth, recoveryAuth, registrationCode?`                                     |
| `POST /crypto/login`                                 | `identifier, auth, recovery?`；签发 HttpOnly Cookie                                                       |
| `GET /me` / `PATCH /me`                              | 当前账户 / 更新 `displayName`                                                                             |
| `POST /crypto/password`                              | `currentAuth, vault, auth, recoveryAuth, revision, recovery?`                                             |
| `POST /logout` / `POST /logout-others`               | 当前 / 其他浏览器退出                                                                                     |
| `POST /agent-invitations`                            | 个人账户创建一次性邀请                                                                                    |
| `POST /agents/register`                              | `invitation, username, displayName, vault`                                                                |
| `GET /agents`                                        | 自己邀请的 Agent                                                                                          |
| `POST /agents/:id/credentials` / `DELETE`            | 重置 / 撤销自己 Agent 的令牌                                                                              |
| `GET /contacts` / `POST`                             | 通讯录 / 用 `identifier` 添加                                                                             |
| `PATCH /contacts/:id` / `DELETE`                     | `remark?, blocked?` / 移除（屏蔽中需先解除）                                                              |
| `GET /bootstrap`                                     | 账户、通讯录、会话和当前事件位置                                                                          |
| `GET /conversations` / `POST`                        | 会话列表 / 用 `userId` 取得单聊                                                                           |
| `GET /conversations/:id`                             | 会话资料、成员、已读位置                                                                                  |
| `POST /groups`                                       | `name, userIds`；2–50 人                                                                                  |
| `PATCH /groups/:id`                                  | `name?, add?, remove?, ownerId?, closed:true?`                                                            |
| `GET /conversations/:id/messages?before=N`           | 历史每页最多 50 条                                                                                        |
| `POST /conversations/:id/messages`                   | `clientId, text?, state?, attachmentIds?, mentions?, replyTo?, interaction?, stickerId?`                  |
| `GET /conversations/:id/messages/:messageId`         | 一条最新消息                                                                                              |
| `PATCH /conversations/:id/messages/:messageId`       | `revision, text, state`；完整快照                                                                         |
| `POST /conversations/:id/messages/:messageId/cancel` | 停止回复                                                                                                  |
| `GET /conversations/:id/search?q=TEXT&before=N`      | 关键词包含搜索，最多 50 条                                                                                |
| `POST /conversations/:id/files`                      | 密文字节，`Content-Type: application/octet-stream`，`X-File-Name: encrypted.pocket`，`X-Encrypted-Header` |
| `GET /conversations/:id/files/:fileId/:name`         | 读取授权附件；`?download=1` 强制下载                                                                      |
| `DELETE /conversations/:id/files/:fileId`            | 删除自己的未发送附件                                                                                      |
| `POST /conversations/:id/read`                       | `sequence`；本会话已读位置只向前移动                                                                      |
| `GET /sync?cursor=N&wait=25000`                      | 等待最多 25 秒，每批最多 100 个事件                                                                       |

消息 API 正文最多 64,000 字符；浏览器输入框最多 16,000 字符。群主负责改名、邀请、移除、转让和解散；普通成员只能退出。活跃群的群主须先转让或解散才能退出。解散保留现有成员的历史阅读权限。群聊提及作为消息字段保存，当前不提供专门的推送提醒。

## 组件复用与附件

聊天直接复用工作台的 `ChatComposer`、`SendButton`、`RichMessage`（Markdown、代码、数学公式、Mermaid）、`FileAttachment`、`Media`、`AttachmentActions` 、`RequestCards` / `QuestionCard` 和 `ImagePreview`。`AttachmentAccessContext` 为 IM 注入同源且限定当前会话的附件读取方式；原有工作台继续使用桌面授权与加密传输。群消息使用独立轻量容器显示发送者、引用和回执，不复制整套桌面任务/工具状态组件。

每条消息最多 6 个附件，每个 1 字节至 10 MiB，每个账户累计 250 MiB，已迁移的相同内容引用按一份原件计量。上传后先是本人可见草稿，发送消息后才允许当前会话成员读取；附件不能跨会话引用。生产部署将客户端加密后的字节保存在私有对象存储，SQLite 保存权限与引用；未配置存储适配器时才使用 SQLite BLOB。下载保留原始内容。客户端加密前按文件签名识别类型，解密后预览；常见文本验证 UTF-8，HTML/SVG 作为下载文件。浏览器只加载当前群的授权附件，不读取 Agent 发来的任意电脑路径。未发送附件在后续上传时清理超过 24 小时的记录。

## 部署和数据边界

正常 `relay-main` 在 `POCKET_RELAY_STATE` 中创建 `messaging.sqlite`；设备仍用 `relay.sqlite`。IM 使用外键、事务和 WAL，采用统一的账户与群聊结构。功能升级通过新增 `im_message_features` 和 `im_stickers` 表扩展，保留上线后的账号、凭据、UID 分配器及全部聊天历史；发布前备份 SQLite。自定义 `buildRelay` 未指定 IM 路径时使用 `<relay database>.im.sqlite`；未指定任何数据库路径的测试使用内存库。

`POCKET_IM_REGISTRATION_CODE` 可限制个人注册，留空为开放注册，与主机注册密钥独立。反向代理将 `/api/im/*` 转发 relay，超时大于 25 秒，上传请求大小至少 10 MiB，禁用 API 缓存。按部署指南配置可信代理；登录/发送/更新/上传均有限流，长轮询每用户最多 5 条连接。

生产使用 HTTPS。浏览器采用 `HttpOnly + Secure + SameSite=Strict` Cookie（HTTP 预览不设 Secure），有效 30 天；Agent 使用一年有效的 Bearer 令牌。客户端从密码派生登录证明与包装密钥，服务器对登录证明使用随机盐 scrypt；令牌与邀请仅存 SHA-256 摘要。

**即时消息正文与附件统一在客户端加密，服务端保存密文。已有数据先通过 [一次性迁移](ACCOUNT_MIGRATION.md) 转换，服务拒绝混合格式。** 电脑遥控的 Noise 协议不变，桌面消息不写入 IM 库。备份 IM 应使用 SQLite 一致性备份或停服务复制，不能忽略运行中的 WAL。离群后的服务端授权立即收回，但无法撤回对方已经下载的文件。

当前适用于独立的小规模部署：Node 使用单一消息数据库，Cloudflare 使用一个消息 Durable Object，业务逻辑相同。未实现系统推送、在线状态、好友审批、账号注销、第三方登录、跨实例联邦及多副本通知。消息、已发送附件和事件尚无自动保留期限；附件现支持可选的后台资源额度、客户端解密下载和用户手动清理，见 [资源规则](RESOURCE_LIMITS.md)。较大规模服务仍需评估数据库、事件增长和单实例处理能力。Agent 的模型执行、工具调用和恢复逻辑由外部 Agent 负责。

## 验证

`test/messaging.test.ts` 覆盖账户与邀请、密码/会话撤销、实时投递、幂等、群权限与历史边界、流式版本/取消/超时、引用/提及、附件字节/越权/请求限制、UID 字符串精度/跨进程分配/永久性、CSRF、限流、历史分页与重启持久化。浏览器检查覆盖桌面、手机窄屏与深色主题，使用隔离账户，不操作真实桌面会话。工作台另有前端和输入框回归；物理手机、系统推送和生产负载未验证。

`npm test` 包含 ACP 附件/流式辅助模块测试。`npm run test:messaging` 在隔离服务中验证群聊、流式停止、引用/提及、文件与图片、CLI、离线补拉、历史分页、阅读位置保持、移除成员、屏蔽联系人和跨标签页退出；结果与截图默认写入 `/tmp/pocket-im-uid-qa`（可用 `TEST_OUTPUT` 指定）。`test:messaging-design` 使用合成素材验证头像同步、无边框贴图、非模态表情面板、窄屏布局，以及公式字体加载、上下标比例和长公式横向滚动；工作台另有 `test:frontend`、`test:composer` 和 `test:delivery` 回归。

本地浏览器验收需要同源静态构建；预览或验收绑定到本机 Tailscale 地址：

```bash
POCKET_ASSET_BASE= npm run build:web -- --outDir /tmp/pocket-im-web
TEST_BIND=<本机 Tailscale IPv4> TEST_WEB_ROOT=/tmp/pocket-im-web npm run test:messaging
```

请将命令中的地址占位符替换为实际地址。该测试会自行创建并清理隔离数据库，不向生产账户发送消息。

交互与媒体扩展还验证了：多题答复、授权允许/拒绝、指定回答者隔离、撤回/过期/成员变更失效、收藏权限及发送副本、真实 MediaRecorder 录制与双端播放、取消释放麦克风、权限拒绝、Emoji 光标插入及 320/390 px 手机工具栏。新表初始化与重启测试确认既有账户和历史不变。Chrome 使用合成麦克风运行测试，尚未验证 iOS Safari 与物理手机录音。

## 私有媒体与客户端缓存

生产环境通过 `POCKET_IM_MEDIA_ADAPTER` 使用私有对象存储，并通过 `POCKET_IM_MEDIA_ORIGIN` 将该私有域名加入浏览器连接白名单。数据库保存权限、消息关联、密文大小和内容哈希；文件名、类型和原始大小放入加密描述。客户端解密预览，表情发送时为当前接收方重新加密。新上传在对象存储失败时返回错误，不会悄悄回退到 VPS 存储。未配置适配器的本地开发仍可使用 SQLite。

聊天附件不在服务端解码或生成缩略图；公开头像仍由服务端处理。`GET /conversations/:id/files/:fileId/:name?meta=1` 在验证会话权限后返回约五分钟有效的签名访问地址、`cacheKey` 与下载入口；`full=1` 获取原图。普通 GET 返回密文字节，`download=1` 强制下载；原文由加密客户端下载并解密。收藏和头像端点同样支持元信息与原始下载。原图下载经过验证与哈希校验。

浏览器合并并发媒体请求，按账号和内容哈希复用 Blob URL。聊天附件解密后的字节仅在内存缓存（64 MiB 上限），不写入持久化缓存；刷新后重新授权、下载并解密，音频同样在解密后播放。公开头像可使用有 64 MiB 上限的 IndexedDB 缓存。元信息最多复用 20 秒，离开群聊后清理授权元信息，退出或切换账户时中止请求、释放 Blob URL 并清理该账号缓存。

迁移前做在线 SQLite 备份，设置 `POCKET_IM_DATABASE`、`POCKET_IM_MEDIA_ADAPTER`、`POCKET_PUBLIC_ORIGIN`，运行 `node dist/server/messaging-migrate.js`。每个对象上传后重新下载并校验 SHA-256，成功后才清空对应数据库 BLOB。旧版回滚前应暂停写入，运行同一工具的 `--restore-local` 恢复原始字节，不能直接把数据库替换成备份而丢失新消息。私有桶不得对 `im-media-v1/` 设置临时对象过期策略。独立备份需按运营保留策略管理。

## 头像

`POST /me/avatar` 接受 `application/octet-stream`，最多 2 MiB，服务端校验后裁切为 256×256 WebP；`DELETE /me/avatar` 移除。人和 Agent 都可修改自己的头像。`user.avatarUrl` 为含版本号的鉴权地址，仅自己、联系人和共同会话成员可读取。前端账户设置复用同一头像渲染与媒体缓存。

## ACP Agent 接入注意事项

HTTP IM 已支持图片和音频附件，不代表外部 Agent 自动处理它们。接入时必须读取 `message.attachments`，验证会话附件 URL，再按 ACP 初始化声明的 `promptCapabilities` 传入图片或音频；纯附件消息也应进入处理队列。`scripts/im-bot-media.mjs` 提供附件下载、ACP 内容块、显式 `[[附件:工作目录内路径]]` 导出和流式顺序提交的参考实现。未经明确导出标记的本地路径不会自动上传，符号链接越出工作目录会被拒绝。

流式 PATCH 应逐次等待服务器确认后再增加 `revision`；请求结果不明时读取当前消息再决定是否重试。长工具执行期间仍需发送心跳，防止 120 秒无更新导致服务端终止。用户取消或消息进入终态后停止生成与后续附件发送。贴图和附件控制标记应从用户可见文本中去除。语音转写与合成需要 Agent 自行配置服务，IM 不将文本回复伪装成语音回复。

## 启动与消息同步恢复

首屏 HTML、主题初始化、小型启动恢复脚本和初始样式由应用域名提供；其他构建资源仍按 `POCKET_ASSET_BASE` 使用不可变 CDN 缓存。Vue 与主题引擎各自独立打包，应用代码变动时可继续使用这些基础库的缓存。首屏或页面模块等待超过 8 秒会提供重新加载按钮。模块加载失败时可重新加载当前地址，重新请求页面资源。可展开的诊断仅包含错误类别、构建号和资源文件名，不保存原始错误或 URL 查询参数。

消息客户端普通请求超时为 15 秒，25 秒长轮询的请求超时为 35 秒。单次临时失败自动重试，连续失败才显示同步恢复状态；离线显示联网提示。重试间隔从 1 秒逐步增长至最多 10 秒，恢复快照成功立即清除状态，无需再等一次长轮询。联网、回到前台或点击重新连接会中止旧请求并主动恢复，继续使用先前游标补齐事件。

### 默认 Agent 联系人及实时通话

账号间添加联系人默认关闭；实例环境变量 `POCKET_IM_HUMAN_CONTACTS=true` 才显式启用可选社交模式。缺省配置只允许自己的 Agent，跨账号旧会话保留为只读。两种部署运行时均在服务端执行这一策略。

Agent 实时语音和视频通话使用独立的加密信令和 WebRTC 双向媒体通道，接入方式、生命周期和 STUN/TURN 配置见 [Agent 通话](AGENT_CALLS.md)。

加密附件按账号缓存密文至 IndexedDB（64 MB，最近使用优先），刷新后无需重复下载已缓存正文；读取前仍向服务端验证权限，并在本地校验和解密。登出/切换账号会撤销对象 URL 并清理上一账号的缓存。浏览器拒绝或清理持久存储时退回下载，不影响消息正确性。Service Worker 只缓存公共脚本、样式、字体及应用壳，不缓存私有消息或附件明文。
