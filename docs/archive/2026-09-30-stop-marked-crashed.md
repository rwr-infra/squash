# 手动 Stop 不再被判为 crashed / 自动重启

- 日期：2026-09-30
- 风险：中（共享状态机核心，错误只在真实服务端停服打日志时暴露）
- Commits：31afbd3（分支 `feature/bundled-runtime`）
- 相关 ADR：无

## 结果
`stop()` / `dispose()` 之后，子进程停服期间的输出不再把状态从 `stopping` 改回 `running`；进程非零退出落到 `stopped`，不自动重启。真崩溃（未请求 Stop 的非零退出）仍判 `crashed` 并自动重启，`exit(0)` 仍是 `stopped`。新增 `npm run smoke:supervisor` 回归冒烟。

## 关键决策
| 决策 | 原因 | 否决方案及原因 |
| --- | --- | --- |
| `onData` 完全不写 `status`，只更新 `lastOutputAt` | `start()` spawn 成功后同步设 `running`，onData 观察不到 `starting`，这次写入唯一效果是覆盖 `stopping` | `if (status === 'starting')` 守卫：条件永不成立，留着误导 |
| 回归冒烟走真实 `createInstanceSupervisor` + node-pty，假子进程 = `process.execPath -e <脚本>` | 跨平台、不依赖 shell/rwr_server；能复现"停服时打日志再非零退出" | 只测 node-pty（`smoke:pty` 不经过 supervisor，覆盖不到） |
| 冒烟入库但不进 CI | 现有 CI 只有发布流程 `release.yml` | —（用户决定） |

## 确立的规范
- 只有生命周期调用、spawn 失败回滚与 `onExit` 能改 `status`；改状态/重启逻辑后跑 `npm run smoke:supervisor`（均已写入 CLAUDE.md）。
- 新增冒烟断言要先在未修复代码上看到它 FAIL（变异验证）。

## Pitfalls
- `getRecentOutput()` 会被 `start()` 清空 → 跨重启收集输出要订阅 `onData` 累计，否则前置条件断言会被重启"顺带"弄失败/弄通过。
- node-pty POSIX `kill()` 发 SIGHUP，子进程可以捕获并继续输出；Windows 走 `taskkill /T /F`，没有优雅停服输出 → 这个 bug 以及对应冒烟断言主要在 POSIX 上有意义。

## 剩余风险 / 后续
- **子进程忽略 SIGHUP 时 Stop 后永久 `stopping`**：`canStop` 不含 `stopping`，无法再次 Stop；`restart()` 此时跳过 kill 直接起新进程（旧进程残留、端口冲突）。修复前静默进程本就如此，有输出的进程会被翻回 `running`。需要 Stop 超时升级（SIGTERM → SIGKILL / Windows 已是强杀）。rwr_server 对 SIGHUP 的实际反应未验证。
- `dispose()` 设 `stopping` 时不 `notifyStatus`，与 `stop()` 不一致（既有行为）。
- `smoke:supervisor` 只在 darwin 本机验证过，未跑 Linux / Windows，也未进 CI。

## 指针
- 修复：`src/core/instance/instance-supervisor.ts`（`bindProcessEvents` 的 onData / onExit）
- 冒烟：`scripts/smoke-supervisor.ts`（`npm run smoke:supervisor`）
- 前序：`docs/archive/2026-09-29-bundled-runtime.md`「剩余风险」第一条即本任务
