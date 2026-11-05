# 对象存储扩展

默认附件通过 Gateway 上传和下载，无需对象存储。静态资源也可同源提供。需要独立存储时，可实现本地适配器，接入自己选择的服务；仓库不附带厂商 SDK 或部署账号。

## 加载方式

```dotenv
POCKET_MEDIA_ADAPTER=/absolute/path/to/media-adapter.mjs
POCKET_ASSET_ADAPTER=/absolute/path/to/asset-adapter.mjs
```

两项均可独立留空。模块只在服务器端加载，是具有本机权限的受信任代码，不能由手机请求指定。模块路径、凭证和依赖由部署者维护，可放在自行排除的本地目录中。

模块默认导出一个工厂函数，接收 `{ purpose, origin }`。`purpose` 为 `media` 或 `assets`，`origin` 是手机网页地址。工厂应读取自己的服务端配置，检查存储的实际访问权限，再返回适配器。初始化失败会阻止使用该配置启动，避免将私有附件误传到公共存储。

类型定义见 [object-storage.ts](../src/server/object-storage.ts) 和 [storage.ts](../src/shared/storage.ts)。

## 接口约定

| 成员                                                               | 约定                                                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `version`                                                          | 固定为 `1`                                                                                   |
| `visibility`                                                       | 媒体为 `private`，静态资源为 `public`；工厂必须检查远端实际权限                              |
| `uploadOrigins`                                                    | 手机直传使用的精确 HTTPS Origin，不包含通配符、路径或凭证；未使用直传可为空                  |
| `putFile({ key, file, contentType, cacheControl, allowedOrigin })` | 保留本地文件字节、按提供的元数据上传；只创建新对象，返回 `created` 或 `exists`；其他情况抛错 |
| `downloadUrl(key, expiresAt)`                                      | 媒体必需；返回单个对象的 HTTPS 签名链接，`expiresAt` 为 Unix 毫秒时间戳                      |
| `createUpload({ key, size, expiresAt })`                           | 媒体必需；返回单对象、精确大小、限定有效期的浏览器上传授权；不得返回长期密钥                 |
| `remove(key)`                                                      | 可选；删除测试对象，运行 `test:storage` 时必需                                               |

公开资源发布只调用 `putFile`。媒体下载授权五分钟有效，手机直传授权十五分钟有效。适配器应设置临时上传对象的过期清理策略，并支持下载 Range。`putFile` 的文本 `contentType` 可能包含 `charset=utf-8`，不得丢弃或重新编码文件。

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

网关验证目标属于 `uploadOrigins` 后才返回授权；CSP 仅加入这些精确地址。手机不携带网页 Cookie，不跟随上传重定向。上传完成后，Gateway 下载对象并验证大小与 SHA-256，未通过验证的文件不能作为消息附件。

## 验证

```bash
npm run test:storage
```

测试使用临时文件，检查原始字节、中文文本类型、Range、过期下载链接以及直传后的校验，最后删除临时对象。它不会操作桌面会话。部署时仍需在手机浏览器验证 CORS、视频播放和签名链接续期。
