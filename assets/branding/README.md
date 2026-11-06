# Agent 空间图标

选用第一版原创角色图：薄荷银短发、圆形耳机、琥珀色眼睛，手持带连接符号的终端。保留柔和手绘质感和浅紫背景。外部插画只用于画风参考，不直接嵌入或复刻其角色、猫耳、编发、锅具与构图。

- `agent-space-master.png`：生成原稿，后续品牌素材源图。
- `agent-space.ico`：Windows 多尺寸图标。
- `agent-space.icns`：macOS 多尺寸图标。
- 网页 favicon、Apple touch icon、PWA 图标位于 `src/web/public/app-icon-*.png`。

使用内置 imagegen 生成，最终选择第一版。生成提示概要：原创 chibi 遥控员；薄荷银短发、深青色耳机、琥珀色眼睛、小型梅紫终端与双点连接符号；柔和 anime gouache / watercolor 数字插画；浅紫背景；无文字和品牌标识；避免参考图中的角色特征与原构图。

运行 `node scripts/build-icons.mjs`（需要 ImageMagick 7）可从原稿重新打包标准尺寸，不重绘图像内容。PWA 使用 `purpose: any`，不宣称符合未单独设计的 maskable 安全区。原稿及打包资源不包含第三方参考图。
