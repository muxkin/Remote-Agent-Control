# 开发与贡献

项目使用 Node.js 24+。提交改动前运行：

```bash
npm ci
npm test
npm run typecheck
npm run build
```

## 目录结构

| 目录         | 内容                                     |
| ------------ | ---------------------------------------- |
| `src/web`    | 手机界面、富内容渲染与交互面板           |
| `src/server` | 桌面连接、历史索引、网关、配对与附件服务 |
| `src/shared` | 共享类型与增量协议                       |
| `test`       | 单元测试和合成协议夹具                   |
| `scripts`    | 浏览器测试、诊断与部署工具               |

## 浏览器测试

需要已安装 Chrome 和 ffmpeg。生成独立的同源前端构建后运行隔离测试：

```bash
POCKET_ASSET_BASE='' npx vite build --outDir /tmp/pocket-fixture-web
POCKET_TEST_WEB_ROOT=/tmp/pocket-fixture-web npm run test:content
POCKET_TEST_WEB_ROOT=/tmp/pocket-fixture-web npm run test:question-ui
```

隔离测试不操作真实桌面会话。涉及实际桌面控制的脚本要求显式指定专用空闲测试会话与 `--allow-control`：

```bash
npm run test:live -- <test-thread-id> --allow-control
npm run test:browser -- <test-thread-id> --allow-control
npm run test:requests -- <test-thread-id> --allow-control
```

这些测试会发送消息、修改设置或中断任务，请勿使用工作会话。更改协议适配时，应增加相应夹具，并说明测试的桌面版本与尚未覆盖的场景。

## 提交问题和改动

问题描述请附桌面版本、浏览器版本、复现步骤，以及预期和实际行为。日志与截图应移除凭证、真实会话内容和个人路径。

PR 请说明用户可见的变化与验证方式。涉及桌面内部协议的改动，应保持会话归属校验、请求去重和未知结果保护；未知协议不能自动退回另一个 Agent 执行。
