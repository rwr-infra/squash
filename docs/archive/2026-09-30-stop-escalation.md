# 有上限的停止、Restart 等待退出、squash 退出时停掉所有实例

- 日期：2026-09-30
- 风险：高（进程生命周期与状态机核心；认证、数据丢失、孤儿进程、启动器退出码）
- Commits：`a595944..728965f`，分支 `feat/stop-escalation`（契约 `a595944`、停止流程 `9368d4b`、Restart `13a13b5`、信号关停 `d01fb8c`、表单串值修复 `2ebd80a`、超时上限 `6c6cbec`、空行 = 回车 `eebb364`、文档 `728965f`）
- 相关 ADR：无

## 结果
Stop 之后实例一定会在有限时间内落到 `stopped`：先发该实例的 `stopCommand`（没有就用平台默认：POSIX SIGHUP、Windows 立即 `taskkill /T /F`），超过 `stopTimeoutMs`（默认 15s，1000–600000）就强杀整个进程组。Restart 等旧进程退出后才启动新进程。squash 收到 SIGINT/SIGTERM/SIGHUP（Windows 另含 SIGBREAK）时先停掉所有实例，再以退出码 0 退出。真实 rwr_server 在 Windows Server 上配 `quit` + 空行后，Stop、Restart、崩溃自动重启、关闭 squash 窗口都已人工验证。

## 关键决策
| 决策 | 原因 | 否决方案及原因 |
| --- | --- | --- |
| `stopCommand` 是多行字符串：每行一条命令、行间隔 1s；首条之后的空行发送单独的回车；开头空行丢弃，整体空白 = 未配置 | rwr_server 回 `Exit requested` 后要再收到一次回车才退出（原生终端实测）；间隔让服务器先打出提示 | 丢弃空行（初版，rwr 永远等到强杀）；命令发完自动补回车（隐式、对所有实例生效）；`string[]`（表单要做动态列表） |
| `stopTimeoutMs` schema 不设默认值，supervisor 默认 15000；上限 600000 | 旧配置与未填的新配置都跟随代码默认值；rwr 保存可能慢，用户要 10 分钟上限 | 像 `restartDelayMs` 那样 `.default()`（把默认值写死进每份配置）；上限 120000（用户否决） |
| `PtyProcess.kill(mode)` 参数必填；POSIX force = `process.kill(-pid,'SIGKILL')`，`pid <= 1` 时什么都不做；Windows 两种都是 `taskkill /T /F`，pid 仍为占位 0 时退回 node-pty 的 kill | 每个调用点显式选择；与 `taskkill /T` 对齐，包装脚本的孙进程也清掉；`-0`/`-1` 会杀到 squash 自己或整个用户 | 只杀单 pid（孙进程残留）；优雅也按组（改变现有停止行为） |
| `stop(options?: { force })` 同步、只发起；`stopping` 中不带 force 的 Stop 是空操作，带 force 才立即强杀；UI 的 Force stop 带确认框、请求中禁用 | 双击 Stop、多标签页或多人的过期视图不会打断 `quit` 的保存 | 「stopping 时任何 Stop 都强杀」（初版，审查发现会误杀）；只做 pending 禁用（过期视图仍误杀） |
| `dispose(): Promise<void>`：置「已释放」（不再 start / 自动重启），走同一套停止流程，进程退出后 resolve | squash 关停要能等所有实例停完；被丢弃的 supervisor 不能在 registry 外拉起幽灵进程 | 公开 `waitForExit()`；`stop()` 返回 Promise（状态非法的同步抛错会变成 reject） |
| `restart()` 走停止流程、等 `onExit` 后才 `start()`；等待中有任何 `stop()`/`dispose()` 就以 400 取消；并发调用合并；等待上限 `stopTimeoutMs + 5s` | 新旧进程不能并存（端口、存档）；Stop 表示「别再起来」 | 立即强杀再启动；返回 409（现有路由对所有实例错误都返回 400） |
| 关停：同时 `dispose()` 全部实例并 `httpServer.close()`；预算 = 最大 `stopTimeoutMs` + 2s，截止前 1s 强杀剩余；实例停完后 HTTP 最多再等 1s；1s 内的重复信号忽略，之后的第二次信号先强杀再 `exit(0)`；所有路径退出码 0 | `start.bat` 只放行 0 与 Ctrl+C 的退出码；关终端时 shell 与内核各发一次 SIGHUP、`npm start` 下 Ctrl+C 会收到两次 SIGINT | 先停实例再关 HTTP（关停期间还能 Start，需额外拒绝逻辑）；先关完 HTTP 再停实例（进行中的 Restart 拖长关停）；第二次信号立即退出（留孤儿） |

## 确立的规范
- 停止路径唯一：`stop` / `restart` / `dispose` / 关停都走 `beginStop`；只有生命周期调用、spawn 回滚、`onExit` 改 `status`（CLAUDE.md 已有）。改停止或重启逻辑后跑 `npm run smoke:supervisor`；改信号 / 关停 / 启动路径后跑 `npm run package && npm run smoke:release`。
- 任何会写实例 PTY 的定时回调都要守卫 `processRef === <它针对的进程>`；决定强杀之后先丢弃还没发出的 stopCommand 行。
- supervisor 的 `[squash]` 日志经串行队列写入，`onExit` 落定状态前 await 它 —— squash 可能在实例停完后立刻退出。日志写入失败一律吞掉（否则 unhandled rejection 会让 squash 退出）。
- 冒烟的假子进程要自证前提：忽略信号的子进程先断言「收到了且还活着」，孙进程先断言存活；按 PID 记录待清理进程，进程一确认消失就移出（Windows 复用 PID 很快）；孙进程 PID 在完整输出的整行上匹配（输出块可能在数字中间断开）。
- Windows 上 supervisor 冒烟会报两次 `running`（首个输出到来时才补上 PID），比较状态序列前先合并连续重复项。

## Pitfalls
- **终端关闭后 squash 会卡死**：写 tty 返回 EIO，pino 只吞 EPIPE，退出时的 `flushSync` 对失败的写入无限重试 → 进程既不退出也不停实例。`src/index.ts` 的 logger 用显式 `pino.destination({ dest: 1 })`，首次出错后把 `write`/`flushSync` 置空；不要改回默认 destination。复现：python `pty.fork` 起 node，关 master。
- **一次操作常送达两次信号**：关终端窗口（shell 转发 + 内核各一次 SIGHUP）、`npm start` 下 Ctrl+C（终端 + npm 转发）。「第二次信号立即退出」会留下忽略 SIGHUP 的孤儿。
- **antd 表单串值**：页面级 `Form.useForm()` 的 store 比 Modal 内容活得久，重新挂载的 `<Form>` 让旧 store 值压过新的 `initialValues`（@rc-component/form `merge(initialValues, store)`）→ 编辑 B 时显示并保存 A 的值。`ResetFormOnMount` 必须是 `<Form>` 的**最后一个**子节点；页面级 `useLayoutEffect` 无效（Modal 内容在更晚的提交里挂载），`clearOnDestroy` 在 StrictMode 下会清空仍显示着值的 store。
- **node-pty 写入**：POSIX 上非 EAGAIN 的写错误不抛出，只 `console.error('Unhandled pty write error')`；Windows 写入走 `inSocket.write`。进程退出到 node-pty 发 exit 之间 Windows 约 1s，这期间写入的风险未证实（stop / `sendCommand` / 键盘输入都有这条路径）。
- **ConPTY 输入**：node 子进程按行收到 `<cmd>\r\n`，每条命令单独一块；POSIX 为 `<cmd>\n`（ICRNL）。
- 本机验证手法：界面用生产构建 + dev 后端（`HOST=127.0.0.1 PORT=4747`）+ 无头 Chrome（Node 24 自带 WebSocket 走 DevTools 协议，无需依赖）；测试实例经 REST 建删，事先备份 `config/instances.json`。`DELETE` 请求不要带 `content-type: application/json` 却不带 body，否则 Fastify 返回 400。

## 剩余风险 / 后续
- Linux 上真实 rwr_server 未验证；systemd 路径未验证（README 写了 `KillMode=mixed`、`TimeoutStopSec`）；`docker stop` 未实测（README 写了 `--stop-timeout 20` / `stop_grace_period: 20s`）。
- 各行按固定时间表发送，不等服务器处理完上一行：`save_profiles` 很慢时，后面的回车可能被提前消耗（README 已说明）。`quit` 是否自动保存 profiles 仍未确认。
- 经反向代理时，Restart 请求要挂到旧进程退出（最长 `stopTimeoutMs + 5s`，上限提高后可达约 10 分钟），代理读超时不够会让页面误报失败（README 已说明）；长期可改为立即返回、结果经 WS 推送。
- 已接受的 low：终端页 Restart 响应可能覆盖 WS 推来的更新状态；Restart 被取消或 spawn 失败时审计无记录；`stopping` 时网页终端的键盘输入被丢弃（既有）。
- `nohup ./start.sh` 不再能让 squash 在 SSH 断开后继续运行（README 已说明，建议 tmux / 服务管理器）。

## 指针
- `src/core/instance/instance-supervisor.ts`：`parseStopCommands`、`resolveStopTimeoutMs`、`beginStop`、`stopProcess`、`restart`、`dispose`、`onExit`
- `src/core/pty/pty-process-adapter.ts`：`kill(mode)`、`killProcessGroup`
- `src/index.ts`：`logDestination`、`shutdown`
- `src/api/http/routes/instance-routes.ts`（`POST /stop` 的 `force`）；`src/api/http/schemas/instance-schemas.ts`
- `frontend/src/pages/InstanceListPage.tsx`（`ResetFormOnMount`、`describeStopCommand`、Force stop 确认框）；`frontend/src/pages/TerminalPage.tsx`
- `scripts/smoke-supervisor.ts`（`stop-command` / `exit-requested` / `stubborn` 子进程模式）；`scripts/smoke-release.mjs`（孤儿检查）
- README / README.zh-CN「Stopping / 停止」一节
