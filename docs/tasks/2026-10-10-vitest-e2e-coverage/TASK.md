# Task: 把 scripts/ 剩余 smoke 迁入 Vitest，接入 Codecov 覆盖率徽标

- Risk: 中 —— 改 CI、npm scripts，新增 devDependency 和外部服务；主要风险是迁移时静默丢掉检查，以及覆盖率插桩拖慢 integration 的计时检查
- Commit policy: auto（每个 checkpoint 在功能分支上提交；push、PR、merge 每次单独确认）
- Branch: `test/vitest-e2e`

## Goal
`scripts/` 下四个 smoke（restart-policy、release、instance-form、server-log-ui）改为 Vitest 测试，npm script 名称不变，迁移中不丢、不放宽任何检查。`npm run test:coverage` 产出后端覆盖率，CI 在三个平台上传到 Codecov，两份 README 显示覆盖率徽标。

## Scope
- 必须完成：
  - `vitest.e2e.config.ts`，包含 `restart-policy`、`release`、`browser` 三个 project（加入 `tsconfig.json` 的 include）；`test/e2e/*.test.ts`；共享 helper 放在 `test/helpers/`（包括从两份浏览器 smoke 中抽出的 CDP 客户端）
  - 删除 `scripts/smoke-{restart-policy,release,instance-form,server-log-ui}.mjs`；`package.json` 里的 `smoke:*` 改为调用 Vitest
  - 新增 `@vitest/coverage-v8@5.0.3`（精确版本）和 `test:coverage`；在 `vitest.config.ts` 里配置覆盖率（v8，只统计 `src/**/*.ts`，输出 lcov）；`.gitignore` 加 `coverage/`
  - CI：Test 步骤改为 `npm run test:coverage`，三个平台都上传 Codecov（`flags` 为 OS，`CODECOV_TOKEN` secret，出错不让 CI 变红，见 Decisions）；新增 `codecov.yml`（status 设为 informational，不阻塞）
  - `README.md` 和 `README.zh-CN.md` 加徽标、更新测试小节；更新 CLAUDE.md 的 Commands 和 Tests 小节；更新 backlog
- 明确不做：
  - 换成 Playwright
  - 在 CI 里跑浏览器测试
  - 前端单测或前端覆盖率
  - e2e 子进程的覆盖率（`NODE_V8_COVERAGE`）
  - 改 `scripts/diagnostics/`、`package.mjs`、`node-runtime.mjs`
  - backlog 里的其他条目
  - 加强旧检查：发现盲点只记录。例外是恒真检查，发现后先问用户

## Decisions
- 每个 checkpoint 自动 commit —— 用户选择（2026-10-10）
- 浏览器 smoke 1:1 迁入 Vitest，保留手写 CDP，抽出公共 helper —— 不加依赖，观察时机不变；Playwright 留在 backlog（用户选择，2026-10-10）
- Codecov 用 `CODECOV_TOKEN` secret 上传 —— 用户选择；secret 由用户建为组织级 secret，已确认仓库可见（2026-10-10）
- 上传步骤（CP1 审查后修订）：
  - 位置与触发：放在 package job 的最后一步，只在分支 push 且 Test 通过时运行；
  - 失败处理：`fail_ci_if_error: true` 配合 `continue-on-error: true`，并设 5 分钟超时；
  - 版本：action 按 commit 固定为 v7.1.1。
  
  原因：`fail_ci_if_error: false` 时，codecov wrapper 在签名或 SHA 校验失败后仍会运行 CLI；action 还会把 token 写进 `GITHUB_ENV`，传给后续步骤；而且 tag 上的这次运行要出 release。否决 `@v5` 浮动标签：这是拿到 secret 的第三方 action（2026-10-10）
- 覆盖率三个平台都跑，按 OS 打 flag，由 Codecov 合并 —— 用户选择；Windows 专属分支也能计入（2026-10-10）
- e2e 放在单独的 `vitest.e2e.config.ts` —— `npm test` 和 IDE 插件都不会去跑依赖构建产物或 Chrome 的测试（2026-10-10）
- 保留 `smoke:*` 这些 npm script 名称 —— CI、README、CLAUDE.md 改动最小（2026-10-10）
- 测试改写为 TS 并纳入 typecheck；浏览器测试改从 `src/` 导入 schema 和服务端（原来从 `dist/` 导入），不再需要先 `build:server` —— 与 integration 一致（2026-10-10）
- 覆盖率只统计后端 `src/` —— 前端没有单测；e2e 跑的是子进程里的 `dist`，不计入（2026-10-10）
- 范围追加：前端页面 title 从 `frontend` 改为 `squash`（`frontend/index.html`），单独提交 —— 用户要求（2026-10-10）

## Acceptance
- 成功路径：
  - 四个 `npm run smoke:*` 都由 Vitest 执行。四个都在本机 macOS 上通过；restart-policy 和 release 在 CI 三个平台上通过
  - 运行时清单：每个文件的旧日志 PASS label 与 Vitest JSON 报告里的测试名按多重集比对，缺失为 0。平台专属的检查在其他平台上显示为 skipped，名称照样计入比对
  - 变异测试：每个文件至少改坏一处产品代码，新旧两边失败的检查相同（判定标准沿用上次：旧失败 ⊆ 新失败，多出来的只能是 "not reached"）
  - `npm test` 的含义不变（unit + integration，646 条），全部通过
  - `npm run test:coverage` 生成 `coverage/lcov.info`；带覆盖率时，计时检查在本机连跑 3 次都通过，在 CI 三个平台上也通过
  - CI 上传时带 `Linux` / `macOS` / `Windows` 三个 flag。用户配置好 token 后，codecov.io 能看到分支的覆盖率，合并后 README 徽标显示百分比
- 失败/边界路径：
  - 没有 `CODECOV_TOKEN` 时上传失败，但 CI 保持绿色
  - 缺少前置构建（dist、frontend/dist、发布包、Chrome）时，测试立即失败并给出明确提示
  - 测试失败或超时后，不残留进程（fixture 子进程、launcher、Chrome）。restart-policy 失败时保留 fixture 供诊断，成功时删除
  - 用 `-t` 只跑一部分时，不残留临时目录
- 不允许发生：
  - 丢掉或放宽任何检查
  - `npm test` 开始依赖构建产物或 Chrome
  - e2e 改动 checkout 里的 `config/instances.json` 或 `logs/`（restart-policy 检查前后指纹一致）
  - 覆盖率导致 CI 计时检查偶发失败（一旦出现就停下来，由用户决定）
  - token 进入仓库或日志

## Evidence
- 自动检查：
  - `npm run typecheck`
  - `npm test`
  - `npm run test:coverage`
  - `npm run build:server && VITE_API_URL= npm --prefix frontend run build && npm run smoke:restart-policy && npm run smoke:instance-form && npm run smoke:server-log-ui`
  - `npm run package && npm run smoke:release`（先把 `frontend/.env.local` 移开，结束后放回）
- 清单比对：旧脚本输出里的 PASS 行（基线存在 `.cache/baseline/`）对比 `npx vitest run --config vitest.e2e.config.ts --project <p> --reporter=json --outputFile=…`
- 人工检查：用户在 codecov.io 激活仓库，添加 `CODECOV_TOKEN` secret；push 后确认分支的上传出现在 codecov.io；合并后确认 README 徽标
- 高风险 diff：无（中风险）。CI 和 package.json scripts 的改动会单独指出

## Checkpoints
- [x] 0. 基线：本机跑四个旧脚本，PASS 清单和耗时存到 `.cache/baseline/`（不提交）
      证据：`npm run package` 后依次 `npm run smoke:*` 全部 exit 0；macOS 上 PASS：restart-policy 47、release 33、instance-form 49、server-log-ui 69（文件内无重复 label）；耗时依次为 75 / 12 / 14 / 51 s
- [x] 1. 覆盖率：coverage-v8、`test:coverage`、CI 上传步骤、`codecov.yml`、两份 README 的徽标；带覆盖率测量计时检查
      证据：
      - `npm run typecheck` 通过；`npm test` 646 条通过；`npm run test:coverage` 连跑 3 次，646 条都通过（statements 62.02%，lines 62.23%），lcov 路径为 `SF:src/…`
      - 开覆盖率后的计时：建索引 36–39 ms（不开时 29 ms），读末尾 ≤ 0.6 ms，刷新 ≤ 0.2 ms，事件循环卡顿 0 ms
      - `codecov.yml` 通过 codecov.io/validate；npm audit 仍是原有的 8 条
      - Diff Review：1 medium 和 2 条 low 已修复并复核；CLAUDE.md 的更新放到 CP6；CI 上的计时等首次运行确认
      ｜ commit：见 git log（`test: measure backend coverage …`）
- [ ] 2. restart-policy → `test/e2e/restart-policy.test.ts`，新建 `vitest.e2e.config.ts`，删除旧脚本
      证据： ｜ commit：
- [ ] 3. release → `test/e2e/release.test.ts`（归档路径改由 `SQUASH_RELEASE_ARCHIVE` 指定），删除旧脚本
      证据： ｜ commit：
- [ ] 4. `test/helpers/cdp.ts` + instance-form → `test/e2e/instance-form.test.ts`，删除旧脚本
      证据： ｜ commit：
- [ ] 5. server-log-ui → `test/e2e/server-log-ui.test.ts`，删除旧脚本
      证据： ｜ commit：
- [ ] 6. 文档：CLAUDE.md、两份 README 的测试小节、backlog；push 并跑 CI 三平台（需要授权），在 Codecov 上确认
      证据： ｜ commit：

## Pitfalls
（出现时追加）

## Sources
- 上次迁移的约定与 Pitfalls：`docs/archive/2026-10-10-vitest-migration.md`；CLAUDE.md 的 Tests 小节
- `vitest.config.ts`、`test/helpers/`、`.github/workflows/release.yml`
- Vitest 5.0.3：`--project` 可以重复传入；`coverage.include` 默认只包含被导入过的文件；`coverage.clean` 会清空 reportsDirectory（context7 `/vitest-dev/vitest/v5.0.3`）
- codecov-action v5：输入 `token`、`files`、`flags`、`disable_search`、`fail_ci_if_error`（context7 `/codecov/codecov-action`）
