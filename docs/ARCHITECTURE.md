# 架构与协议

## 组件

- **Web 客户端**：React/Vite，负责会话展示、草稿、问题与审批交互，以及 WebSocket/WebRTC 连接。
- **Gateway**：Fastify 服务，负责配对、鉴权、固定控制 API、请求去重和媒体授权。
- **Desktop Adapter**：连接桌面 IPC，发现会话 owner，订阅状态并执行已适配的 follower 方法。
- **History Index**：只读查询 Codex SQLite 元数据和 JSONL 历史，不接管桌面持久化。
- **Media Service**：按会话附件授权读取文件；通过可选存储适配器支持私有附件直传直读。

Gateway 不启动独立 Codex App Server，也不认领会话执行权。手机断开不终止桌面任务。

## 桌面连接

当前适配 `chatgpt-bin 26.1029.61003-1`、内置 Codex `0.166.0-alpha.6`。连接使用桌面内部 IPC，不能视为稳定公共 API。

IPC 使用四字节 little-endian 长度前缀及 UTF-8 JSON。初始化获得 follower client ID 后，通过 owner discovery 找到会话拥有者，订阅和控制请求定向到该 owner。Python 桥接利用 `SO_PEERCRED` 验证实际 Socket 对端进程，并检查文件属主与权限。

| 方法                                     | 适配版本 | 用途               |
| ---------------------------------------- | -------- | ------------------ |
| `initialize`                             | 0        | 初始化客户端       |
| `thread-owner-discovery`                 | 1        | 查找会话 owner     |
| `thread-stream-following-changed`        | 1        | 订阅与退订         |
| `thread-stream-state-changed`            | 11       | 状态快照与增量     |
| `thread-follower-start-turn`             | 2        | 开始新一轮         |
| `thread-follower-interrupt-turn`         | 4        | 中断预期 turn      |
| `thread-follower-steer-turn`             | 1        | 向当前任务追加指令 |
| `thread-follower-read-model-settings`    | 1        | 读取模型设置       |
| `thread-follower-update-thread-settings` | 2        | 条件更新下一轮设置 |
| `thread-follower-submit-user-input`      | 1        | 回答阻塞问题       |

未知桌面或事件版本会关闭控制；不会自动切换到独立 daemon。Gateway 不开放任意 IPC/RPC 转发。

## 状态与操作语义

增量仅应用于匹配的 `baseRevision`，重复或过旧事件忽略；版本缺口触发重新获取快照。重连后重新发现 owner 和 revision。会话历史按 canonical `turnHistory` 的 islands 顺序解析，不依赖可能为空的旧 `turns` 数组。

写请求携带稳定请求 ID。网关记录收到、分发、接受、完成、拒绝与结果待确认等状态。相同请求不会重复执行；发送超时不证明失败，因此不能盲目重发。中断绑定预期 turn，模型设置使用条件更新以避免覆盖另一客户端刚修改的值。

阻塞问题从 `requests` 读取；异步问题来自助手消息的 `questions`。回答绑定问题标识、源轮次与内容指纹，避免提交过期问题。

## 历史、附件与原生创建

历史读取使用文件身份、字节偏移和残行缓冲，缓存有界，按需分页。Gateway 的设备与操作数据库独立于 Codex 数据库。

存储接口独立于厂商 SDK，仅从部署者显式指定的本地模块加载。私有媒体与公开静态资源分别初始化并校验用途，浏览器直传权限仅放行适配器声明的精确 HTTPS Origin。

附件授权依据当前会话实际出现的 Markdown 链接或结构化附件。媒体字节不随每次文本增量重复传输；对象存储链接短期有效，视频可按 Range 读取并续签。

新建会话经桌面附带的 App Tools Socket 完成，同样校验对端。仅开放所需的项目查询和原生创建能力，创建结果单独记录；不确定结果不重试创建。

## 设计参考

以下项目为交互与架构研究提供了参考：

- [Codex Mini](https://github.com/CoimgRain/Codex-Mini)：移动端体验、队列与缓存思路。
- [codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux)：共享桌面 App Server 的适配思路。
- [Faryo](https://github.com/SongJunguo/faryo-codex-web-ui)：流式和完成态内容渲染。
- [Codex Mobile](https://github.com/Ike-li/codex-mobile)：配对、审批与连接状态处理。

本项目的传输适配围绕现有 Linux 桌面会话独立实现。
