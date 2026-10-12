# 每个实例可配置服务器日志文件；API 请求日志

- 日期：2026-10-10 – 2026-10-12
- 风险：中（改实例/模板共享 schema 和接口行为；推翻"日志路径不可配置"的旧决定；日志接线挨着防 EIO 挂死的 destination）
- Commits：`9edb53f`..`7cdd56d`（分支 `feat/server-log-file`）
- 相关 ADR：无

## 结果
- **日志文件按实例配置。** 实例有 `serverLogFile` 字段：相对 `cwd` 的日志文件路径，`''` 表示没有日志查看器。
  - 留空的实例（如 SteamCMD）在实例行（表格和卡片）和终端页都没有 Log 按钮。
  - 预设 RWR 模板带 `rwr_server.log`。
  - 日志页的标题、查找框和错误文案都用配置的文件名；没有日志文件时显示提示，页面打开期间被关掉时也一样。
- **API 请求日志。** squash 控制台每个请求一行：方法、去掉查询串的路径、状态码、耗时。
  - 写操作（POST/PUT/DELETE/PATCH）记 info，读请求（轮询、静态文件）记 debug，4xx 和 503 记 warn，其余 5xx 记 error。
  - 修好了 `/api` 内从未生效的统一错误处理器：500 现在带堆栈记录，响应为 `INTERNAL_ERROR` 格式。
- 用户在 macOS 上人工验证：steamcmd 没有入口、新建表单的推断和跟随、自定义文件 `logs/console_log.txt`、页面打开期间被关闭、模板表单、默认级别和 debug 级别的控制台输出。

## 关键决策
| 决策 | 原因 | 否决方案及原因 |
| --- | --- | --- |
| 可配置路径（相对 `cwd`），不是布尔开关 | 用户选择：其他游戏、steamcmd 的 `logs/console_log.txt` 也能看。持 token 的人本来就能设任意 `cwd`/`executable` 执行任意程序，读文件不是新增能力 | 布尔开关加固定 `rwr_server.log`：旧归档的做法，只适用于 rwr |
| 路径规则：拒绝绝对路径和 UNC、任何位置的 `:`、只由点和空格组成的段（单个 `.` 除外）、Windows 设备名、末段为空或 `.`；`/` 和 `\` 在所有平台都算分隔符；service 在 resolve 之后再核对结果严格位于 `cwd` 内 | 配置可能跨平台迁移，按两套规则一起校验。Windows 上 `x/C:..` 会解析到 C 盘，`.. ` 会被当成 `..` | 只拒绝开头的盘符：路径中间的盘符段能逃出 `cwd`（审查发现，已用 `path.win32` 复现）。允许 POSIX 文件名里的 `:`：规则会变成和平台相关 |
| 字段缺失时按可执行文件推断：basename 为 `rwr_server(.exe)`（不区分大小写）→ `rwr_server.log`，否则 `''`。推断发生在读 `instances.json` 时（只在内存）、create/update 请求省略字段时、service 兜底、前端套用不含该字段的模板时 | 旧 rwr 实例保留入口，steamcmd 自动隐藏，谁都不用手动改；启动时不改写用户文件 | 缺失视为关：旧 rwr 实例会丢入口。缺失视为开：steamcmd 要逐个改 |
| 不迁移已有 `templates.json` | 用户确认；推断的结果相同；模板存储的原则是从不改动已有文件 | 启动时按名字补字段：按名字识别模板不可靠 |
| 模板里该字段只存非空值，没法表达"不要日志" | 和其他模板字段一致："只存填了的" | 允许 `''`：模板语义会多一种状态 |
| 新建实例时，推断出的值跟随用户修改的 Executable，直到用户手动改过该字段或模板设置了它；编辑实例时不跟随 | 改成 steamcmd 后还留着 `rwr_server.log` 是错的；只在表单的 `onValuesChange`（用户操作）里重新推断，套用模板时调用的 `setFieldsValue` 不会触发 | 只在打开表单时推断一次（审查发现的问题） |
| 关闭时 server-log 三个接口都返回 404 `SERVER_LOG_DISABLED`，前端停止轮询 | 不只是把按钮藏起来；和 `INSTANCE_NOT_FOUND` 区分开 | 只在前端隐藏 |
| 请求日志用根上的 `onResponse` 钩子，关掉 Fastify 自带的请求日志 | Fastify 自带的每个请求两行，还带查询串（终端 WS 的 `?token=`） | `disableRequestLogging: false` |
| 交给 Fastify 的 logger 加 serializer：`path`、`url`、`req` 去掉查询串，`err` 去掉 `rawPacket` | `@fastify/websocket` 拒绝升级时会记录带查询串的 `path`；Fastify 在写不出响应时会记录 `req`；HTTP 解析错误的原始字节可能含 Authorization | 只在自己的钩子里去掉查询串：第三方日志照样泄露 |
| 503（日志文件被锁或读取中被改写）记 warn，默认可见 | 用户确认：失败要看得到，只有成功的轮询是 debug | GET 的 503 记 debug：文件长期读不了时控制台里看不到 |
| `setErrorHandler` 放在所有 `register` 之前；抛出的 4xx 保留状态码，code 为 `INVALID_REQUEST`；其余为 500 `INTERNAL_ERROR`，记录堆栈 | 插件在注册那一刻就定下了用哪个错误处理器（fastify 5.8.4 实测：之后才设置的处理器对 `/api` 内的路由无效） | 保持原位：`/api` 抛错时返回 Fastify 默认格式，日志也是空的 |

## 确立的规范
- **服务器上的文件**：路径只来自实例配置（`serverLogFile`，相对 `cwd`），任何接口都不接受路径参数。读之前用 `isValidServerLogFile` 校验，resolve 之后再检查是否越界。
- **前端手抄的后端规则**（`frontend/src/services/instanceForm.ts` 里的 `isValidServerLogFile` / `inferServerLogFile`）由 `test/unit/server-log-file.test.ts` 按路径动态 import，和后端跑同一张用例表。改其中一边，另一边必须同步。
- **HTTP 日志**：`createHttpServer` 只用注入的 `deps.logger`，也就是 `src/index.ts` 那个带容错 destination 的 logger，不能自己新建 pino。新加的日志字段里如果有 URL，要经过 `requestLogSerializers` 处理。
- **错误处理器和根钩子**：要对所有路由生效，就必须在注册任何插件之前设置。
- **表单**：要区分"用户改的"和"程序设置的"，用 `<Form onValuesChange>`，它不会被 `setFieldsValue` 触发。
- **测试 `appPaths`**：用 `vi.mock('../../src/app/paths.js')` 加 `vi.hoisted` 指到临时目录，见 `test/integration/instance-config.test.ts`。日志输出用内存流的 pino 抓取，见 `test/integration/request-log.test.ts`。

## Pitfalls
- **`setErrorHandler` 设得太晚**：在 `server.register(...)` 之后才调用，已注册插件里的路由仍用 Fastify 默认处理器。现象是 `/api` 抛错时返回 `{statusCode, error, message}`。
- **接上 logger 后第三方日志开始输出**：以前 `server.log` 是 noop，`@fastify/websocket` 那行带查询串的日志被吞掉了；一接上 logger 就会写出来。接 logger 时要排查依赖里的 `log.*` 调用。
- **重做变异测试时剪错代码块**：用 `"  });\n"` 找块结尾，会先匹配到更深缩进的 `"    });"`，剪出的代码有语法错误，测试文件被整个跳过（显示 skipped），看起来像"变异没被抓住"。要用 `"\n  });\n"` 匹配，并确认编译通过。
- **e2e 的桩 registry 不带新字段**：`server-log-ui` 的桩配置没有 `serverLogFile`，又因为 `executable: 'x'` 被推断为关闭，浏览器 smoke 会整体失败。它不在 CI 里，只有本地跑才发现。给配置加字段时，要 grep 所有手写的配置桩。
- **plain create 和 createFormValues 不是一回事**：plain create 以前直接用 `CREATE_DEFAULTS`，绕过了 `createFormValues` 里的推断。现在统一用 `createFormValues()`。

## 剩余风险 / 后续
- Windows 上的路径规则（盘符段、设备名、`\` 分隔符、越界检查）没有实跑，只在 macOS 上用 `path.win32` 推导和单测验证过。已记入 backlog。
- Fastify 重复 send 时会记一条 warn，消息里有完整 URL；目前没有会触发它的路径。已记入 backlog。
- 打开终端（WS）不产生请求日志行；终端页切换实例时状态不重置。都已记入 backlog。
- `auth.ts` 的独立 pino 没有走容错 destination，便携包输出的还是 JSON。保留在 backlog 的"日志体验"条目里。
- 模板没法表达"不要日志"（设计如此）：rwr_server 实例清空日志文件后再"存为模板"，用这个模板新建的实例又会推断出 `rwr_server.log`。

## 指针
- `src/core/log/server-log-file.ts`（规则、推断、`serverLogFileOf`）、`src/services/server-log-service.ts`、`src/api/http/routes/server-log-routes.ts`
- `src/api/http/schemas/{instance,template}-schemas.ts`（`CreateInstanceSchema` 的 transform 负责推断）、`src/core/config/{instance-config-store,template-store}.ts`
- `src/api/http/request-log.ts`（级别、路径、serializer）、`src/api/http/http-server.ts`（钩子和错误处理器的位置）、`src/index.ts`（传入 logger）
- 前端：`frontend/src/services/instanceForm.ts`、`components/InstanceFormFields.tsx`、`pages/{InstanceListPage,TerminalPage,ServerLogPage}.tsx`
- 测试：`test/unit/{server-log-file,request-log}.test.ts`、`test/integration/{instance-config,request-log,server-log,templates}.test.ts`、`test/e2e/{instance-form,server-log-ui,release}.test.ts`
- 被推翻的旧决定：[rwr_server.log 查看器](2026-10-10-server-log-viewer.md) 的"路径固定"
