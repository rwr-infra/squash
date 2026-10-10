# rwr_server.log 查看器

- 日期：2026-10-09 – 2026-10-10
- 风险：中（新 REST 接口、读服务器文件；文件名固定，路径来自管理员配置的 cwd）
- Commits：`5d954fc`、`f133c05`、`3753ed6`、`91bbe39`、`d45cc75`（分支 `feat/server-log-viewer`）
- 相关 ADR：无

## 结果
每个实例都可以在网页上查看 `<cwd>/rwr_server.log`（入口在实例行和终端页头部，路由 `/server-log/:instanceId`）。rwr 每次启动都会清空这个文件，文件也可能非常大。

- **后端**：增量稀疏行索引，支持按行区间读取和流式搜索。接口有三个：`GET /api/instances/:id/server-log`（元数据）、`/lines`、`/search`，都要求登录，并已登记到 `smoke:auth`。接口不接受任何路径或文件名参数。
- **前端**：虚拟滚动，超大文件时缩放滚动条；每 2 秒轮询，停在末尾时自动跟随；文件被清空或替换时显示提示。Ctrl+F（macOS 是 ⌘F）打开自建查找栏，也有 Search 按钮，搜索范围是整个文件。
- **移动端**：Wrap 开关，窄屏或触屏默认打开，选择记在当前浏览器。打开后长行折行显示，没有横向滚动，日志下方有位置滑块。

测得数据：888 MB、1000 万行的文件（在页缓存中）建索引 293 ms，堆内存几乎不增长，读末尾 0.8 ms，全文搜索 480 ms；100 万行首屏 248 ms。自动检查：`smoke:server-log` 131 项、`smoke:server-log-ui` 69 项（桌面和手机 390×844 触摸）、`smoke:auth` 全部通过。用户在 macOS 上人工验证了桌面端（跟随、上翻、End、日志重置）和手机模式（换行、滑块、Search 按钮、切换 Wrap）。

## 关键决策
| 决策 | 原因 | 否决方案及原因 |
| --- | --- | --- |
| 路径固定为 `<cwd>/rwr_server.log`，不加配置项 | 和 `rwr_crashdump.dmp` 的定位方式一致，接口不需要接受任何路径 | 可配置路径：多一个任意读文件的入口 |
| 后端分段读取和搜索；稀疏检查点每 1024 行一个 | GB 级文件也不需要整读进内存，服务端和浏览器都一样 | 前端整读：大文件不可用 |
| 每次索引都比对 dev/ino、大小和首尾 4 KiB 指纹，任一变化就生成新 `generation`；读取前后各核对一次，不符抛 `StaleIndexError`，服务层刷新后重试 | rwr 重启会清空文件，新文件可能在两次轮询之间长过旧长度，只看 size 会漏掉 | size + mtime 捷径：会漏判 |
| 单行最多返回 16 KiB，在 UTF-8 边界截断并加 ` … [N more bytes]`；搜索仍扫描整行 | 防止一行巨大的内容拖垮响应和 DOM | 不截断 |
| 搜索是纯子串匹配，默认不区分大小写，最多 10,000 条（超出时显示 "+"）；超过 4 MiB 的行分片搜索，片间按查询长度重叠，同一行只计一次；客户端断开就中止 | 有上界、可中止、不阻塞事件循环 | 正则：回溯风险，也不在本次范围 |
| 浏览器以 200 行为一块缓存，最多 40 块，按与视野的距离淘汰；视野静止 60 ms 后才加载，同时最多 4 个请求，离开视野的请求中止；含末行的块在文件变大后视为过期 | 回看时不必重取，内存仍有上界；拖动滚动条时不会发出大量请求 | 只保留可见块：来回滚动反复请求 |
| 固定行高视图和换行视图分成两个组件（`LogViewport`、`WrappedLogViewport`） | 固定行高时行位置就是乘法，可以缩放滚动条；换行时行高不定，只能保留一个滑动窗口加锚点 | 一个组件两种模式：两套定位逻辑互相干扰 |
| 换行视图：DOM 中保留 max(400 行, 6 屏) 的窗口，靠近边缘时滑动 1/3；每次渲染后把锚点行放回原位；`overflow-anchor: none` | iOS Safari 不支持原生滚动锚定，统一用自己的机制；浏览器的锚定只会和它打架 | 依赖浏览器的滚动锚定 |

## 确立的规范
- 读服务器上的文件时，文件名在服务端写死，路径只来自管理员配置的 `cwd`；接口不接受路径参数（本次 Acceptance 的"不允许发生"项）。
- 打开日志文件用非阻塞方式，并拒绝非普通文件（`ENOTFILE`），否则遇到 FIFO 会一直挂住。
- 用变异测试检验 smoke 时，先确认变异后的构建成功了。TS 编译失败（比如未使用的变量）时，旧产物还在，测试会"通过"，变异就被掩盖了。

## Pitfalls
- **CR 和 UTF-8 跨读块**：`\r\n` 被读块边界切开，或多字节字符被 16 KiB 截断切开，都会出错。要记住上一块的最后一个字节，并按完整 UTF-8 字符计算截断长度。
- **原生滚动锚定会掩盖 bug**：Chrome 自带的滚动锚定会让"去掉锚点恢复"的变异在测试中照样通过，必须设置 `overflow-anchor: none` 才测得出来。
- **滑动窗口时浏览器会钳制 scrollTop**：窗口滑动后内容高度改变，浏览器会自动修正 scrollTop，不能把这个变化当成用户在滚动。锚点要在滑动前取，滑动的那次渲染不做滚动补偿。
- **渲染夹在滚动和滚动事件之间**：用户已经滚了，但滚动事件下一帧才到，这时渲染里的锚点恢复会把用户的滚动撤销。要把 scrollTop 相对上次处理时的差值计入锚点偏移。
- **跳转未落地时滑窗会把目标滑出窗口**：搜索或滑块跳到的目标行还没加载完时，不能滑动窗口。目标行先临时定位，加载完成后再精确落位。
- **react-hooks v7（react-compiler 规则）**：不允许在渲染中读 ref，也不允许在 effect 里同步 setState。跨渲染的状态用 ref 并在 layout effect 中更新，需要重渲染时用计数 state 触发。
- **审查探针的测量时机**：切换视图后立即测量，可能读到"无可见行"（`first=-1`），而 `loading=0` 是空集合上的真值。等待条件要同时要求有可见行。

## 剩余风险 / 后续
- **Windows 上的真实 `rwr_server` 未验证**：运行中能否读取 rwr_server.log（文件共享模式未知）、重启后的提示；Windows Server 上一边搜索大日志一边重启 rwr，如果 rwr 是先删再建日志文件，我们持有的读句柄可能让删除挂起。
- **iOS 真机未验证**：换行视图的惯性滚动只在 Chrome 触摸模拟里测过。
- **已知局限**：
  - 等长原地改写、且只改动首尾 4 KiB 之间的内容时检测不到（rwr 的日志只追加或整体重来）；
  - 16 KiB 截断之后的匹配没有高亮（README 已说明）；
  - 匹配超过 10,000 条时无法从当前视野分页继续搜索；
  - 首次建索引不能中止；同一实例的并发搜索不限流（前端发起新搜索前会中止旧的）。
- 以上未验证项和局限已记入 [backlog](../backlog.md)。`smoke:server-log` 已加入 CI，索引因此会在 Windows 和 Linux 上跑（此前只在 macOS 上跑过）；`smoke:server-log-ui` 需要构建好的前端和 Chrome，仍只在本地跑。

## 指针
- `src/core/log/line-index.ts`（`createLineIndex`、`StaleIndexError`）、`src/services/server-log-service.ts`
- `src/api/http/routes/server-log-routes.ts`、`src/api/http/schemas/server-log-schemas.ts`
- `frontend/src/pages/ServerLogPage.tsx`、`frontend/src/components/LogViewport.tsx`、`WrappedLogViewport.tsx`、`LogSearchBar.tsx`、`LogViewport.css`
- `scripts/smoke-server-log.ts`、`scripts/smoke-server-log-ui.mjs`（用法见文件头：先构建后端和前端）
