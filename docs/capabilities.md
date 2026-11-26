# Folio 浏览器能力与验收范围

基线为 Apple《无边记使用手册》列出的创作、组织、协作与导出任务。Folio 使用 Quickdraw 0.3.0 的编辑器及文档模型，在 Bun、Hono 和 SQLite 上保存和同步画板。下表给出浏览器操作及验收方式。[Apple 功能目录](https://support.apple.com/guide/freeform/welcome/mac) · [Quickdraw](https://tryquickdraw.com/)

| 任务 | Folio 实现 | 验收证据与覆盖边界 |
| --- | --- | --- |
| 无限画布 | 平移、缩放、双指导航、适应内容和多种背景网格。画布坐标与屏幕像素独立。 | 手机、窄屏手机、平板触屏仿真通过绘制、撤销、插入和菜单操作。见 `touch-devices.json`。 |
| 手写和绘画 | 钢笔、铅笔、马克笔可调颜色与线宽；保留压力、双轴倾角、笔杆旋转和切向压力。绘图辅助提供套索、整笔和局部橡皮、定角直尺。 | 在相同 18 px 铅笔设置下，截图实测轻压、重压、X 向侧锋、Y 向侧锋对应宽度为 6、16、64、18 CSS px。笔与触点并用时未额外落墨。直尺横线的纵向漂移为 0；套索选中一个对象；局部擦除可撤销并重做。见 `pressure-tilt.json`、`drawing-aids.json`。 |
| 对象与排版 | 文本框、便签、基础几何、直线和箭头，支持对象级字号、字体、颜色、线型与填充。支持拖动、缩放、旋转、层次、分组、锁定、对齐、对象描述。 | 浏览器实测锁定对象后按 Delete 保留对象，描述同步至独立会话。见 `objects-sync.json`。当前文字样式以对象为单位；同一段落的混合加粗、链接标记等富文本样式仍有差异。 |
| 表格与流程图 | 可编辑文本单元格，增减行列；批量生成流程节点，连接线两端随节点移动。 | 两个浏览器对同一单元格冲突编辑后保留了双方的值。三节点、两条绑定箭头的流程图同步通过。见 `objects-sync.json`。形状布尔运算、苹果内容中心的图形素材仍有差异。 |
| 图片、网页与附件 | 图片的矩形裁剪与椭圆蒙版、网页链接、通用附件、PDF 和浏览器可解码的音视频；粘贴、拖入或文件选择器上传。附件按画板鉴权。 | 裁剪双色图后只剩蓝色，蒙版、撤销和重做均通过像素检查。断网重新打开，颜色与在线版本相同。音视频播放进度实际前进，四份附件下载字节一致。在关闭原生 PDF 阅读器的无头环境，内置 PDF.js 阅读器的前进与后退按页显示红、蓝、红三次预期像素。视频编解码器取决于浏览器与系统。见 `offline-images.json`、`media.json`。 |
| 画板内查找替换 | 使用 ⌘/Ctrl+F 或“更多操作”逐处跳转、缩放定位。可替换便签、正文、图形标签、描述、表格。文件名、网址和锁定对象可搜索。全部替换可一次撤销。 | 已在浏览器创建三处表格匹配，依次验证单处替换、全部替换和撤销。`extras.test.ts` 另测字面符号、大小写和只读字段。手写字词识别仍待实现。 |
| 场景与演示 | 保存当前视区、重命名、调整顺序、重新取景、移除、跳转，按方向键演示。场景随画板同步。 | 实测重排两个场景、刷新保序、切换演示、按场景恢复缩放，以及删除后撤销。见 `scenes-export.json`。 |
| 整理和跨画板搜索 | 按标题、对象文本和描述等字段搜索；收藏、文件夹和废纸篓支持整理与恢复。 | 真实页面验证搜索、收藏、移动、文件夹重命名、移入废纸篓和恢复。见 `browser-library.json`。 |
| 在线协作光标 | 协作者可以看到对方的光标、跟随对方视区、主动退出跟随。临时位置不进入画板历史。 | 两个独立身份实测跟随至 153% 缩放，平移后的光标误差为 0 px；手动导航退出跟随，对端离开后光标消失，文档版本未变。见 `presence-follow.json`。 |
| 共享、断网与设备 | 共享链接区分编辑者和查看者，可撤销授权。设备可配对进入同一工作区，并可断开丢失的设备。已访问画板支持离线笔迹和恢复联网后的补传。 | 三个独立浏览器身份验证权限和双向收敛；独立设备配对，两个离线标签页关闭重开，服务进程强制终止后恢复。见 `collaboration.json`、`revocation.json`、`device-sync.json`、`trusted-devices.json`、`offline-conflict.json`、`offline-restart.json`。 |
| 导出和交付 | 整板 PNG、整板 PDF、单场景 PDF、逐场景多页 PDF，以及含素材原始字节的可编辑 Folio 副本。 | 实测 PDF 页数为 1 和 2。副本导入后使用独立附件地址，重新导出的 PNG 与原图逐像素一致。断网导出保留了已缓存的原始附件。PDF 各页采用 JPEG 栅格，最长边上限 3072 px，每页约 600 万像素；文字无法作为 PDF 文本选择。 |

## 实际画板

浏览器 Agent 通过工具栏和笔指针绘制《海岸骑行 · 鹈鹕》。本次记录包含 196 个墨迹对象和 4,975 个采样点。刷新前后对象相同，同一视区图像平均绝对像素差为 0。原始测量在 `evidence/pen-evidence.json`，可编辑文件为 `evidence/pelican.folio.json`。验收重放命令见 `qa/README.md`。

## 与 Apple 原生环境的差异

- 设备实测仍需 iPad 与真实 Apple Pencil。Chromium 的合成压力、倾角和旋转能验证事件、宽度计算、保存与重绘；摩擦感、端到端延迟、硬件双击、悬停、捏压和不同驱动的实际体验需要分别测量。[Apple Pencil 设备能力](https://support.apple.com/en-mt/guide/ipad/-ipadc55b6c7a/ipados)
- Folio 提供三种笔刷。Apple 的水彩、蜡笔、芦苇笔与特定笔尖材质、闭区填色、基于手写识别的搜索和整理仍有功能差距。[Apple 绘画工具](https://support.apple.com/en-euro/guide/iphone/iphe749c1957/27/ios/27) · [Apple 查找与替换](https://support.apple.com/guide/freeform/search-your-boards-frfm18ab658ed/mac)
- Folio 使用独立工作区、互联网链接和自有副本格式。iCloud、FaceTime、信息、Spotlight、连续互通相机和 Apple Creator Studio 的账号、付费内容、AI 生图与超分辨率属于 Apple 生态。当前版本没有 Apple 原生文件互操作、系统扫描与这些服务的验收记录。[Apple 协作](https://support.apple.com/en-sg/guide/freeform/frfm4e6e2c9a6/mac) · [Apple 图片和扫描](https://support.apple.com/en-gb/guide/freeform/frfma66848a4/5.0/mac/27)
- 复杂画板可保留原始可编辑副本，或通过多个场景分别导出局部高清图页。场景导出和原始笔迹分别服务于呈现与继续编辑。[Apple 场景语义](https://support.apple.com/guide/freeform/navigate-and-present-scenes-frfm7cc55b64/mac)
