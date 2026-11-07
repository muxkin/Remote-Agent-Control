# 架构与协议

通用后端、实例路由、DSH 和三系统连接的当前实现见 [后端架构与兼容配置](BACKENDS.md)。下文保留 Codex follower 及现有加密网络的协议细节。

## 组件

- **Web 客户端**：复用 React/Vite 界面及共享输入框；SyncStore 管理本地缓存，DeviceSession 管理跨聊天复用的加密 WSS/WebRTC 连接。
- **云端协调与中继**：独立静态入口、设备注册、信令和密文转发；不提供桌面 HTTP 代理，不保存桌面会话正文或文件密钥。另有独立的账户与 IM 服务保存即时聊天正文，数据边界见 [即时消息架构](MESSAGING.md)。
- **GatewayCore**：电脑上的统一业务校验、鉴权与分发入口，复用既有控制、请求去重和媒体授权。HostService 主动连接云端，无入站业务端口。
- **Desktop Adapter**：连接桌面 IPC，发现会话 owner，订阅状态并执行已适配的 follower 方法。
- **History Index**：只读查询 Codex SQLite 元数据和 JSONL 历史，不接管桌面持久化。
- **FileService / Media Service**：复用会话附件授权，增加分块直连、加密中继、密文存储回退及缺失块续传。
- **AgentBackend / BackendRegistry**：封装产品语义，按实例路由历史、控制、目录与操作结果。
- **PlatformRuntime / 连接器**：系统路径与私有权限独立于产品发现及通信；支持 POSIX Socket 和 Windows Pipe 验证基础。

Gateway 不启动独立 Codex App Server，也不认领会话执行权。手机断开不终止桌面任务。

网络协议、Noise 身份认证、缓存与同步恢复、文件加密和路由规则见 [v2 协议说明](PROTOCOL_V2.md)。项目 SSH 业务隧道已经移除；管理 SSH 独立于业务链路。

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

桌面 IPC 增量仅应用于匹配的 `baseRevision`，重复或过旧事件忽略；版本缺口触发重新获取桌面快照。手机同步在此基础上使用独立的 `epoch + revision` 和内容哈希清单，连续版本补增量，缺口恢复只传变化的正文。删除、排序和截断均包含在同步中。会话历史按 canonical `turnHistory` 的 islands 顺序解析，不依赖可能为空的旧 `turns` 数组。

写请求携带稳定请求 ID。网关记录收到、分发、接受、完成、拒绝与结果待确认等状态。相同请求不会重复执行；发送超时不证明失败，因此不能盲目重发。中断绑定预期 turn，模型设置使用条件更新以避免覆盖另一客户端刚修改的值。

阻塞问题从 `requests` 读取；异步问题来自助手消息的 `questions`。回答绑定问题标识、源轮次与内容指纹，避免提交过期问题。

## 历史、附件与原生创建

历史读取使用文件身份、字节偏移和残行缓冲，缓存有界，按需分页。Gateway 的设备与操作数据库独立于 Codex 数据库。

存储接口独立于厂商 SDK，仅从部署者显式指定的本地模块加载。私有媒体与公开静态资源分别初始化并校验用途，浏览器直传权限仅放行适配器声明的精确 HTTPS Origin。

附件授权依据当前会话实际出现的 Markdown 链接或结构化附件。媒体字节不随每次文本增量重复传输；手机校验并缓存内容块，Service Worker 提供本地 Range。存储回退只保存独立加密的临时内容块，成功消费后清理。

新建会话经桌面附带的 App Tools Socket 完成，同样校验对端。仅开放所需的项目查询和原生创建能力，创建结果单独记录；不确定结果不重试创建。

## 设计参考

以下项目为交互与架构研究提供了参考：

- [Codex Mini](https://github.com/CoimgRain/Codex-Mini)：移动端体验、队列与缓存思路。
- [codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux)：共享桌面 App Server 的适配思路。
- [Faryo](https://github.com/SongJunguo/faryo-codex-web-ui)：流式和完成态内容渲染。
- [Codex Mobile](https://github.com/Ike-li/codex-mobile)：配对、审批与连接状态处理。

现有 Linux 桌面协议经 CodexBackend 复用；DSH 使用原生 Web 客户端接口，独立维护上游生命周期。
