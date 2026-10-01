# Backlog

未排期的已知问题与改进。开始其中一项前先写 TASK（dev-loop），完成后从这里删掉该条，并在归档文档里记录。每条注明风险、现状和入口。

## 待验证

- **编辑实例可能丢 `env` / `logDir`**（中，HYPOTHESIS）：实例表单没有 `env`、`logDir` 的 `Form.Item`。`2ebd80a` 修好了跨实例串值，但提交时未注册的字段是否仍被丢弃、从而被 `CreateInstanceSchema` 的默认值 `{}` / `'logs'` 覆盖，还没有验证。复现方法：建一个带 `env` 的实例，在 UI 里编辑后保存，再用 API 读回。可以沿用 `docs/archive/2026-09-30-stop-escalation.md` 里的无头 Chrome 手法。入口：`frontend/src/pages/InstanceListPage.tsx` 的 `handleSubmit`。
- **Linux 上真实 `rwr_server`**：只在 Windows Server 上人工验证过，包括 stopCommand `quit` + 空行。systemd（README 写了 `KillMode=mixed`、`TimeoutStopSec`）和 `docker stop`（README 写了 `--stop-timeout 20`）也都没有实测。
- **`quit` 是否自动保存 profiles**：未确认。如果不会，rwr 的 stopCommand 应改为 `save_profiles`、`quit`、空行。注意各行按固定时间表发送，保存很慢时后面的回车可能被提前消耗。
- **Windows PTY 其他句柄保留 / 故障边界**（中，待继续定位）：输入 Socket 在真实退出后释放的候选修复，已令原生命周期对照/压力各 8 轮最终 active inputs=0、queued bytes=0；但 OS 总句柄仍随轮次增长，未确认来源，不能宣称全部资源泄漏已消除。需继续区分 native/helper/其他管道，并验证长时、并发及真实 RWR bad allocation 根因。活动期间输入 pipe 错误仍按原行为失败退出，尚无实例级恢复契约。入口 `npm run smoke:pty-cleanup`。见 [输入资源修复](tasks/2026-10-01-pty-cleanup/TASK.md)。

## 界面 / API

- **实例表单保存没有进行中保护**（低，`main` 上已有）：`onOk={() => form.submit()}` 没有 `confirmLoading`，请求进行中仍可 Cancel；`handleSubmit` 在 await 之后无条件关闭 Modal。慢网络下「编辑 A → Save → Cancel → 编辑 B」时，A 的响应会关掉 B 的 Modal；新建时双击 Create 会发两个 POST。
- **清空 Restart Delay 后提交返回 400**（低）：antd `InputNumber` 清空后给的是 `null`，而 `restartDelayMs: z.number().int().min(0).default(3000)` 只对 `undefined` 补默认值。可以像 `stopTimeoutMs` 那样在 `handleSubmit` 里 `?? undefined`。
- **Restart 请求会挂到旧进程退出**（低）：最长 `stopTimeoutMs + 5s`，最长约 10 分钟。经反向代理或 Firefox（响应超时 300s）时，页面可能误报失败，但重启仍会完成（README 已说明）。长期可以改为立即返回，结果经 WebSocket 推送。
- **Restart 被取消或 spawn 失败时审计里没有记录**（低）：审计只在成功后记录。
- **`stopping` 期间网页终端的键盘输入被丢弃**（低，既有）：`sendRawInput` 要求状态是 `running`，所以停服卡住时无法在网页上手动按回车，只能用 Force stop。
- **编辑实例后终端尺寸回到 120×40**（低）：编辑会 `dispose()` 旧 supervisor 并新建一个，新的没有记住尺寸；已打开的终端页仍连着旧对象，要重新进入页面。

## 部署 / 构建 / CI

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
