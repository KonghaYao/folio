# 浏览器验收

在仓库根目录执行。应用依赖由 Bun 安装，浏览器验收使用独立的 Python 环境。Playwright 可管理 Chromium，也可用环境变量 `CHROMIUM_PATH` 指定已有 Chromium 可执行文件。只有生成绘画缩时视频需要本机 `ffmpeg`，须支持 H.264 编码。

```sh
bun install --frozen-lockfile
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r qa/requirements.txt
python -m playwright install chromium
python qa/run.py
```

Linux CI 首次运行可以使用 `python -m playwright install --with-deps chromium` 安装系统依赖。Bun 不在 PATH 时，可用 `BUN_PATH` 指定。运行器构建生产客户端，在临时目录创建 SQLite 数据库并监听随机的本机端口。各场景分别打开独立会话，进程重启测试使用单独的数据库。任何断言失败都会让运行器返回非零状态码。

## 重放单项

```sh
python qa/run.py draw
python qa/run.py pen_lab sharing
FOLIO_REFERENCE_IMAGE=/path/to/reference.png python qa/run.py reference_ui
```

| 场景 | 浏览器操作与验收依据 |
| --- | --- |
| `draw` | 新建会话、重命名画板，点击工具切换颜色和线宽，以 Chromium CDP 发送真实指针输入绘制整幅骑行鹈鹕。刷新页面后对比对象和相同视区的像素，最后从导出菜单下载可编辑副本。 |
| `pen_lab` | 固定线宽，改变压感和倾斜方向并从截图测量笔迹宽度。橡皮、撤销、重做分别核验持久化结果。双触点与笔同时落下，再独立双指缩放，核验笔迹数量、坐标和相机变化。 |
| `revocation` | 撤销协作者的编辑权限，观察已打开画板即时降级。随后撤销查看权限，验证用户可以返回自己的画板。 |
| `sharing` | 用三个独立身份分别打开所有者、编辑者、只读查看者界面，验证双向同步、只读工具和键盘按键。 |
| `library` | 查找画板，自定义文件夹和收藏，验证废纸篓与恢复动作。 |
| `scenes_export` | 加入图片附件，管理并播放场景，校验 PNG、PDF 以及可恢复的画板副本。 |
| `mobile` | 在手机、窄屏手机和平板视口验证绘制、工具栏和弹出菜单。 |
| `trusted_devices` | 撤销配对设备，验证已打开的画板退出、两个设备各自的原有文档与切换后的身份。 |
| `device_sync` | 绑定设备、切换身份，断网期间编辑并重连，再终止和重启服务进程验证恢复。 |
| `offline` | 在持久化浏览器配置中离线关闭、重开，核验两个标签页的待上传笔迹恢复并只提交一次。 |
| `offline_immediate` | 在两个标签页抬笔后立即关闭浏览器。离线重启并重连后，验证两笔均仅提交一次。 |
| `offline_conflict` | 两个离线标签分别编辑同一个对象，冷启动后重新提交原操作，验证冲突副本保留两份内容。 |
| `offline_images` | 上传双色样图，剪掉红色部分，应用椭圆蒙版，撤销、重做，导出 PNG 和副本。重新导入、刷新和离线冷启动后测量蓝色像素个数。 |
| `drawing_aids` | 检查直尺、套索、局部橡皮与历史回放，取消含 2,054 个采样的笔迹，验证跨画板粘贴图片及目标用户访问。 |
| `presence` | 两个浏览器查看对方光标、跟随缩放及平移，手动导航退出；确认画板版本号不变，离开后协作者消失。 |
| `media` | 在附件对话框实际播放 WAV、WebM，在无内置 PDF 查看器的 Chromium 中测量 PDF 第一、二页的红蓝像素与来回翻页，打开文本附件，逐一核验下载字节。 |
| `reference_ui` | 从菜单打开 Agent Design 示例画板。验证平板布局、画笔托盘和视区。设置 `FOLIO_REFERENCE_IMAGE` 可额外对比用户提供的原图。 |
| `objects_sync` | 双浏览器验证对象编辑、格式操作、说明及协作冲突。 |

## 查看证据

- `evidence/acceptance.json` 汇总全量场景的退出码、耗时、独立证据和 SHA-256。运行器同时记录源代码和生产构建的摘要，完整验收期间发生变更会使测试失败。
- `evidence/pelican-studio.png` 和 `pelican-reloaded.png` 是同一张画板在刷新前后的浏览器截图。
- `evidence/pelican.png` 由产品的“整张画板 · PNG”导出，包括完整作品及画布背景。
- `evidence/pelican.folio.json` 是从产品界面下载的可编辑副本，可通过“更多操作 → 导入画板”打开。
- `evidence/drawing-timelapse.mp4` 将真实浏览器在绘制过程中的截图依序压缩为缩时视频。
- `evidence/pen-evidence.json` 记录每一笔输入、采样总数、压力/倾斜范围、刷新对比及浏览器异常。设置 `QA_TRACE=1` 可另存 Playwright trace。
- `evidence/pressure-tilt.png` 的四列依次为轻压、重压、向 X 倾斜、向 Y 倾斜。原始测量见同名 JSON。

上述压力和触点来自 Chromium 的合成设备输入。Apple Pencil 的真实摩擦感、延迟、手掌接触面积和厂商驱动差异需要在对应硬件上体验。

## WebKit 与 Chromium 互操作

两种浏览器引擎的附加测试从独立的 Bun 服务启动，使用设备配对连接工作区，并在两端各绘制一笔，检查 WebKit 刷新后的对象数。安装两个受支持的浏览器及依赖后执行以下命令。

```sh
bun run build
python -m playwright install --with-deps chromium webkit
python qa/webkit_smoke.py
```

可以通过 `WEBKIT_PATH` 和 `CHROMIUM_PATH` 指定可执行文件。Linux WebKit 的结果覆盖 WebKit 引擎执行路径；iPadOS 系统、Safari 浏览器界面与真实 Apple Pencil 仍需实机验收。

## 验证 Chat 与反向画布 MCP

`python qa/run.py chat` 是完整套件中的自动化回归。浏览器从界面设置 OpenAI 兼容服务、模型、URL 和临时密钥。隔离的本机 HTTP 服务提供确定性模型响应，Folio 使用实际的 `@peri-code/sdk` Wasm 运行时完成每一轮工具发现和调用。测试在桌面打开 Chat 创建并修改便签，验证另一独立会话的同步结果、只读权限、已配对手机的私人历史、停止、401 后恢复，以及刷新后重新输入密钥。回执保存在 `evidence/chat.json`。构建完成后可用 `FOLIO_QA_ENTRY=service/index.js python qa/chat.py` 直接验证交付包内的服务入口。

### 独立 Luna 代理绘画验收

`qa/chat_luna.py` 需要一个单独运行的 Luna 模型代理和支持 H.264 的 ffmpeg、ffprobe。每次指定新的交换目录，启动后模型代理须在当前会话内消费实际请求。

```sh
bun run build
python qa/chat_luna.py --bridge "$(mktemp -d)"
```

脚本将模型请求原子写入终端显示的 `requests/0001.json` 等文件。代理读取本轮 `messages` 和 `tools`，将生成的答复先写临时文件，再重命名到同一交换目录的 `responses/0001.json`。支持的答复形如 `{"text":"…"}` 或 `{"tool_calls":[{"name":"…","arguments":{…}}]}`。用户提示、模型输出和工具结果均沿真实 Folio Chat、Peri、浏览器 MCP 通道流转，交换目录仅用于测试模型传输。代理给出最终答复后，脚本校验保存与刷新、通过界面导出可编辑副本，并导入新画板比较全部记录。

此次独立 GPT-6 Luna 代理根据“画一只骑单车的鹈鹕，保留可编辑笔迹。”完成作品。完整录屏 `evidence/chat-luna-pelican.mp4` 来自实际 Chromium 画面，保留模型等待时间及工具调用失败后的修正。短版 `evidence/chat-luna-preview.mp4` 取自同一录屏，缩短静止画面。最终截图、可导入的 `.folio.json` 副本及各次模型交换的摘要保存在 `evidence/chat-luna*`。

## 服务端大画板压测

先执行 `bun run build`，再运行以下命令。脚本只使用 Python 标准库和 Bun，启动独立服务，通过 HTTP 写入 50,000 个对象、共享只读权限，在线备份后将同一份数据恢复到新服务。它测量完整快照、全量追赶增量、两个对象的增量、批量写入以及两台设备同时首次读取。Linux 下通过服务进程的 VmHWM 记录内存高水位。

```sh
python qa/server_scale.py --runs 7 --compact-boundary --output evidence/server-scale.json
```

加入 `--baseline /path/to/previous/folio` 可与已有的生产构建对比。结果保留每次请求的原始耗时。`--compact-boundary` 会逐批写入小矩形，直到下一条超过画板现有的 32 MiB 对象正文上限，再重启服务并以查看者身份完整读取。物件数随笔迹采样数、文字长度和附件引用等内容而变化。该测量包含 HTTP 接收，浏览器帧率需要单独测量。

大画板的浏览器对照测试使用 `python qa/perf_matrix.py`。数据集、视口、原始指标与重复运行步骤见[大画板浏览器对照说明](performance.md)。
