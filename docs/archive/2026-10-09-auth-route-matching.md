# /api 鉴权按匹配到的路由判断（修复鉴权绕过）

- 日期：2026-10-09
- 风险：高（认证）
- Commits：`c788371`..（PR #10，分支 `fix/auth-route-matching`）
- 相关 ADR：无

## 结果
修复前，鉴权 `preHandler` 用原始 `request.url` 做前缀判断，而路由匹配的是规范化后的路径：它会解码 `%xx`，也接受 absolute-form 请求行。所以只要把路径写成编码形式或用 absolute-form，不带 token 也能访问任意受保护的 `/api` 路由，包括创建、启动实例，等于可以执行任意程序。配置强密码并对外监听时，这就是远程未鉴权的代码执行。这个问题在 B2（rwr_server.log 接口）的独立 Diff Review 中被发现，并在本地复现。

修复后，钩子放在 `/api` 插件内部，插件里的路由默认都要求 token；是否公开由路由自己的 `config: { public: true }` 决定，按方法区分。所有已发布版本都受影响，建议发新版。

## 关键决策
| 决策 | 原因 | 否决方案及原因 |
| --- | --- | --- |
| 钩子挪进 `/api` 插件，默认拒绝；公开路由在路由选项上标 `config.public` | 判断依据是匹配到的路由本身，与 URL 怎么写无关；新增路由默认受保护；可以按方法区分 | 按 `routeOptions.url` 加路由模式白名单（第一版）：仍依赖 `/api/` 前缀字符串，比如 `/api` 精确路由、插件外的路由会被放行，而且白名单不区分方法 |
| 终端 WS 路由 `exposeHeadRoute: false` | 自动生成的 HEAD 路由会把 socket handler 当 HTTP handler 调用，返回 500（既有问题） | — |
| 不带 token 访问未知 `/api/...` 返回 404（原来是 401） | 未匹配路由不进入插件作用域，不泄露任何信息；路由表本来就在 README 和前端代码里公开 | 为了保持 401 去额外处理 404：没有安全收益 |
| `smoke:auth` 进 CI，并带路由清单守卫 | 以后新增 `/api` 路由时，必须明确选择受保护还是公开 | 只在本地跑：回归无法阻断合并和发版 |

## 确立的规范
- 鉴权**绝不**根据原始 URL 字符串判断；新增公开路由要在路由选项里标 `config: { public: true }`，新增受保护路由要登记到 `scripts/smoke-auth.ts` 的清单（已写入 CLAUDE.md）。
- 鉴权回归测试的写法：用真实的 `createHttpServer`，service 全部换成计数桩，断言状态码为 401 且 handler 调用次数为 0。路径写法要覆盖编码、大小写混合的十六进制、absolute-form（只能走原始 socket，inject 会把它规范化掉）以及 WS upgrade。

## Pitfalls
- `fastify.inject` 会把 absolute-form 请求行规范化成普通路径，测不出这类绕过，必须用原始 socket 发请求。
- 某个 handler 返回非 401 的 4xx（比如 schema 校验失败的 400），也说明它绕过了鉴权。断言必须严格要求 401 且调用次数为 0，不能只看"没有返回 200"。
- 编码写法的变体要覆盖十六进制里含字母的字符：`api`、`auth`、`audit` 的十六进制全是数字，测不出大小写差异。

## 剩余风险 / 后续
- 静态 `AUTH_TOKEN` 不是常量时间比较；错误处理器没有 logger，而且注册得晚。两条都已记入 backlog。
- 已发布版本都受影响：需要发 v0.1.9，并在 Release 说明里写清楚升级建议。
- 同一 PR 里把 `actions/upload-artifact` 升到 v7、`download-artifact` 升到 v8（换成 Node 24 运行时）。download 那一步只在推 tag 时运行，要到下次发版才能真正验证。

## 指针
- `src/api/http/http-server.ts`（`/api` 插件内的 `preHandler` 和 `publicRoute`）
- `scripts/smoke-auth.ts`、`.github/workflows/release.yml`（"Smoke-test API authentication"）
- [backlog](../backlog.md) 的"安全"一节
