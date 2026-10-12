# Task: 每个实例可配置服务器日志文件；API 请求日志

- Risk: 中 —— 改实例/模板共享 schema 和接口行为；推翻归档里"日志路径不可配置"的决定；日志接线挨着 `src/index.ts` 防 EIO 挂死的 destination
- Commit policy: auto（每个 checkpoint 一个 commit；push/PR/merge 每次单独问）
- Branch: `feat/server-log-file`

## Goal
1. 日志查看器按实例配置：实例（和模板）有一个"服务器日志文件"字段，留空的实例（如 SteamCMD）看不到任何日志入口，预设 RWR 模板预填 `rwr_server.log`。
2. squash 控制台输出能看到 API 请求：谁调了什么、结果如何；`/api` 路由的 500 有堆栈可查，并走统一错误格式。

## Scope
- 必须完成：
  - `InstanceConfig.serverLogFile`（相对 `cwd` 的路径，`''` = 不提供日志查看），实例表单与模板表单可编辑；预设 RWR 模板带 `rwr_server.log`。
  - 旧配置/旧模板无此字段时按可执行文件推断。
  - 关闭时隐藏实例行和终端页的日志按钮；后端三个 server-log 接口拒绝；日志页直达时显示"未启用"。
  - 页面与错误文案用配置的文件名，不再写死 `rwr_server.log`。
  - Fastify 接上 `src/index.ts` 的容错 logger；每个请求一行分级日志；修好 `/api` 内不生效的统一错误处理器。
- 明确不做：
  - 日志写入文件、pretty 输出、`auth.ts` 独立 pino 的统一（backlog "日志体验" 项）。
  - 轮询改推送、日志归档（backlog 已有）。
  - 已有 `templates.json` 的迁移（靠推断兜底，不改用户文件）。

## Decisions
- 可配置文件名，而非布尔开关 —— 用户选择（2026-10-10），推翻 [归档](../../archive/2026-10-10-server-log-viewer.md) 的"路径固定"。安全前提：持 token 者本来就能设任意 `cwd`/`executable` 执行任意程序，读文件不是新增能力；仍保持"接口不接受路径参数"，路径只来自实例配置。（2026-10-10）
- 路径规则：相对 `cwd`；拒绝绝对路径（POSIX/Windows/UNC）、盘符前缀 `C:`、任何 `..` 段、NUL、末段为空或 `.`；≤ 260 字符；可含子目录（`/` 或 `\`）。—— 让"相对工作目录"成为唯一语义，校验简单。（2026-10-10）
  - 审查后补充：只由点和空格组成的段一律视为 `..`（单个 `.` 除外），因为 Windows 可能去掉段尾的点和空格；Windows 设备名（`NUL`、`com1.log`、`aux .log`）拒绝；读取时按两种分隔符拆段再 resolve，所以 POSIX 上 `\` 也是子目录分隔符。（2026-10-10）
  - 第二轮审查：任何位置的 `:` 都拒绝（Windows 下路径中间的 `x/C:..` 会解析到 C 盘、逃出 cwd；也排除 NTFS 流）。代价：POSIX 上带冒号的文件名（如 `12:00.log`）不能用——配置可能在平台间迁移，规则宁可简单。service 在 resolve 之后再核对结果严格位于 cwd 内。前端校验/推断是后端的手抄副本，`test/unit/server-log-file.test.ts` 对两份跑同一张用例表。（2026-10-10）
  - 新建实例时，推断出的日志文件跟随用户修改的 Executable，直到用户手动改过该字段或模板设置了它；编辑实例时不跟随。（2026-10-10）
- 字段缺失时推断：可执行文件 basename（去掉 `.exe`，不区分大小写）为 `rwr_server` → `rwr_server.log`，否则 `''`。后端在读配置时（内存中，不主动写盘）和 create/update 请求省略该字段时推断；前端套用不含该字段的模板时同样推断。推断只发生在字段缺失时，保存后即为显式值。—— 用户选择；旧 rwr 实例保留入口、steamcmd 自动隐藏，无需手工改。（2026-10-10）
- 模板里该字段只存非空值（与其他模板字段一致"只存填写了的"）；模板无法显式表达"关"，靠推断。—— 极少有 rwr_server 却不要日志的场景。（2026-10-10）
- 关闭时 server-log 接口返回 404 `SERVER_LOG_DISABLED` —— 不只藏按钮。（2026-10-10）
- API 日志分级：≥500 error（带堆栈）；499（客户端中止搜索）debug；≥400 warn；POST/PUT/DELETE info；其余（轮询 GET、静态文件）debug。只记方法、去掉查询串的 URL、状态码、耗时 —— 不记 header/body/查询串，`?token=`、密码不会进日志。—— 用户选择"按重要性分级"。（2026-10-10）
  - 审查后：503（日志文件被锁或读取中被改写，日志页每 2 s 轮询）记 warn 而非 error；info 只给 POST/PUT/DELETE/PATCH，其余方法 debug。交给 Fastify 的 logger 加 serializer：任何 `path`/`url` 字段去掉查询串（`@fastify/websocket` 拒绝升级时会记录带查询串的 `path`），`err` 去掉 `rawPacket`（HTTP 解析错误的原始字节，可能含 Authorization，仅 trace 级可见）。（2026-10-10）
  - 用户确认（2026-10-10）：日志页轮询遇到 503 时记 warn，默认可见（失败要看得到，只有成功的轮询是 debug）。Acceptance"默认级别下轮询 GET 不出现"指成功的轮询。`req` 字段也只记方法和去掉查询串的路径。
- 统一错误处理器：4xx 保留状态码与消息，code `INVALID_REQUEST`；5xx code `INTERNAL_ERROR`，生产环境隐藏消息。（2026-10-10）

## Acceptance
- 成功路径：
  - 新建实例套用 "RWR dedicated server" 模板 → 表单日志文件为 `rwr_server.log`；套用 "SteamCMD" → 空；不套模板（默认 `./rwr_server`）→ `rwr_server.log`。
  - 日志文件为空的实例：实例行（桌面表格和手机卡片）、终端页头都没有日志按钮。
  - 配置 `logs/server.log` 的实例：日志页读 `<cwd>/logs/server.log`，标题/提示/错误文案显示该文件名。
  - 旧 `instances.json`（无该字段）：`executable` 为 `./rwr_server`/`rwr_server.exe`/绝对路径 `.../rwr_server` 的实例有入口；`./steamcmd` 没有。启动后不改写 `instances.json`（直到下次保存实例）。
  - 旧 `templates.json` 的 RWR 模板（无该字段）套用后得到 `rwr_server.log`。
  - 控制台：一次 Start 有 info 行（方法、路径、状态码、耗时）；默认级别下轮询 GET 不出现；`LOG_LEVEL=debug` 时出现。
  - `/api` 路由内未捕获异常：控制台 error 行含堆栈；响应为 `{ success:false, error:{ code:'INTERNAL_ERROR', ... } }`。
- 失败/边界路径：
  - `serverLogFile` 为 `/etc/passwd`、`C:\x.log`、`C:x.log`、`\\host\share\x`、`../x.log`、`a/../../x`、`logs/`、含 NUL → create/update/template 接口 400，磁盘不变。
  - 关闭时直接访问 `/server-log/:id` 页 → "未启用"提示；接口 → 404 `SERVER_LOG_DISABLED`。
  - 日志文件不存在 → 与现在一样显示"尚无日志"（文案用配置名）。
- 不允许发生：
  - 任何接口接受路径/文件名参数；日志里出现 token、Authorization、密码或请求体。
  - 新 logger 绕过 `src/index.ts` 的容错 destination（终端关闭后挂死）。
  - 启动时改写用户的 `instances.json` / `templates.json`。
  - 新 `/api` 路由未登记 `PROTECTED_ROUTES`（本任务不加路由）。

## Evidence
- 自动检查：`npm run typecheck`、`npm test`、`npm --prefix frontend run lint`、`npm --prefix frontend run build`；UI：`npm run build:server && VITE_API_URL= npm --prefix frontend run build` 后 `npm run smoke:instance-form`、`npm run smoke:server-log-ui`；启动/日志改动后 `npm run package && npm run smoke:release`（先移开 `frontend/.env.local`）。
- 人工检查：新建/编辑实例与模板的日志字段；steamcmd 实例无入口；控制台日志行（步骤在 checkpoint 时给出）。
- 高风险 diff：无（中风险）；路径校验函数请顺带过目。

## Checkpoints
- [x] 1. 后端：`serverLogFile` 字段、校验、推断（读配置 + create/update）、模板值与种子、server-log 服务/路由按配置读取、关闭时 404、文案用文件名；单测 + 集成测试。
      证据：`npm run typecheck` 过；`npm test` 791/791；变异（去掉 service 路径复查）被 server-log.test 抓住；Diff Review + Conformance 发现已修（Windows `.. ` 段、非字符串值、设备名、`\` 分隔符、去掉 `.sh` 推断） ｜ commit：`9edb53f`
      留给 CP2：e2e 补 `GET /instances` 带推断值、`POST/PUT /instances` 非法 `serverLogFile` 400 且磁盘不变；手改非法非空值的实例入口会显示，日志页要显示"未启用"。
- [x] 2. 前端：实例/模板表单字段与校验、套用模板时推断、隐藏列表与终端页入口、日志页标题/文案与"未启用"状态；浏览器 smoke 补检查。
      证据（commit `4147b13`）：`npm run typecheck` 过；`npm test` 881/881（新 `instance-config.test.ts` 走真 registry + InstanceService + 路由；单测对前后端两份规则跑同一张表，变异前端规则被抓住）；frontend lint + `tsc -b` 过；`smoke:instance-form` 56/56、`smoke:server-log-ui` 73/73；Diff Review + Conformance + 复核的发现已修（Windows 中段盘符逃逸、新建时日志文件跟随 Executable、禁用后停止加载与重试）；用户在 127.0.0.1:4747 人工验证 5 步全部通过（steamcmd 无入口、新建表单推断与跟随、`logs/console_log.txt` 自定义文件、打开中被关闭、模板表单） ｜ commit：`4147b13`
      用户确认：只更新代码种子，不迁移已有 `templates.json`。
- [x] 3. API 日志：注入容错 logger、分级 onResponse、`/api` 统一错误处理器；集成测试（级别映射、无 token、错误格式）。
      证据：`npm run typecheck` 过；`npm test` 919/919（新 `request-log.test.ts` 单测 + 集成，含 WS 升级）；变异（错误处理器挪回插件之后 / 打开 Fastify 自带请求日志 / 去掉 serializer）均被抓住；`npm run package && npm run smoke:release` 37/37（新增：打包进程默认级别下 start 为 info 行、无读请求行、无 token）；Diff Review + Conformance + 复核的发现已修（503 记 warn、方法规则与 Decision 一致、`path`/`url`/`req`/`err.rawPacket` serializer）；用户人工验证：默认级别登录/PUT 为 info 行、轮询静默、无 `token=`，`LOG_LEVEL=debug` 时轮询出现 ｜ commit：`78b67cd`
- [x] 4. 文档：README（中英）、backlog 删已完成项；package + smoke:release。
      证据：README 中英（功能列表、`LOG_LEVEL`、模板种子、"服务器日志查看器"一节、API 表）；backlog 删"Fastify 错误处理器"，加 Windows 规则未实跑、重复 send 警告、终端 WS 无请求行、终端页状态不重置；最终代码上 `npm run typecheck` 过、`npm test` 919/919、`npm run package && npm run smoke:release` 37/37、`smoke:restart-policy` 48 过 / 4 跳过（Windows 专用） ｜ commit：见 git log

## Pitfalls

## Sources
- `src/core/instance/instance-types.ts`、`src/api/http/schemas/{instance,template}-schemas.ts`、`src/core/template/template-types.ts`、`src/core/config/{instance-config-store,template-store}.ts`
- `src/services/server-log-service.ts`、`src/api/http/routes/server-log-routes.ts`
- `src/api/http/http-server.ts`（`fastify({...})` 无 logger；`setErrorHandler` 在 `/api` 插件之后——fastify 5.8.4 实测 `/api` 内抛错走默认处理器）、`src/index.ts`（`logDestination`）
- `frontend/src/services/{instanceForm,apiService}.ts`、`frontend/src/components/InstanceFormFields.tsx`、`frontend/src/pages/{InstanceListPage,TerminalPage,ServerLogPage}.tsx`
- Fastify v5：自定义 logger 用 `loggerInstance`（`logger` 不再接受实例）；错误处理器按封装上下文生效。
