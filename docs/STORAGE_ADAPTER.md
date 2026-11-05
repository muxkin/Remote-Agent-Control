# 对象存储扩展

附件优先读取手机缓存或通过 WebRTC 直连传输，无需对象存储。无直连时，8 MiB 以内走加密 WSS，更大文件可使用密文对象存储；存储不可用时回退加密 WSS。静态资源可同源提供或使用公共 CDN。仓库不附带厂商 SDK 或部署账号。

## 加载方式

```dotenv
POCKET_MEDIA_ADAPTER=/absolute/path/to/media-adapter.mjs
POCKET_ASSET_ADAPTER=/absolute/path/to/asset-adapter.mjs
```

两项均可独立留空。模块只在服务器端加载，是具有本机权限的受信任代码，不能由手机请求指定。模块路径、凭证和依赖由部署者维护，可放在自行排除的本地目录中。

模块默认导出一个工厂函数，接收 `{ purpose, origin }`。`purpose` 为 `media` 或 `assets`，`origin` 是手机网页地址。工厂应读取自己的服务端配置，检查存储的实际访问权限，再返回适配器。初始化失败会阻止使用该配置启动，避免将私有附件误传到公共存储。

类型定义见 [object-storage.ts](../src/server/object-storage.ts) 和 [storage.ts](../src/shared/storage.ts)。

## 接口约定

| 成员                                                                           | 约定                                                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `version`                                                                      | 固定为 `1`                                                                                                     |
| `visibility`                                                                   | 媒体为 `private`，静态资源为 `public`；工厂必须检查远端实际权限                                                |
| `uploadOrigins`                                                                | 手机直传使用的精确 HTTPS Origin，不包含通配符、路径或凭证；未使用直传可为空                                    |
| `putFile({ key, file, contentType, cacheControl, allowedOrigin, expiresAt? })` | 按提供的元数据上传；只创建新对象，返回 `created` 或 `exists`；私有文件输入已经加密，`expiresAt` 为对象过期时间 |
| `downloadUrl(key, expiresAt)`                                                  | 媒体必需；返回单个对象的 HTTPS 签名链接，`expiresAt` 为 Unix 毫秒时间戳                                        |
| `createUpload({ key, size, expiresAt })`                                       | 媒体必需；返回单对象、精确密文字节数、限定授权有效期的浏览器上传授权；不得返回长期密钥                         |
| `remove(key)`                                                                  | 生产建议必需；用于成功消费后的清理和遗留对象重试清理；缺失时只能依赖提供方生命周期                             |

公开资源发布只调用 `putFile`，保留公共文件的 MIME、编码及缓存元数据。私有下载授权五分钟有效，上传授权十五分钟有效。授权有效期不等于对象保留时间：私有临时对象另需提供方的 24 小时内清理策略，电脑离线时也应生效。下载应支持 Range，CORS 应允许精确应用 origin、Range 并暴露 Content-Range。

私有附件输入固定为 AES-256-GCM 密文和 `application/octet-stream`，不得上传原始名称、明文哈希或解密密钥。每个内容版本使用独立文件密钥，按 1 MiB 明文块加密；连续块合并为小于 16 MiB 的对象。对象键为 `private-encrypted-v2/` 下的随机标识，与公共资源前缀完全分离。

## 手机直传

支持两种返回结构：

```ts
// multipart POST：表单字段来自临时签名策略，文件字段最后追加。
{
  url: 'https://upload.example.com',
  method: 'POST',
  encoding: 'multipart',
  fields: { policy: '<short-lived-object-policy>' },
  fileField: 'file'
}

// 原始字节 PUT：可用于签名 URL 上传。
{
  url: 'https://upload.example.com/object?grant=<short-lived-grant>',
  method: 'PUT',
  encoding: 'raw',
  headers: { 'Content-Type': 'application/octet-stream' }
}
```

网关验证目标属于 `uploadOrigins` 后才返回授权；云端 CSP 需配置对应精确地址。手机不携带网页 Cookie，不跟随上传重定向。手机先加密再上传；Gateway 按块下载、认证解密并验证大小、块哈希和最终文件 SHA-256，未通过验证的文件不能交给桌面。文件清单、原始名称、密钥和临时授权仅通过 Noise 通道传递。

## 验证

```bash
npm run test:storage
```

测试使用临时文件和独立本机状态，验证密文上传、认证解密、完整文件哈希、下载 Range 和二进制 MIME，并检查密文中没有测试明文/文件名，最后删除测试对象。它不会操作桌面会话。部署时仍需在手机浏览器验证 CORS、视频播放，并核实提供方生命周期的实际删除时限。

旧明文对象仅通过运维脚本生成清单：`node --import ./scripts/env.mjs --import tsx scripts/inventory-legacy-storage.ts`。默认不删除；显式 `--clean-verified` 才清理已找到且哈希一致的本机副本对应对象。无副本的条目保留待处理，公共前缀始终排除。适配器可选实现 `list(prefix, marker?)` 供运维清单使用，此接口不向手机开放。清单可能含私有路径和对象名，应保存在私有目录，不纳入公开报告。
