# Backlog

未排期的已知问题与改进。开始其中一项前先写 TASK（dev-loop），完成后从这里删掉该条，并在归档文档里记录。每条注明风险、现状和入口。

## 待验证

- **Linux 上真实 `rwr_server`**：只在 Windows Server 上人工验证过，包括 stopCommand `quit` + 空行。systemd（README 写了 `KillMode=mixed`、`TimeoutStopSec`）和 `docker stop`（README 写了 `--stop-timeout 20`）也都没有实测。
- **`quit` 是否自动保存 profiles**：未确认。如果不会，rwr 的 stopCommand 应改为 `save_profiles`、`quit`、空行。注意各行按固定时间表发送，保存很慢时后面的回车可能被提前消耗。
- **Windows PTY 残余句柄（上游结构性，低）**：squash 适配层已在真实 PTY exit 后终止 node-pty 从不释放的 conout worker 线程（`9513bbf` 之后的补充清理），supervisor 路径每次自然退出的句柄保留从约 15 降到约 5（Thread/Event/Semaphore/IO 完成端口每轮增长已消失）。剩余约 5/轮（conhost 进程句柄 + 未关闭伪控制台内的管道句柄 + type-50）在 JS 边界不可释放：node-pty 退出监视线程在 JS 回调前移除 pty 记录，事后原生 kill 为空操作（conpty.cc L101-108，A/B 已证）。需上游修改退出线程；`npm run smoke:pty-handles` 保持 exit 2 作为长期见证。真实 RWR bad allocation 根因、长时/并发仍未验证。入口 `smoke:pty-handles`、`smoke:pty-lifecycle`、`smoke:pty-cleanup`、`smoke:pty-exit-window`。见 [归档](archive/2026-10-01-pty-exit-cleanup.md)、[归因](archive/2026-10-01-pty-handle-attribution.md) 和 [输入资源修复](tasks/2026-10-01-pty-cleanup/TASK.md)。

## 界面 / API

- **Restart 请求会挂到旧进程退出**（低）：最长 `stopTimeoutMs + 5s`，最长约 10 分钟。经反向代理或 Firefox（响应超时 300s）时，页面可能误报失败，但重启仍会完成（README 已说明）。长期可以改为立即返回，结果经 WebSocket 推送。
- **Restart 被取消或 spawn 失败时审计里没有记录**（低）：审计只在成功后记录。
- **`stopping` 期间网页终端的键盘输入被丢弃**（低，既有）：`sendRawInput` 要求状态是 `running`，所以停服卡住时无法在网页上手动按回车，只能用 Force stop。
- **编辑实例后终端尺寸回到 120×40**（低）：编辑会 `dispose()` 旧 supervisor 并新建一个，新的没有记住尺寸；已打开的终端页仍连着旧对象，要重新进入页面。

## 安全

- **静态 `AUTH_TOKEN` 用 `===` 比较**（低）：`src/api/http/auth.ts` 的 `validateBearerToken`/`currentUser` 不是常量时间比较，理论上可做时序探测。会话 token 走 `Map` 查找，不受影响。修复用 `crypto.timingSafeEqual`（先比长度）。
- **Fastify 错误处理器记不下任何东西**（低）：`createHttpServer` 里 `fastify({...})` 没配 logger（`server.log` 是 noop，同文件的 pino `logger` 没用上）；`setErrorHandler` 注册在 `/api` 插件之后，插件内路由可能走 Fastify 默认处理器而不是统一的 `INTERNAL_ERROR` 格式。500 时无迹可查。

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
