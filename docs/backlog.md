# Backlog

未排期的已知问题与改进。开始其中一项前先写 TASK（dev-loop），完成后从这里删掉该条，并在归档文档里记录。每条注明风险、现状和入口。

## 待验证

- **Linux 上真实 `rwr_server`**：只在 Windows Server 上人工验证过，包括 stopCommand `quit` + 空行。systemd（README 写了 `KillMode=mixed`、`TimeoutStopSec`）和 `docker stop`（README 写了 `--stop-timeout 20`）也都没有实测。
- **`quit` 是否自动保存 profiles**：未确认。如果不会，rwr 的 stopCommand 应改为 `save_profiles`、`quit`、空行。注意各行按固定时间表发送，保存很慢时后面的回车可能被提前消耗。
- **Windows 上读取运行中的 `rwr_server.log`**（中）：rwr 写日志时的文件共享模式未知，日志页可能读不到（会显示 503 `SERVER_LOG_UNREADABLE`）。另外，Windows Server 上一边搜索大日志一边重启 rwr 时，如果 rwr 是先删再建日志文件，我们持有的读句柄可能让删除挂起。重启后的"日志已重置"提示也只在 macOS 上用假服务验证过。见 [归档](archive/2026-10-10-server-log-viewer.md)。
- **iOS 真机上的换行日志视图**（低）：惯性滚动跨窗口滑动只在 Chrome 触摸模拟里测过（`smoke:server-log-ui`）。
- **Windows PTY 残余句柄（上游结构性，低）**：squash 适配层已在真实 PTY exit 后终止 node-pty 从不释放的 conout worker 线程（`9513bbf` 之后的补充清理），supervisor 路径每次自然退出的句柄保留从约 15 降到约 5（Thread/Event/Semaphore/IO 完成端口每轮增长已消失）。剩余约 5/轮（conhost 进程句柄 + 未关闭伪控制台内的管道句柄 + type-50）在 JS 边界不可释放：node-pty 退出监视线程在 JS 回调前移除 pty 记录，事后原生 kill 为空操作（conpty.cc L101-108，A/B 已证）。需上游修改退出线程；`npm run smoke:pty-handles` 保持 exit 2 作为长期见证。真实 RWR bad allocation 根因、长时/并发仍未验证。入口 `smoke:pty-handles`、`smoke:pty-lifecycle`、`smoke:pty-cleanup`、`smoke:pty-exit-window`。见 [归档](archive/2026-10-01-pty-exit-cleanup.md)、[归因](archive/2026-10-01-pty-handle-attribution.md) 和 [输入资源修复](archive/2026-10-01-pty-cleanup.md)。
- **移到 `scripts/diagnostics/` 的 PTY 探针没有在 Windows 上实跑**（低）：只改了 root 和 `dist` 的相对路径，做过静态解析验证。下次在 Windows 上跑 `npm run build:server && npm run smoke:pty-cleanup` 即可确认。见 [归档](archive/2026-10-10-vitest-migration.md)。

## 界面 / API

- **Restart 请求会挂到旧进程退出**（低）：最长 `stopTimeoutMs + 5s`，最长约 10 分钟。经反向代理或 Firefox（响应超时 300s）时，页面可能误报失败，但重启仍会完成（README 已说明）。长期可以改为立即返回，结果经 WebSocket 推送。
- **Restart 被取消或 spawn 失败时审计里没有记录**（低）：审计只在成功后记录。
- **`stopping` 期间网页终端的键盘输入被丢弃**（低，既有）：`sendRawInput` 要求状态是 `running`，所以停服卡住时无法在网页上手动按回车，只能用 Force stop。
- **重启前没有保留上一轮的 `rwr_server.log`**（中）：rwr 每次启动都会清空它，崩溃后按 `always` 自动重启时，崩溃前的日志在 `restartDelayMs` 后就没了。可以在 supervisor 启动进程前把它复制或改名为 `rwr_server.<时间>.log`（注意磁盘占用上限，以及 Windows 上文件可能被占用）。
- **日志搜索匹配超过 10,000 条时不能继续**（低）：只能看到前 10,000 条（显示 "+"）；可以改为从当前视野起分页搜索。入口 `src/core/log/line-index.ts` 的 `search` 和 `frontend/src/components/LogSearchBar.tsx`。
- **超长行 16 KiB 之后的匹配没有高亮**（低，README 已说明）：接口每行只返回前 16 KiB，计数和跳转仍然正确。
- **日志首次建索引不能中止；同一实例的并发搜索不限流**（低）：前端发起新搜索前会中止旧的，但直接调接口可以并发多个全文扫描。
- **编辑实例后终端尺寸回到 120×40**（低）：编辑会 `dispose()` 旧 supervisor 并新建一个，新的没有记住尺寸；已打开的终端页仍连着旧对象，要重新进入页面。

## 安全

- **静态 `AUTH_TOKEN` 用 `===` 比较**（低）：`src/api/http/auth.ts` 的 `validateBearerToken`/`currentUser` 不是常量时间比较，理论上可做时序探测。会话 token 走 `Map` 查找，不受影响。修复用 `crypto.timingSafeEqual`（先比长度）。
- **Fastify 错误处理器记不下任何东西**（低）：`createHttpServer` 里 `fastify({...})` 没配 logger（`server.log` 是 noop，同文件的 pino `logger` 没用上）；`setErrorHandler` 注册在 `/api` 插件之后，插件内路由可能走 Fastify 默认处理器而不是统一的 `INTERNAL_ERROR` 格式。500 时无迹可查。
- **依赖有既有 npm audit 告警**（中，未评估）：fastify、@fastify/static、find-my-way、ws、fast-uri 等共 8 条，其中 6 条 high，引入 vitest 之前就有。需要逐条看是否影响运行时，再升级。

## 部署 / 构建 / CI

- **日志体验**（低）：`src/api/http/auth.ts` 的 `pino({ name: 'auth' })` 没有设 ISO 时间戳，和 `src/index.ts` 的格式不一致；便携包控制台输出的是原始 JSON，对双击运行的用户不友好。注意三点：
  - `pino-pretty` 是 devDependency，而打包用的是 `npm ci --omit=dev`；
  - `scripts/smoke-release.mjs` 按 JSON 解析启动日志；
  - `src/index.ts` 的 logger 必须保留显式的容错 destination（见 CLAUDE.md），改成美化输出时不能丢掉这一点。
- **Dockerfile 的 `FROM node:24-slim` 不跟随 `.node-version`**（低-中）：一共 4 处。
- **`start.sh` 经符号链接调用时找不到 `runtime/`**（低）。
- **CI 只在 `push` 时触发**（低）：没有 `pull_request` 触发，外部 fork 的 PR 不会跑检查（目前没有外部贡献者）。
- **测试迁移的后续**（低）：
  - `smoke-restart-policy`、`smoke-release` 迁入 Vitest 的 e2e project（依赖构建产物，在 Package 之后跑）；
  - 浏览器 smoke（`smoke-instance-form`、`smoke-server-log-ui`）改用 Playwright Test（使用系统 Chrome），替换两份手写的 CDP；
  - 前端单测（jsdom）。

  约定见 CLAUDE.md 的 Tests 小节和 [归档](archive/2026-10-10-vitest-migration.md)。
- **测试盲点**（低）：
  - `src/index.ts` 里闸门的接线（`resolveBindHost(process.env.HOST, isWeaklyProtected)`）只有 `smoke:release` 覆盖；
  - supervisor 的 stop/dispose 场景看不到不发通知的状态回写（继承自旧 smoke）。
  - "large: reading at the end is fast (< 100 ms)" 抓不到读取退化：在 Mac 上，正常读取末尾不到 1 ms，从头扫描约 65 ms，仍在阈值以内（继承自旧 smoke）。可以改为与建索引耗时或读开头的耗时相比较。
- **`tsc` 不清理 `dist/`**（低）：在旧工作区直接 `npm run package`，可能把过期文件（例如以前构建的 `dist/smoke/`）打进包。可以让 `build:server` 先清空 dist。CI 是全新 checkout，不受影响。

## 暂不做

代码签名、SmartScreen / Gatekeeper 补测、arm64 矩阵、Windows 安装器、Linux systemd unit、程序与数据目录分离、`AUTH_TOKEN` 强度、token-only 模式下的 Web UI。

## 已知非 bug

- squash 绑 `127.0.0.1:3000` 时，如果另一个进程占着通配地址 `*:3000`，macOS 允许两者同时监听，不会触发 `EADDRINUSE`（OS 行为）。
