# 大画板的真实浏览器对照测试

`perf_matrix.py` 逐次启动已构建的 Folio 服务和真实 headless Chromium。对照的两份工程目录都需要含有 `dist/` 和 `service/index.js`。在安装 `qa/requirements.txt` 和 Chromium 后，于工程根目录执行以下命令。运行器接受 `BUN_PATH` 和 `CHROMIUM_PATH`。

```sh
python qa/perf_matrix.py \
  --baseline /path/to/baseline/folio \
  --optimized /path/to/optimized/folio \
  --out /tmp/folio-performance-results
```

默认规模为 1,000、10,000、50,000 和 100,000 个对象。较小规模每个版本各运行一次。较大规模采用基线、优化、优化、基线的交错顺序。使用 `--counts`、`--small-runs` 或 `--large-runs` 调整。每个场景的 JSON 保存原始帧间隔、输入延迟样本、数据摘要和阶段结果。`matrix.json` 将每次运行的结果分开列出，再计算运行间中位数。输出目录必须是新目录，避免覆盖之前的记录。默认上限为单次 180 秒及 Linux 进程树 RSS 总和（含浏览器子进程，共享页可能重复计入） 3,500 MiB。超限会终止该次运行，保留最后的阶段、耗时及失败原因。

## 数据与用户操作

数据按确定性的网格分布，默认中心间距约 90 个画布单位，包含 85% 可编辑几何图形、10% 压感笔迹和 5% 便签。数据通过具有所有者权限的标准 HTTP 接口按每批最多 2,000 个对象写入，每次启动时使用一个新的 SQLite 数据库。生成时间单列。新浏览器只继承登录 Cookie，包含画板、静态资源的浏览器缓存和离线缓存都从空状态开始。对象总数、缩放百分比、画布截图与摄像机位置用来验证用户实际看到的视口。

| 指标 | 起点、终点与样本 |
| --- | --- |
| 冷打开 | 页面导航的 Performance 时间原点至画布已就绪之后第二次 rAF。在截图中核对可见彩色像素和对象数量。 |
| 整板及 100% 平移 | Chromium 原生滚动手势，从视口中心横向 420、纵向 100 像素往返，速度 650 像素/秒。整板使用产品实际打开的缩放值。 |
| 100% 附近缩放 | Chromium 连续发送 36 个带 Ctrl 的滚轮事件，先缩小再放大，测得实际页面缩放值序列。 |
| 帧间隔与掉帧 | 在手势执行期间记录 rAF 时间戳，给出 P50、P95、最大值与按 60Hz 间隔估算的错过刷新占比。在每次原生 wheel 事件上另计至第二次 rAF 的延迟上界，并单列手势结束后 500 毫秒的帧间隔，以观察延迟重绘。 |
| 笔迹与同步 | 笔尖以 0.73 压力、24°/−16° 倾斜输入 16 个位置。记录笔移动至第二次 rAF 的延迟上界、落笔至服务端操作响应结束，以及独立只读设备更新对象数时的耗时。 |
| 持久化 | 检查服务器的实际笔迹样本、压力和倾斜，验证双方读取完全相同的增量。刷新所有者画板，重算全部原始对象的 SHA-256，并检查新增笔迹逐字段一致。 |

默认使用 1280 × 800 CSS 像素、DPR 1、Chromium 软件渲染，并保留产品的存储、撤销、重做、同步与渲染路径。测试记录的两次 rAF 是对显示机会的估计，真实屏幕扫描、硬件笔延迟和公网往返时间需要单独测量。服务端文件系统与操作系统页缓存保持常规状态。

### 六端并发写入

`python qa/multiwriter_scale.py --baseline /path/to/previous/folio --output evidence/multiwriter-scale.json` 在同一份 50,000 个混合图形的备份上，分别启动两个构建。六个独立的编辑者使用相同的初始版本，各提交 120 个互不重叠的对象修改。两名查看者在同一批请求中首次打开画板，并继续按版本追赶。脚本核对 720 个连续提交版本、每个读取结果对应的对象，以及重启后全部 50,000 个对象与最终增量。JSON 记录每个身份的请求延迟、实际传输字节数和最近秩 P95。两次冷读取在报告中另列，其 P95 等于两次的较慢值。

## 重建调优前的对照版本

交付包在 `qa/performance/baseline.patch` 中保留了还原调优前应用源码的补丁。复制一份解压后的 `folio/`，在副本根目录执行以下命令。原目录保留当前版本，两个目录可共用同一套压测脚本。

```sh
git apply qa/performance/baseline.patch
bun install --frozen-lockfile
bun run build
```

## 25 万紧凑矩形的浏览器边界

`python qa/compact_browser.py --app /path/to/folio --out evidence/compact-browser-250000.json` 只测一个构建。脚本写入 625 × 400 个独立彩色矩形，逐项验证浏览器对象数、整板与 100% 平移、压感和双轴倾斜、画面变化，以及新的查看者刷新后全部原始对象的 SHA-256。为了限制峰值内存，它在打开查看者前关闭编辑者页面。默认 180 秒超时，Linux 进程树 RSS 高于 3.5 GiB 时记录中止阶段。该场景衡量紧凑几何在一次软件渲染运行中的表现，混合笔迹采用单独的测试数据。

## 独立压力场景

以下命令在已构建的项目根目录运行。使用同一个 Bun 和 Chromium 可执行文件，并将每次结果写入新路径。

```sh
python qa/server_scale.py --baseline ../baseline/folio --runs 7 --compact-boundary --output /tmp/folio-http.json
python qa/compact_browser.py --app . --out /tmp/folio-250k.json
python qa/ink_scale.py --app . --count 8192 --dense-visible 4000 --region dense --label final --output /tmp/folio-dense-ink.json
python qa/renderer_scale.py --project . --output /tmp/folio-renderer.json
python qa/performance/mcp/run.py --chromium "$CHROMIUM_PATH" --source . --count 100000 --output /tmp/folio-canvas-mcp.json
```
