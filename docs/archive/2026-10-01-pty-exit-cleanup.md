# Windows PTY 自然退出后的依赖层资源清理

- 日期：2026-10-01；风险：中；提交：confirm（未获确认不提交）。
- 基准：main / HEAD `a9c0a1c`；前序 `9513bbf`（conin 释放）、`a1d4af4`（分类型归因）。
- 本轮改生产 adapter：真实 PTY exit 后在既有 conin 销毁之外，追加终止 node-pty 从不 dispose 的 conout worker 线程。

## 结果

supervisor 路径每次自然退出的 OS 句柄保留从约 15/轮（归因轮实测 117-125/8 轮）降至 5.1/轮（41/8）：**Thread、Event、Semaphore、IO 完成端口的每轮增长全部消失**（泄漏的 conout worker 线程及其 libuv 资源、ConPTY 事件/信号量），输入 Socket 释放保证不变；纯依赖路径不经过适配层，保留量不变（约 13-15/轮）。全量回归全绿：supervisor 状态机、restart-policy 51 项、pty-cleanup 7 项、lifecycle（inputs=0/queued=0/retained=false）、exit-window 11 项。

## 关键发现（上游结构性边界）

- 上游 conpty.cc（v1.2.0-beta.12）L101-108：退出监视线程先 `CloseHandle(hShell)`、`remove_pty_baton`，再回调 JS——JS 可见退出的时刻，内部 pty 记录（含 HPCON）必已删除。
- 因此退出后 JS 侧任何 `ptyNative.kill` 都是空操作（`get_pty_baton` 返回 null，ClosePseudoConsole 不执行）。本机 A/B：dispose-only 与 dispose+kill 句柄曲线完全相同。
- 剩余约 5/轮（conhost 进程句柄 +1、伪控制台内约 2 个管道 File、type-50 +1）只能由上游修改退出线程释放；squash 边界无解，如实记录，`smoke:pty-handles` 保持 exit 2 作为长期见证。
- 据此从实现中移除了 native kill 死代码，仅保留实际有效的 `_conoutSocketWorker.dispose()`（drain 1s 后 terminate，幂等；不走 JS kill() 包装——它会先 fork 辅助子进程查 console list）。
- 前置实验与 A/B 证据（脚本+日志均留存）：`.cache/pty-exit-cleanup/scratch-dispose-only.mjs` / `scratch-dispose-and-kill.mjs`、`ab-group-a-dispose-only.log` / `ab-group-b-dispose-and-kill.log`（两组均 175→197/4 轮，逐轮相同）；各回归日志 `.cache/pty-exit-cleanup-*.log`；上游源码快照 `.cache/pty-exit-cleanup/conpty.cc`。
## 验证

- 固定 Node 24.21.0、node-pty 1.2.0-beta.12（指纹守卫沿用，私有访问仅 `inSocket` 与 `_conoutSocketWorker`，同一对 lib 工件覆盖）。
- typecheck、build:server 通过；全量回归（见上）全绿；`smoke:pty-handles --mode supervisor --rounds 8` 分类型：{Process:8, File:19, type-50:9, Key:1, Thread:4(一次性)}/8 轮。
- 前置实验与 A/B 证据：`.cache/pty-exit-cleanup/`（scratch）、`.cache/pty-exit-cleanup-*.log`；上游源码快照 `.cache/pty-exit-cleanup/conpty.cc`。

## Pitfall / 边界

- 退出后调用原生 kill"不报错"≠"有清理效果"：baton 已删时静默无操作，必须以 A/B 句柄曲线验证清理是否真实发生。
- 长时/多实例/真实 RWR 未验证；worker terminate 有 1s drain 延迟，轮次间隔过短的测量会把 drain 期误判为泄漏。

## 指针

- [适配层](../../src/core/pty/pty-process-adapter.ts)、[归因归档](2026-10-01-pty-handle-attribution.md)、[输入资源修复](../tasks/2026-10-01-pty-cleanup/TASK.md)
- 上游依据：node-pty v1.2.0-beta.12 `src/win/conpty.cc`（退出线程先删 baton）、`lib/windowsConoutConnection.js`（dispose 仅 kill 路径可达）
