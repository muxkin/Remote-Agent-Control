# 一次性账号加密迁移

迁移保留现有 UID、用户名、联系人、群、消息 ID/顺序/时间、正文、回复关系、授权结果、附件和表情收藏。结果使用与新账号完全相同的密文格式。正式服务没有明文登录、明文收发或旧数据兼容模式；检测到未迁移数据时拒绝启动。

迁移工具独立于正式服务：`npm run im:migrate -- ...`。`export/apply/commit` 在停服的中继上运行；`prepare/encrypt` 在各账号拥有者自己的可信设备运行。不要把任何人的私钥、密码、恢复码或 `private-state.json` 交给服务器或其他账号。个人账号需要各自参与一次；Agent 由其拥有者处理。服务器只收集 enrollment 和签名密文 part。

生产构建也包含独立可执行文件：`node dist/server/account-encryption-migrate.js ...`，参数与上述命令相同。它不依赖源码或 `tsx`，但需要发布包中的生产依赖及媒体适配器配置。

## 1. 停服并按账号导出

保持中继停服直到 commit 成功。使用原数据库所在的受限目录，所有输出默认 `0600`。对现有备份使用受控的加密存储。

```sh
npm run im:migrate -- export \
  --database /private/messaging.sqlite \
  --out /private/migration-jobs \
  --origin https://chat.example.com \
  --adapter /private/media-adapter.mjs
```

未使用对象存储时省略 `--adapter`。导出会下载原附件并验证原大小与对象哈希；缺失或损坏时停止。`migration-jobs/<UID>.json` 只交给对应账号拥有者，包含该账号发出的消息、上传的文件、收藏和做出的交互回复。导出包含待迁移原文，必须通过受控私有通道传递。所有包绑定同一数据库快照。

## 2. 每个账号在自己设备生成身份

```sh
npm run im:migrate -- prepare \
  --job /private/my-job.json \
  --state /private/private-state.json \
  --out /private/enrollment.json
```

个人账号通过终端不回显输入**不同于旧密码的新密码**；恢复码保存在本机 `private-state.json`，请另外安全保存。若账号已有加密身份，工具解锁并保留该身份。Agent 可以增加 `--agent-state /private/previous-agent.json`，保留自己的令牌及服务地址；迁移完成后，将新生成的 private-state 用作 Agent CLI 的 `--state`。

只把 `enrollment.json` 交给迁移操作员。该文件包含公钥、加密密钥包和登录证明，仍按私密凭据处理；不包含可解密内容的私钥或恢复码。

## 3. 分发公钥目录并分别加密

操作员将各 enrollment 的文件路径写入 JSON 数组 `enrollments.json`：

```json
["/private/enrollment-alice.json", "/private/enrollment-agent.json"]
```

```sh
npm run im:migrate -- directory \
  --enrollments /private/enrollments.json --out /private/public-directory.json
```

将公钥目录通过可信渠道交给每个账号拥有者。各自在自己的设备运行：

```sh
npm run im:migrate -- encrypt \
  --job /private/my-job.json \
  --state /private/private-state.json \
  --directory /private/public-directory.json \
  --out /private/encrypted-part.json
```

工具对每条消息、附件和授权回复加密，并本地解密逐项比对，再签名整个迁移包。聊天接收方使用对应账号公钥，私有收藏仅授权收藏者。任何接收方缺少密钥都会停止。只将 `encrypted-part.json` 返回操作员；私钥留在拥有者设备。

## 4. 验证并生成新数据库

操作员把每个密文 part 的路径写入 JSON 数组 `parts.json`，在原数据库同一文件系统生成候选数据库：

```sh
npm run im:migrate -- apply \
  --database /private/messaging.sqlite \
  --parts /private/parts.json \
  --out /private/messaging.encrypted.sqlite \
  --receipt /private/migration-receipt.json
```

工具要求每个账号恰好一个包；验证快照、身份、签名及记录完整性。缺失账号、篡改、源数据库变化或缺少授权回复都会拒绝切换。失败时清理工具新建的候选副本，原数据库保持不变。通过后清除候选库的空闲明文页与 WAL；所有正文、文件和私钥包都必须满足正式服务的加密格式检查。

## 5. 一次切换并清理被替换的对象

```sh
npm run im:migrate -- commit \
  --database /private/messaging.sqlite \
  --receipt /private/migration-receipt.json \
  --origin https://chat.example.com \
  --adapter /private/media-adapter.mjs
```

commit 再次确认源库未变化、候选库未被改写，然后在原路径原子替换为密文库，并删除不再被任何记录使用的旧媒体对象。存在需要清理的旧对象时，适配器必须支持 `remove()`；清理失败可在保持停服的情况下用同一 receipt 重试。共用公开头像对象不会误删。候选库中的附件密文可继续使用 SQLite，或用现有媒体搬迁工具上传私有对象存储。

成功后启动新版中继，个人账号用新密码登录，Agent 使用自己的新状态文件。最后清理迁移原文导出包与临时 enrollment；私钥状态文件仅由拥有者保留。对对象存储历史版本及外部备份，按同一次迁移的清单完成转换或受控清理，不能把它们作为第二条在线读取路径。

## 验证覆盖

`test/account-migration.test.ts` 覆盖历史保留、多人解密、附件逐字节一致、签名授权结果、缺包/篡改失败、源库不变、候选库无原文明文、启动拒绝混合格式及明文接口不存在。迁移工具不会在账号界面加入记录数量提示。
