# Windows PTY 退出后总句柄增长的归因

- 日期：2026-10-01；风险：中；提交：confirm（未获确认不提交）。
- 基准：main / HEAD `c4cbe56`；前序 `9513bbf`（输入 Socket 释放）、`c4cbe56`（生命周期探针，观测 194→311/8 轮）。
- 本轮只调查：新增归因探针与本地证据，未改生产 adapter/supervisor/依赖，未启动真实 RWR。

## 结果

输入 Socket 修复之后，每次自然退出仍保留约 13-15 个 OS 句柄（8 轮总增量 117-125）；分类型普查将全部增量归因到 node-pty 依赖层，squash 层零额外增长：

- **从不 dispose 的 conout worker 线程**：`ConoutConnection.dispose()`（worker terminate）只在 `kill()` 路径可达，自然退出永不执行。每轮 +1 存活线程（Thread 句柄 + 其 libuv IoCompletion + 到原生 conout 管道的客户端 File + 中继管道服务端 File）。
- **从不执行的原生清理**：自然退出不调 `ptyNative.kill`，子进程 Process 句柄（+1/轮）与 ConPTY 的管道端/信号量/事件（File/Event/Semaphore）全部保留。
- 分类型增量（8 轮）：supervisor 与 conin-destroy 的 File 增量相同（+59），纯依赖 +67——差 8 恰为每轮 1 个 conin fd（microsoft/node-pty#947）；Thread +16-20（泄漏 worker 偶发崩溃的波动）、Process/IoCompletion/Semaphore/Event 各 +8，另有 Key +1 与未标注 type-50 +9（量小）。总量与 lifecycle 探针独立观测的 194→311（+117/8 轮）吻合。

## 方法

`npm run smoke:pty-handles`：worker 内 8 轮真实 ConPTY 自然退出（round1 起 GC），父进程在轮间用独立 PowerShell 进程做句柄普查——NtQuerySystemInformation(SystemExtendedHandleInformation) 按 ObjectTypeIndex 分桶，DuplicateHandle+NtQueryObject 只查类型信息标注；另有 `_getActiveHandles` 普查与退出码语义（2=保留诊断，1=失败/输入 Socket 保证回归，0=无增长）。supervisor 模式走编译产物（真实 adapter/parser/log writer/状态机）。

源码清点（node-pty 1.2.0-beta.12 lib/*.js）：`_cleanUpProcess` 仅销毁 outSocket；`connectionTimeout`/`_closeTimeout` 正常清理；`_$onProcessExit` 无任何原生清理调用。

## 决定 / 修复契约候选

- 调查轮先行，修复另立契约（沿用 pty-lifecycle 模式）。
- 本机 Win10 19045 x64 的 SystemExtendedHandleInformation 缓冲区：count(8B)+8B 填充+40B/条目，ObjectTypeIndex 为条目内 +30 的 USHORT——与常见文档布局不同，先用原始字节转储核实再解析。
- 普查只查 NtQueryObject 类型信息（不查可能挂起的名字信息）；跨 Windows 版本前先十六进制转储验证布局。

## Pitfall

- 单机 Windows 10 19045；其他 Windows/ConPTY 版本的句柄表布局与泄漏组合未验证。
- .NET Marshal 无 ReadUInt16/ReadUInt32（ReadUInt16 亦不存在于 PS 5.1 可用集），须 ReadInt16 -band 0xFFFF；PS 5.1 IntPtr 加法溢出，指针运算全程 Int64 + `[IntPtr]::new([Int64])`。

## 验证边界

- 单机 Windows 10 19041；其他 Windows/ConPTY 版本的句柄表布局与泄漏组合未验证。
- 长时运行、多实例并发、真实 RWR bad allocation 根因未验证；type-50（键控盘）无法用类型信息标注，基线恒定不影响增量。
- worker 线程是否全部存活有波动（5-8/8 轮），部分 worker 因管道断开崩溃；不影响归因方向。

## 指针

- [探针](../../scripts/smoke-pty-handles.mjs) / `package.json` smoke:pty-handles
- [backlog 条目](../backlog.md)（已归因待修复）
- [输入资源修复](2026-10-01-pty-cleanup.md)、[生命周期调查](2026-10-01-pty-lifecycle.md)
- 依赖实现：`node_modules/node-pty/lib/windowsPtyAgent.js`、`windowsConoutConnection.js`、`worker/conoutSocketWorker.js`
