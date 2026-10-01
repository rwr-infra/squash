# Backlog

未排期的已知问题与改进。开始其中一项前先写 TASK（dev-loop），完成后从这里删掉该条，并在归档文档里记录。每条注明风险、现状和入口。

## 待验证

- **Linux 上真实 `rwr_server`**：只在 Windows Server 上人工验证过，包括 stopCommand `quit` + 空行。systemd（README 写了 `KillMode=mixed`、`TimeoutStopSec`）和 `docker stop`（README 写了 `--stop-timeout 20`）也都没有实测。
- **`quit` 是否自动保存 profiles**：未确认。如果不会，rwr 的 stopCommand 应改为 `save_profiles`、`quit`、空行。注意各行按固定时间表发送，保存很慢时后面的回车可能被提前消耗。
- **Windows PTY 其他句柄保留 / 故障边界**（中，已归因待修复）：输入 Socket 修复后，自然退出每次仍保留约 13-15 个 OS 句柄（与 lifecycle 探针 194→311 独立观测吻合）；`npm run smoke:pty-handles` 的分类型普查显示 supervisor 路径与 conin 销毁路径 File 增量相同（纯依赖路径额外多 1 个/轮的 conin File，即 #947，适配层已释放），已归因到依赖层：从不 dispose 的 conout worker 线程（Thread+IoCompletion+管道 File）、自然退出路径从不执行的原生清理（子进程 Process 句柄、ConPTY 管道端/信号量/事件），squash 层零额外增长。修复候选是依赖层补丁（退出后 dispose conout worker + 原生 kill 清理），需另立契约并验证输出冲刷不被打断；长时/并发/真实 RWR bad allocation 根因仍未验证。活动期间输入 pipe 错误仍按原行为失败退出。入口 `npm run smoke:pty-handles`、`smoke:pty-lifecycle`、`smoke:pty-cleanup`、`smoke:pty-exit-window`。见 [归档](archive/2026-10-01-pty-handle-attribution.md)、[输入资源修复](tasks/2026-10-01-pty-cleanup/TASK.md) 和 [此前调查](archive/2026-10-01-pty-lifecycle.md)。

## 界面 / API

- **Restart 请求会挂到旧进程退出**（低）：最长 `stopTimeoutMs + 5s`，最长约 10 分钟。经反向代理或 Firefox（响应超时 300s）时，页面可能误报失败，但重启仍会完成（README 已说明）。长期可以改为立即返回，结果经 WebSocket 推送。
- **Restart 被取消或 spawn 失败时审计里没有记录**（低）：审计只在成功后记录。
- **`stopping` 期间网页终端的键盘输入被丢弃**（低，既有）：`sendRawInput` 要求状态是 `running`，所以停服卡住时无法在网页上手动按回车，只能用 Force stop。
- **编辑实例后终端尺寸回到 120×40**（低）：编辑会 `dispose()` 旧 supervisor 并新建一个，新的没有记住尺寸；已打开的终端页仍连着旧对象，要重新进入页面。

## 部署 / 构建 / CI

- **重启策略 E2E 的远端变异验收**（低）：已加入三平台 package job；2026-10-01 分支 `feat/restart-policy-and-pty-hardening` 的云端运行（run 36840827236）三平台全绿（typecheck/supervisor/package/restart-policy/release 上传全过）。剩余：远端变异验证（故意让 e2e 失败确认云端真的阻断上传）与 PR 合入 main。见 [归档](archive/2026-10-01-instance-form-and-ci.md)。
- **日志体验**（低）：`src/api/http/auth.ts` 的 `pino({ name: 'auth' })` 没有设 ISO 时间戳，和 `src/index.ts` 的格式不一致；便携包控制台输出的是原始 JSON，对双击运行的用户不友好。注意三点：
  - `pino-pretty` 是 devDependency，而打包用的是 `npm ci --omit=dev`；
  - `scripts/smoke-release.mjs` 按 JSON 解析启动日志；
  - `src/index.ts` 的 logger 必须保留显式的容错 destination（见 CLAUDE.md），改成美化输出时不能丢掉这一点。
- **Dockerfile 的 `FROM node:24-slim` 不跟随 `.node-version`**（低-中）：一共 4 处。
- **`start.sh` 经符号链接调用时找不到 `runtime/`**（低）。
- **CI 只在 `push` 时触发**（低）：没有 `pull_request` 触发，外部 fork 的 PR 不会跑检查（目前没有外部贡献者）。

## 暂不做

代码签名、SmartScreen / Gatekeeper 补测、arm64 矩阵、Windows 安装器、Linux systemd unit、程序与数据目录分离、`AUTH_TOKEN` 强度、token-only 模式下的 Web UI。

## 已知非 bug

- squash 绑 `127.0.0.1:3000` 时，如果另一个进程占着通配地址 `*:3000`，macOS 允许两者同时监听，不会触发 `EADDRINUSE`（OS 行为）。
