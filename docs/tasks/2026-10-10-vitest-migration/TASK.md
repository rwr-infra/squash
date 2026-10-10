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
- **旧检查一条对应一个 `it`，测试名用旧 label 原文**。两种写法：确定性的流程（auth、templates、server-log）用"步骤式"——it 依次执行、每步先动作后断言、共享前面步骤的状态；时序敏感的 supervisor 用"记录后断言"——场景在 `beforeAll` 里原样运行并记录每条检查的结果，每个 it 断言一条记录（CP2 Conformance 指出原写法只描述了后者，2026-10-10）。这样运行时的测试名清单就能和基线 PASS 清单逐条比对，证明没有丢检查。只有 label 依赖运行时数据、收集阶段无法生成的检查，才用 `expect.soft(…, label)`，并登记在例外清单里
- `integration` 项目串行跑文件 —— supervisor 对时序敏感，server-log 要测事件循环卡顿，原来的 smoke 也是串行的
- 探针（D 类）不纳入测试框架 —— 它们的产出是测量数据和退出码 2（"残留见证"），不是 pass/fail 回归
- `smoke:pty`（`pty-rwr-smoke.ts` + `src/smoke/`）删除，不保留（用户选定，2026-10-10）
- `test/helpers/` 不在 CP1 预建，迁移时按实际需要创建（不写无使用者的抽象；CP1 Conformance 认可，2026-10-10）
- unit 和 integration 两个 project 用 `sequence.groupOrder` 先后跑 —— Vitest 的 project 之间默认并发，`fileParallelism: false` 只管 project 内部（CP1 Diff Review，2026-10-10）
- CI 在 CP2 就加 `npm test` 步骤（timeout 10），每迁移一个文件就删掉对应的旧步骤，而不是等到 CP6 —— 每个提交里 CI 引用的脚本都存在（CP2，2026-10-10）
- 步骤式测试（一个场景内的 it 依次执行、共享状态）只能整文件运行，`-t` 单跑一步会因缺少前置状态而失败；在文件头注明。旧脚本本来就不能单跑，不算回归（CP2 Diff Review，2026-10-10）
- 收集阶段（describe 回调体）不做有副作用的事：临时目录在 `beforeAll` 里懒创建（`useTempDir` 返回 getter），server 在 `beforeAll` 里创建（`createApiServer`）。原因：`-t` 把整个文件过滤掉时 Vitest 不执行任何 hook，fork 退出时也不触发 `exit` 事件，收集阶段建的目录会残留（已复现）（CP2，2026-10-10）
- 迁移时 `JSON.stringify(a) === JSON.stringify(b)` 的检查保持逐字节比较，不改成 `toEqual`（后者忽略键顺序和 `undefined` 键，属于放宽）；字符串/数字数组之间的比较改成 `toEqual` 等价（CP2 Diff Review，2026-10-10）
- "a new file with the old content as its start is a new generation" 改为与 rename 前的 generation 比较（同时保留旧的比较）：旧脚本比较的是更早的 generation，前面的 header 步骤已换过，检查恒真，去掉 dev/ino 比较后新旧都全过（已实验证实）。属于加强，不是放宽（CP3 Conformance，2026-10-10）
- 1M 行块用"记录后断言"（`beforeAll` 里计时，it 里断言），与步骤式并存；文件头注明（CP3 Conformance，2026-10-10）
- supervisor 的"记录后断言"细则：label 预先声明且全文件唯一；检查按 label 记到声明它的场景（超时后晚到的检查不会串到下一个场景）；声明了但没运行的 label 以 "not reached" 失败——所以变异下新测试的失败数可以多于旧脚本（多出的只能是 not reached），判定"旧失败 ⊆ 新失败、其余皆 not reached"；未声明、声明为 skip 却被记录、同一 label 记录两次，都让场景失败。这种写法下 `-t` 单跑一条也会运行整个场景（CP4，2026-10-10）
- 旧脚本的全局 240 s 失败时限保留为文件末尾的一条测试（"the scenarios finish within 240 s"），另加每个场景 beforeAll 的超时（默认 60 s，restart policies 120 s）防挂起；不放在 afterAll 里抛错，因为 afterAll 抛错会跳过其后的 hook（临时目录就没删，已复现）（CP4 Conformance，2026-10-10）
- 清理顺序：开始清理即禁止新建 harness → 强制停止未结束的 supervisor → 杀残留 PID → `dispose()` 最多等 10 s → 再杀一次 → 删临时目录（删除重试 10 次，失败则报错，不再像旧脚本那样静默忽略）；进程正常退出时再兜底杀一次残留（CP4，2026-10-10）
- "large: reading at the end is fast (< 100 ms)" 改为连读 3 次取最小值，阈值不变，每次耗时打进日志：Windows CI 上单次读一次测得 207 ms（原因不明，随后一次读 1 ms，重跑通过），旧 smoke 在 Windows 上测得约 1 ms。这是对单次计时的放宽；残余风险：三次都慢仍会失败。这条检查（新旧一样）抓不到读取退化（Mac 上从头扫描约 65 ms），已记入 backlog（用户选定，2026-10-10）
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
- [x] 2. 迁移 auth + templates（都是 `createHttpServer` + `inject`）；清单比对 + 变异；删除旧脚本
      证据（最终版本）：typecheck ✓；`npm test` → 4 files / 383 passed；清单 auth 277/277、templates 52/52，缺失 0，例外（`expect.soft`）无；变异"按原始 URL 判断鉴权" → 旧 exit 1（119 FAIL）/ 新 119 failed；变异"`[]` 当作文件缺失" → 旧/新失败同样 2 条；撤销后 329 passed；`-t` 全过滤与单步运行后无临时目录残留。CI：`npm test` 步骤替换 auth/templates 两步。审查：Diff Review（`toEqual` 放宽 2 处 → 改回逐字节；收集阶段副作用 → `beforeAll` + `createApiServer`）、Conformance（无确认缺陷；BOM 改回转义；`-t` 注释改正） ｜ commit：见 git log
- [x] 3. 迁移 server-log（索引 + 路由 + 1M 行性能阈值）；清单比对 + 变异；删除旧脚本
      证据（最终版本）：typecheck ✓；`npm test` → 5 files / 514 passed；清单 131/131，缺失 0，例外无；1M 行信息行与基线相同（31 ms / 0 ms 卡顿）；变异"指纹只比尾部" → 旧/新失败集合相同（2）；"不去掉行尾 \r" → 相同（15）；"不比较 dev/ino" → 旧 0 失败、新 2 失败（见 Decisions：加强一条空检查）；`-t` 全过滤后无残留。CI 删 server-log 步骤。审查：Diff Review（注释不准、计数失败后不读 ranges）、Conformance（继承的空检查、上游失败导致下游空过 → 先赋值后断言、`readMs` 初值 NaN） ｜ commit：见 git log
- [x] 4. 迁移 supervisor（node-pty、假子进程、时序、残留进程清理）；清单比对 + 变异 + 失败后无残留；删除旧脚本
      证据（最终版本）：typecheck ✓；`npm test` → 6 files / 646 passed，50 s（基线四个 smoke 合计约 52 s）；清单 131/131 + 1 条新增（240 s 总时限）；场景函数体与旧脚本 diff 只有 `workRoot()`、`supervisors.add`、`closing` 守卫三处；变异"`onData` 写回 running" → 旧 exit 1（7 FAIL）/ 新 28 失败 = 旧 7 条 + 21 条 "not reached"（旧脚本提前 return 后不运行的检查）；"`start()` 不查 disposed" → 新旧同 1 条；以上变异与正常运行、`-t` 全过滤后：`pgrep -f 'child ready'` 与孙进程 marker 均 0，无临时目录；超时实验（restart policies 超时设 1 s）：只有该场景 17 条失败，其余 114 条通过，无残留；总时限实验（上限设 100 ms）：该测试失败、无残留。CI 删 supervisor 步骤。审查：Diff Review（exit 兜底、晚到检查串场景、定时器）、Conformance（240 s 时限被删 → 恢复为测试；"not reached" 语义登记；清理先杀后等） ｜ commit：见 git log
- [x] 5. 清理：删除 E 类，D 类移到 `scripts/diagnostics/` 并修正路径
      证据：四个探针各改 2 处（root 上两级、`../../dist`），`node --check` ✓；静态解析验证（`rm -rf dist && npm run build:server` 后按各文件位置计算：root = 仓库根，`../../dist/…` 目标存在，`node-pty` 解析到仓库 node_modules）✓；macOS 上运行只到平台断言（不执行改动行，仅证明语法与内置 import）；Windows 实跑未做；`find dist -path '*smoke*' -o -name '*.test.*'` → 0；分支相对 main 在 `src/` 只有 `src/smoke/` 4 个删除；typecheck ✓、`npm test` 646 passed；README/backlog 只引用 npm script 名（未变）。审查：Diff Review（暂存提醒）、Conformance（无确认缺陷；`tsc` 不清理 dist 的打包风险记入剩余风险） ｜ commit：见 git log
- [ ] 6. CLAUDE.md + 跨平台：CLAUDE.md diff 经用户确认（CP2–CP5 期间 CLAUDE.md 仍指向已删除的 smoke 脚本）；用户阅读 `vitest.config.ts` 与 `release.yml` 的 diff；push（需授权）后 CI 三平台全绿。CI 改动本身已随 CP2–CP4 逐步完成
      证据： ｜ commit：

## Baseline（main @ d9f97f4，macOS，Node 24.15.0）

| smoke | PASS | 耗时 |
| --- | --- | --- |
| auth | 277 | 10s |
| templates | 52 | 1s |
| server-log | 131 | 3s |
| supervisor | 131 | 38s |

## Pitfalls

### Pitfall: Write 工具把字符串里的 \uXXXX 写成了原字符
- 现象：templates 的 `'\uFEFF…'`、server-log 的 `'\uFFFD\uFFFDA'` 落盘后变成不可见的原字符（CP2 Conformance 发现 BOM）
- 状态：CONFIRMED
- 原因：经 Write 工具写入的内容里，`\u` 转义被解码
- 已否决：依赖编辑器显示来检查（看不见）
- 来源：`perl -ne 'print if /\x{EF}\x{BB}\x{BF}|\x{EF}\x{BF}\x{BD}/'`
- 下一步：写含 \u 转义的测试后，统计新旧文件里 `\r`、`\n`、`\u` 的数量并扫描原始字节

### Pitfall: Vitest 的 afterAll 抛错会跳过其后的 afterAll
- 现象：在清理 hook 里做总时限判定并抛错后，临时目录没被删除
- 状态：CONFIRMED（CP4 实验）
- 下一步：判定写成 it，hook 只做清理且不抛错

### Pitfall: 1:1 迁移会把旧脚本的空检查一起搬过来
- 现象：标签对得上、变异也对得上，但某条检查恒真（server-log 的 rename 身份检测）
- 状态：CONFIRMED
- 原因：清单比对只比标题，变异只覆盖挑选的路径
- 下一步：对"只有 X 才能分辨"的检查，专门做一个关掉 X 的变异

## Sources

- 旧脚本：`scripts/smoke-{auth,templates,server-log,supervisor}.ts`
- CI：`.github/workflows/release.yml`
- 被测：`src/app/bind-host.ts`、`src/api/http/auth.ts`（模块加载时读取环境变量）、`src/api/http/http-server.ts`、`src/core/log/line-index.ts`、`src/core/instance/instance-supervisor.ts`
- Vitest 5 文档（Context7 `/vitest-dev/vitest/v5.0.3`）：projects、`pool: 'forks'`（原生模块）、migration（v5 要求 Node ≥22.12、Vite ≥6.4）
