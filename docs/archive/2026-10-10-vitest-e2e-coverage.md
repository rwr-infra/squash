# 剩余 smoke 迁入 Vitest，接入 Codecov 覆盖率

- 日期：2026-10-10
- 风险：中（改 CI、npm scripts，新增 devDependency 和外部服务；主要风险是迁移中静默丢掉检查）
- Commits：`b8a85d5`..`aeeca96`（分支 `test/vitest-e2e`）；`b8a85d5` 是顺带的页面 title 修正
- 相关 ADR：无

## 结果

`scripts/` 下剩下的四个 smoke 改成了 Vitest 测试，放在 `test/e2e/`，npm script 名称不变：

| npm script | 测试文件 | 前置条件 |
| --- | --- | --- |
| `smoke:restart-policy` | `restart-policy.test.ts` | 构建后端和前端 |
| `smoke:release` | `release.test.ts` | 发布包 |
| `smoke:instance-form` | `instance-form.test.ts` | 前端构建，本地运行 |
| `smoke:server-log-ui` | `server-log-ui.test.ts` | 前端构建，本地运行 |

`scripts/` 现在只剩打包代码和 `diagnostics/`（Windows PTY 探针）。

旧日志里的 198 条 PASS 检查，新测试中都有同名测试，缺失 0，打印顺序也一致；每个文件另加一条 "the flow ends without an error"。

`npm run test:coverage` 统计 `src/` 的覆盖率，V8 报告中 statements 约 62%。CI 的三个平台都会上传到 Codecov，合并后为 59.79%（1368 行中 818 行）；两份 README 加了徽标。

CI（运行 38036574309，`aeeca96`）三个平台第一次就全绿：

| 平台 | Test（含覆盖率） | restart-policy | release |
| --- | --- | --- | --- |
| ubuntu | 646 条 / 50 s | 48 条 + 4 条跳过 / 68 s | 34 条 / 10 s |
| macOS | 646 条 / 49 s | 48 条 + 4 条跳过 / 68 s | 34 条 / 11 s |
| Windows | 635 条 + 11 条跳过 / 97 s | 52 条（含 4 条 Windows 专属）/ 87 s | 28 条 + 6 条 POSIX 专属跳过 / 19 s |

覆盖率（statements）：Linux 和 macOS 62.0%，Windows 63.0%。

## 关键决策

| 决策 | 原因 | 否决方案及原因 |
| --- | --- | --- |
| 四个 smoke 都用"记录后断言"（`test/helpers/checks.ts`）：整段旧流程放在 beforeAll 里原样跑一次，每条 check 对应一个同名测试 | 这些观察都依赖时序。旧流程原样不动，观察的时机就和以前完全一样；上次迁移 supervisor 用的也是这个办法 | 每个 check 改写成独立的 `it`：观察时机会悄悄改变 |
| 检查失败时抛 `CheckFailed`（等于旧脚本的提前退出）；非检查类异常和清理问题，交给每个文件唯一新增的测试 "the flow ends without an error" | 旧脚本因异常退出时，在新测试里有一个明确的对应位置 | beforeAll 直接抛错：Vitest 会把全部测试标成 skipped，看不出哪些检查已经通过 |
| 清理由 helper 统一执行一次；流程超时时由 afterAll（90 s）接手；清理开始后，流程不再启动新进程 | 审查发现了三个问题：超时会和正在进行的清理竞争；检查失败之后，清理出的问题没人报告；Windows 上 PID 会被复用 | 每个文件自己写 try/finally：这三类问题在每个文件里都要重写一遍 |
| e2e 配置放在 `test/e2e/e2e.config.ts`，不叫 `vitest.e2e.config.ts` | VS Code Vitest 插件默认会加载所有匹配 `**/*{vite,vitest}*.config*` 的文件，会去跑依赖构建产物的测试 | 起初用的就是 `vitest.e2e.config.ts`，审查时发现会被插件加载 |
| 浏览器测试保留手写的 CDP 客户端（抽成 `test/helpers/cdp.ts`），不换 Playwright | 用户选择 1:1 迁移。触摸惯性滚动、wheel、`overflow-anchor` 这些细节，改写最容易改坏 | Playwright / playwright-core：要改写 1000 多行，证明没改坏的成本高，留在 backlog |
| 浏览器测试从 `src/` 导入 schema 和服务端 | 不再需要先 `build:server`；与 integration 测试一致 | 继续从 `dist/` 导入 |
| 覆盖率只统计 `npm test`，范围是 `src/` | e2e 跑的是子进程里的 `dist/` | 用 `NODE_V8_COVERAGE` 收集子进程覆盖率：要借助 sourcemap 映射回源码，复杂度高，记入 backlog |
| Codecov 的上传步骤：放在 package job 的最后一步，只在分支 push 且 Test 通过时运行；`fail_ci_if_error: true` 配合 `continue-on-error: true`；按 commit 固定为 v7.1.1；token 用组织级 secret `CODECOV_TOKEN` | codecov wrapper 在 `fail_ci_if_error: false` 时，签名或 SHA 校验失败也照样运行 CLI；action 会把 token 写进 `GITHUB_ENV`，传给后续步骤；tag 那次运行要出 release | `@v5` 浮动标签加 `fail_ci_if_error: false`：这是拿到 secret 的第三方代码，校验失败也会运行 |
| `codecov.yml` 中 status 全部设为 informational，并设 `after_n_builds: 3` | 覆盖率只作参考，不阻塞提交；等三个平台都传完再通知 | 默认的 status 规则：可能把提交标红 |
| release 的归档路径改用 `SQUASH_RELEASE_ARCHIVE` 环境变量指定 | npm script 不再把参数透传给脚本 | 命令行参数 |
| 去掉 evidence JSON 和末尾的汇总行 | 仓库里没有任何地方读它们，Vitest 报告可以替代 | 保留 |

## 确立的规范

- e2e 测试的写法已写入 CLAUDE.md 的 Tests 小节：配置文件的位置与命名、`recordedChecks` 的约定、流程自己创建临时目录（不用 `useTempDir()`）、清理开始后不再启动进程、`cdp.ts` 的用途。
- 迁移或重写检查时，证据要齐三样（沿用上次的规范）：
  - 运行时清单比对；
  - 新旧对照的变异测试：至少一个"检查失败"路径和一个"流程异常"路径；
  - 逐条审查断言。
- 变异判定：
  - 旧失败 ⊆ 新失败，多出来的只能是 "not recorded"；
  - 旧脚本因异常退出时，在新测试里对应的是 "the flow ends without an error" 报出同一个错误。
- release 的变异不需要重新打包：解压归档、改动包内文件、重新打成 tar，再用 `SQUASH_RELEASE_ARCHIVE` 指过去。浏览器测试的变异直接改 `frontend/dist/assets/*.js`，跑完从备份恢复。

## Pitfalls

- **Vitest 在 AI agent 里运行时，会隐藏通过测试的 console 输出**：看计时日志要加 `--silent=false`。CI 中不受影响。
- **`--coverage.reporter=…` 会覆盖配置里的 reporter**，而 `coverage.clean` 会先清空 `coverage/`：这样跑完就没有 `lcov.info` 了。
- **stash 了已暂存的删除，再在 HEAD 提交同一删除（被识别为改名）后，`git stash pop` 会冲突**：要冲突文件取 HEAD 版本，未跟踪文件会原样恢复。暂放文件改成挪到 `.cache/` 更简单。
- **zsh 的 `grep` 是 ugrep 的别名**：模式里的 `$` 会被当成锚点，查字面量要用 `grep -F`。
- **用 `--remote-debugging-port=0` 统计残留 Chrome 不可靠**：用户自己的工具也会带这个参数启动 Chrome。要按测试的 profile 路径（`instance-form-`、`squash-server-log-ui-`）来筛。
- **Codecov 报 `Repository not found`（"Upload queued for processing failed"）**：token 不属于这个仓库，例如另一个 owner 的 global upload token。要在 codecov.io 上切到 rwr-infra 组织，再取该仓库的 upload token，或者 rwr-infra 的 global upload token。由于上传步骤设了 `continue-on-error`，CI 仍是绿的，必须看上传日志才能发现。
- **Codecov 的百分比比 V8 报告的低，不能直接比较**：Codecov 按"完全覆盖的行 / 总行数"计算，部分覆盖的行（有分支没走到）算作未覆盖，只出现在 `BRDA`、没有 `DA` 的行也计入总数。按这个口径用本地 lcov 能精确复算出 Codecov 的数字。
- **`Promise && 对象` 并不会挂起**：Promise 是真值，表达式会直接得到后面的对象。想让 handler 永不返回，要写 `||`，或者 `await new Promise(() => {})`。

## 剩余风险 / 后续

- 开覆盖率后，计时检查在 CI 上的余量：读末尾最慢 1.0 ms（阈值 100 ms），刷新最慢 5.5 ms（阈值 20 ms，三次取最小值），事件循环卡顿最多 2 ms（阈值 200 ms）。
- Codecov：
  - 前两次 CI 运行（同一 run 的第 1、2 次尝试）都报 `Repository not found`：组织 secret 里的 token 不属于 rwr-infra/squash。用户换成正确的 token 后，第 3 次尝试三个平台都上传成功，仓库随之激活。
  - 各 flag 的覆盖率：Linux 和 macOS 57.53%，Windows 58.99%，合并 59.79%。
  - README 徽标读的是 main 分支，要等合并后的第一次上传完成才会显示数字。
- 浏览器测试仍只在本地跑；CI 接入、Playwright、前端单测和覆盖率、e2e 子进程覆盖率都已记入 [backlog](../backlog.md)。
- 继承自旧脚本的盲点已记入 backlog：release 的 "terminal WebSocket connects" 只看 `onopen`。另有 8 条 `check(label, true)`，实际由前面的 waitFor 把关，不是恒真检查。
- 超时路径上还有几个时间窗口极小的竞态，例如清理恰好落在 `server.listen` 或 `createHttpServer` 期间。最坏情况是留下一个没有 listen 的 Fastify 实例，或者一个直到 fork 退出才释放的端口，已接受。
- `scripts/node-runtime.d.mts` 是手写的类型声明，不在 typecheck 的直接范围内；与 `.mjs` 的导出发生漂移时，typecheck 发现不了。

## 指针

- `test/e2e/`（4 个测试 + `e2e.config.ts`）、`test/helpers/checks.ts`、`test/helpers/cdp.ts`
- `vitest.config.ts`（coverage 段）、`codecov.yml`、`.github/workflows/release.yml`（Test 步骤与 Codecov 上传步骤）
- 被替换的旧脚本：`git show 524df10:scripts/smoke-<name>.mjs`
