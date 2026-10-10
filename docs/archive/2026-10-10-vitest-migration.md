# 引入 Vitest，替换 CI 中的 smoke 脚本

- 日期：2026-10-10
- 风险：中（改 CI、npm scripts、新增 devDependency；主要风险是迁移中静默丢检查）
- Commits：`bc9bf20`..`12d2449`（分支 `test/vitest-migration`）
- 相关 ADR：无

## 结果
`npm test`（Vitest 5.0.3）取代了 `smoke:auth`、`smoke:templates`、`smoke:server-log`、`smoke:supervisor`，CI 的四个步骤合并为一个 Test 步骤（timeout 10 分钟，原来四步合计 14 分钟）。旧的 591 条检查逐条成为同名测试；另外新增 54 条绑定闸门单测，加上 supervisor 的 240 s 总时限，共 646 条。本机运行约 50 s（旧四个 smoke 合计约 52 s）。`smoke:pty`、`verify-step-2-2.ts`、`src/smoke/` 已删除（`src/smoke/` 之前会编进 dist 和发布包）；四个 Windows PTY 探针移到 `scripts/diagnostics/`，npm script 名称不变。

迁移的证据：
- **运行时清单**：Vitest JSON 报告里的测试名与旧日志的 PASS label 按多重集比对，四个文件缺失都是 0。
- **变异测试**：每个文件改坏一处产品代码，新旧两边失败的条目相同（supervisor 例外，见规范）。
- **清理**：supervisor 在失败、超时、变异下运行后，都没有残留进程和临时目录。

CI 三平台（ubuntu / macOS / Windows）全绿，详见"剩余风险"。

## 关键决策
| 决策 | 原因 | 否决方案及原因 |
| --- | --- | --- |
| Vitest 5 | 支持 Node 24 和 Vite 8，TS/ESM 不用额外配置；projects 可以分组；前端以后也能用 | `node:test` + tsx：项目用 `.js` 后缀导入 `.ts`，Node 自带的类型剥离解析不了，仍要挂 tsx，而且没有分组和前端方案；Jest：ESM + NodeNext 配置成本高 |
| 测试放在 `test/`，不和源码放一起 | `tsconfig.build.json` 会编译 `src/**`，测试放进去会进 dist 和发布包 | 和源码放一起 |
| `unit` / `integration` 两个 project，integration 按文件串行，并通过 `sequence.groupOrder` 排在 unit 之后 | supervisor 测试对时序敏感，line index 要测事件循环卡顿；`fileParallelism: false` 只管 project 内部，project 之间默认并发 | 全部并行 |
| 旧检查一条对应一个同名 `it` | 运行时清单可以和基线逐条比对，证明没有丢检查 | 每个场景一个 `it`、里面用 `expect.soft`：只能证明场景数，证明不了检查数 |
| auth / templates / server-log 用"步骤式"；supervisor 用"记录后断言"（场景函数原样保留） | supervisor 的观察值依赖时序，旧场景代码原样搬过来，取值时机就和以前完全一样 | 把 supervisor 改写成 matcher 风格：很容易悄悄改变观察的时机 |
| CI 在第一个迁移的 checkpoint 就改，每迁移一个文件删一个旧步骤 | 每个提交里 CI 引用的脚本都存在 | 等全部迁完再统一改 CI：中间提交的 CI 会调用已删除的脚本 |
| server-log 中 rename 身份检测那条检查做了加强 | 旧检查恒真：去掉 dev/ino 比较后新旧都全过（已用实验证实） | 1:1 照搬 |
| "large: reading at the end is fast (< 100 ms)" 改为连读 3 次取最小值，阈值不变 | Windows CI 上单次读一次测得 207 ms（原因不明，随后一次读 1 ms，重跑通过），旧 smoke 在 Windows 上约 1 ms | 保持单次计时：CI 会偶发变红；放宽阈值：本来就抓不到读取退化 |
| 保留 supervisor 的 240 s 总时限，写成一条测试 | 旧脚本有这个失败条件；写在 afterAll 里抛错会跳过删除临时目录的 hook | 只靠每个场景的 hook 超时：等于放宽了 |

## 确立的规范
- 测试的写法约定（helpers、收集阶段不做有副作用的事、afterAll 不抛错、整文件运行、supervisor 的写法、诊断探针的位置）已写入 CLAUDE.md 的 Tests 小节。
- 迁移或重写检查时：`JSON.stringify(a) === JSON.stringify(b)` 要保持逐字节比较。`toEqual` 会忽略键顺序和 `undefined` 键，只有比较字符串数组或数字数组时才等价。
- 迁移的证据要齐三样：运行时清单比对、新旧对照变异、逐条审查断言。清单只比标题，查不出放宽了的断言。
- supervisor 的变异判定标准：旧失败 ⊆ 新失败，多出来的必须都是 "not reached"（旧脚本提前 return 之后不再运行的检查）。

## Pitfalls
- **`-t` 把整个文件过滤掉时，Vitest 不执行任何 hook，fork 退出时也不触发 `exit` 事件**：在收集阶段创建的临时目录会残留。所以要在 `beforeAll` 里懒创建。
- **afterAll 抛错会跳过其后的 afterAll**：做总时限判定的 hook 抛错之后，删除临时目录的 hook 就没执行。
- **清理 hook 先 await `dispose()` 再杀进程**：顽固子进程的 stopTimeoutMs 是 60 s，hook 在 30 s 时超时，排在 await 之后的杀进程代码根本没跑到。要先杀残留进程，再有上限地等待。
- **Write 工具会把字符串里的 `\uXXXX` 写成原字符**（BOM、U+FFFD）：写完含转义的测试后，统计新旧文件里 `\r`、`\n`、`\u` 的数量，并扫描原始字节。
- **1:1 迁移会把旧脚本的空检查一起搬过来**：对于"只有 X 才能分辨"的检查，要专门做一个关掉 X 的变异来验证。

## 剩余风险 / 后续
- **CI 三平台**：
  - `84d00a6` 第一次运行：Windows 上只有 "reading at the end is fast" 失败（207 ms），只重跑 Windows job 后三平台全绿。Test 步骤耗时：ubuntu 49 s、macOS 54 s、Windows 106 s。Windows 上 supervisor 132 条，10 条按预期跳过，耗时 85 s。
  - `12d2449`（连读 3 次取最小值）：第一次运行三平台全绿。Test 步骤：ubuntu 50 s、macOS 49 s、Windows 94 s；三次读取耗时 Windows 0.7/0.7/0.6 ms，macOS 1.0/1.4/8.8 ms，ubuntu 0.9/0.8/0.5 ms。
  - 计时检查的残余风险：三次读取都慢时仍会失败。
- **supervisor 的观察盲点（继承自旧脚本）**：stop/dispose 场景的 "never reported running/crashed" 只能观察 `notifyStatus`。不发通知的状态回写看不到；"onData 写回 running"这类变异只有 restart / force stop / cancelled 场景能抓到。
- **`src/index.ts` 里闸门的接线**（`resolveBindHost(process.env.HOST, isWeaklyProtected)`）只有 `smoke:release` 覆盖，而它要先打包；`npm test` 只覆盖两个函数本身。
- **Windows 上的余量未知**：每个场景 60 s（restart policies 120 s）、事件循环卡顿 200 ms 的阈值在 forks worker 里运行、临时目录删除改为重试后报错。这些只能看 CI。
- **Windows PTY 探针移动后没有在 Windows 上实跑**，只做了静态解析验证。
- **`tsc` 不清理 dist**：在旧工作区直接 `npm run package`，可能把过期文件（例如以前构建的 `dist/smoke/`）打进包。CI 是全新 checkout，不受影响。
- **依赖安全**：安装前就已有 8 条 npm audit 告警（fastify、@fastify/static、find-my-way、ws、fast-uri 等，其中 6 条 high），vitest 没有新增告警，本任务没有处理。
- **后续任务**：
  - B 类（`smoke-restart-policy`、`smoke-release`）迁入 Vitest 的 e2e project；
  - C 类浏览器 smoke 改用 Playwright Test（使用系统 Chrome）；
  - 前端单测（jsdom）。
- 以上已记入 [backlog](../backlog.md)。

## 指针
- `vitest.config.ts`；`test/unit/`（`bind-host.test.ts`、`auth-protection.test.ts`）；`test/integration/`（`auth`、`templates`、`server-log`、`supervisor`）；`test/helpers/`（`api-server.ts`、`temp-dir.ts`）
- `.github/workflows/release.yml`（Test 步骤）；`scripts/diagnostics/`
- 被替换的旧脚本见 `bc9bf20` 之前的 `scripts/smoke-*.ts`（`git show d9f97f4:scripts/smoke-supervisor.ts`）
