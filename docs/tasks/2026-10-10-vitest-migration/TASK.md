# Task: 引入 Vitest，替换 CI 中的四个 smoke 脚本

- Risk: 中 —— 改 CI、npm scripts、新增 devDependency，等于改变"检查命令"的含义；主要风险是迁移中静默丢检查（错误会延迟暴露）。不改产品代码，git 可回滚。
- Commit policy: auto（功能分支，每个 checkpoint 一个 commit；push / PR / 合并每次单独确认）
- Branch: `test/vitest-migration`

## Goal

`npm test`（Vitest 5）取代 `smoke:auth` / `smoke:templates` / `smoke:server-log` / `smoke:supervisor`，在 CI 三平台上运行，覆盖不少于原来的 591 条检查；另补上绑定闸门的单元测试，并清理无人使用和已经错位的脚本。

## Scope

- 必须完成：
  - Vitest 基建：`vitest.config.ts`（projects：`unit`、`integration`；`pool: 'forks'`）、`test/helpers/`、tsconfig 覆盖 `test/`，npm scripts `test` / `test:watch`
  - 新增单元测试：`resolveBindHost` / `isLoopbackHost`（`src/app/bind-host.ts`）真值表；`isWeaklyProtected`（`src/api/http/auth.ts`）在各种环境变量组合下的取值
  - 迁移 4 个 CI smoke 到 `test/integration/`，迁移后删除旧脚本和对应 npm scripts
  - CI（`release.yml`）里 4 个 smoke 步骤合并为一个 `npm test` 步骤，位置不变（Typecheck 之后、Package 之前）
  - 删除遗留：`scripts/verify-step-2-2.ts`、`scripts/pty-rwr-smoke.ts`、`src/smoke/`（4 个文件）、npm script `smoke:pty`
  - Windows PTY 探针（`smoke-pty-cleanup/lifecycle/exit-window/handles.mjs`）移到 `scripts/diagnostics/`，修正相对路径，npm script 名称不变（README / backlog 不用改）
  - CLAUDE.md 命令与检查说明同步（以 diff 形式给用户确认）
- 明确不做：
  - `smoke-restart-policy`、`smoke-release`（B 类，构建产物 e2e）—— 后续任务
  - `smoke-instance-form`、`smoke-server-log-ui`（C 类，浏览器）改 Playwright Test —— 后续任务
  - 前端单测（jsdom）、覆盖率门槛 —— 后续任务
  - 任何 `src/` 产品逻辑改动（唯一例外：删除 `src/smoke/`）
  - 修改 `docs/archive/` 里的历史文档

## Decisions

- Vitest 5（5.0.3）而不是 `node:test` + tsx 或 Jest —— 支持 Node 24、Vite 8，TS/ESM 不用额外配置，projects 可分组，以后前端测试也能沿用（用户选定，2026-10-10）
- 本任务只做 A 类 + 基建 + 清理，B/C 另开任务（用户选定，2026-10-10）
- 测试放在 `test/`，不和源码放一起 —— `tsconfig.build.json` 编译 `src/**`，测试放进 src 会进 dist 和发布包
- 显式 `import { describe, it, expect } from 'vitest'`，不开 globals —— tsconfig `types: ["node"]` 不用改
- **旧检查一条对应一个 `it`，测试名用旧 label 原文**；场景用"`beforeAll` 里执行动作并记录观察值，`it` 里断言"的写法。这样运行时的测试名清单就能和基线 PASS 清单逐条比对，证明没有丢检查。只有 label 依赖运行时数据、收集阶段无法生成的检查，才用 `expect.soft(…, label)`，并登记在例外清单里
- `integration` 项目串行跑文件 —— supervisor 对时序敏感，server-log 要测事件循环卡顿，原来的 smoke 也是串行的
- 探针（D 类）不纳入测试框架 —— 它们的产出是测量数据和退出码 2（"残留见证"），不是 pass/fail 回归
- `smoke:pty`（`pty-rwr-smoke.ts` + `src/smoke/`）删除，不保留（用户选定，2026-10-10）
- `test/helpers/` 不在 CP1 预建，迁移时按实际需要创建（不写无使用者的抽象；CP1 Conformance 认可，2026-10-10）
- unit 和 integration 两个 project 用 `sequence.groupOrder` 先后跑 —— Vitest 的 project 之间默认并发，`fileParallelism: false` 只管 project 内部（CP1 Diff Review，2026-10-10）
- 不测 `describeListenError`、不测 `src/index.ts` 里闸门的接线 —— 前者不是闸门；后者由 `smoke-release`（B 类，CI 中）覆盖，记为剩余风险

## Acceptance

- 成功路径：
  - `npm test` 本机（macOS）exit 0；CI 三平台（ubuntu / macos / windows）的 `npm test` 步骤全绿
  - 运行时清单：Vitest JSON reporter 的测试名清单 ⊇ 基线 PASS label 清单（去掉 ` — detail` 后缀，按多重集比较），缺失为 0；例外（`expect.soft`）逐条列出，并经审查确认
  - 变异测试：每个迁移文件准备一个临时的产品代码变异，旧脚本（删除前）和新测试都必须失败；撤销变异后新测试通过
  - `npm run typecheck` 覆盖 `test/**` 和 `vitest.config.ts`
  - `npm run build:server` 产出的 `dist/` 里没有 `smoke/`，也没有测试文件
- 失败/边界路径：
  - supervisor 测试失败或超时后，不能残留假子进程或孙进程（用 marker 检查 `ps`）
  - 测试只用临时目录，结束后清理；不读写仓库里的 `config/`、`logs/`
  - Windows 上原来跳过的用例（signal stop timeout）继续用 `skipIf` 跳过，不能变成失败或被删除
- 不允许发生：
  - 删掉或放宽任何检查条件（时间阈值、状态断言、401 矩阵）却不在 Decisions 里说明
  - `src/` 产品逻辑出现 diff
  - CI 的 test 步骤 `timeout-minutes` 超过旧四步之和（14）

## Evidence

- 自动检查：`npm run typecheck`；`npm test`；`npx vitest run --reporter=json --outputFile=<scratch>/vitest.json` + 清单比对脚本（scratchpad）；`npm run build:server && find dist -path '*smoke*' -o -name '*.test.*'`
- 变异：每个 checkpoint 记录"变异内容 → 旧 exit / 新 exit"
- 跨平台：push 后看 CI 三平台日志（push 前单独征求授权）
- 人工检查：CLAUDE.md diff 由用户确认；可选：用户在 Windows 上 `npm run build:server && npm run smoke:pty-cleanup`，验证探针移动后路径正确
- 高风险 diff：无（中风险；会请用户阅读 `vitest.config.ts` 和 `release.yml` 的 diff）

## Checkpoints

- [x] 1. 基建 + 单元测试：装 vitest，写 config / tsconfig / npm scripts；`bind-host`、`isWeaklyProtected` 单测；确认 `.js` → `.ts` 解析、forks 池、项目级串行配置可用
      证据：typecheck ✓；`npm test` → 2 files / 54 passed；临时探针（已删）：两个 integration 文件各用 node-pty spawn 子进程 → 通过、pid 不同、时间不重叠；变异（单测无旧脚本对应）：`isLoopbackHost` 接受 0.0.0.0 → 3 fail，去掉 `toLowerCase` → 1 fail，"token 挽救弱密码" → 3 fail；`npm audit` 告警集合与安装前相同。审查：Diff Review（project 间会并发 → 加 `sequence.groupOrder`；补 auth 组合）、Conformance（补组合；无确认缺陷） ｜ commit：见 git log
- [ ] 2. 迁移 auth + templates（都是 `createHttpServer` + `inject`）；清单比对 + 变异；删除旧脚本
      证据： ｜ commit：
- [ ] 3. 迁移 server-log（索引 + 路由 + 1M 行性能阈值）；清单比对 + 变异；删除旧脚本
      证据： ｜ commit：
- [ ] 4. 迁移 supervisor（node-pty、假子进程、时序、残留进程清理）；清单比对 + 变异 + 失败后无残留；删除旧脚本
      证据： ｜ commit：
- [ ] 5. 清理：删除 E 类，D 类移到 `scripts/diagnostics/` 并修正路径
      证据： ｜ commit：
- [ ] 6. CI + CLAUDE.md：`release.yml` 合并为 `npm test`；CLAUDE.md diff 经用户确认；push（需授权）后 CI 三平台全绿
      证据： ｜ commit：

## Baseline（main @ d9f97f4，macOS，Node 24.15.0）

| smoke | PASS | 耗时 |
| --- | --- | --- |
| auth | 277 | 10s |
| templates | 52 | 1s |
| server-log | 131 | 3s |
| supervisor | 131 | 38s |

## Pitfalls

（出现时追加）

## Sources

- 旧脚本：`scripts/smoke-{auth,templates,server-log,supervisor}.ts`
- CI：`.github/workflows/release.yml`
- 被测：`src/app/bind-host.ts`、`src/api/http/auth.ts`（模块加载时读取环境变量）、`src/api/http/http-server.ts`、`src/core/log/line-index.ts`、`src/core/instance/instance-supervisor.ts`
- Vitest 5 文档（Context7 `/vitest-dev/vitest/v5.0.3`）：projects、`pool: 'forks'`（原生模块）、migration（v5 要求 Node ≥22.12、Vite ≥6.4）
