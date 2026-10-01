# Windows PTY 退出后的输入资源释放

- Risk: 中。修改进程适配边界，失败可能在多轮后出现；本地易回退，真实 RWR 和三平台仍待外部验证。
- Commit policy: confirm。用户 2026-10-01 要求后续任务由 agent 提交，提交前由用户确认；无 push/发布/部署授权。
- Baseline: main / HEAD `7fd667461a08ef7b6bb861a8412e0672f7dcf402`，既有未提交工作全部保留，用户 `.zcodeignore` 不触碰。本轮前内容 `.cache/pty-cleanup-baseline/`，此前调查 `.cache/pty-lifecycle-observation-evidence.json`。
- 规则：中文、CodeGraph 结构探索、dev-loop；不读 CLAUDE.md、不改项目规则。

## Goal / Scope / Acceptance
- 修复已复现的 Windows ConPTY 自然退出后输入 Socket 保留，兼容逻辑仅在 PTY 适配层，supervisor 不访问依赖私有字段。
- 精确约束 node-pty 1.2.0-beta.12；在 Windows spawn 前核对版本和创建/暴露输入 Socket 的精确实现指纹，不让依赖升级或私有布局变化静默破坏兼容。非 Windows 无私有字段依赖。
- 在真实 PTY exit 后销毁输入 Socket；退出前保持写入和输出冲刷语义，不提前结束输出；清理幂等，公开退出仅通知一次，原退出码不变。
- 退出后写入/resize/kill 不再触达旧资源，重复 stop/dispose 不影响新代实例。仅在退出清理阶段容忍明确的 pipe 已关闭错误；活动期间及其他异常不得吞掉，不加全局异常 handler。
- 真实 Windows 生命周期对照/压力各 8 轮，同 supervisor、WeakRef+GC、父级 OS HandleCount，最终 active input Socket 和 queued bytes 均 0；不能通过弱化此前观察断言制造通过。
- 验证正常 exit0、异常 exit1、强杀、重复 stop/dispose、退出后直接写/resize/kill，以及 active/unexpected input error 保持非零失败；正常回显和末尾输出不能丢失。
- 构建/typecheck、相关 supervisor 与 HTTP/WS 回归、独立 Diff/Conformance Review；假服务器/用户配置隔离，清理验证，无真实 RWR/外部写入。

## Checkpoints
- [x] 契约与候选，精确依赖、本地检查和生命周期回归。
- [x] 失败/强杀/幂等回归，冻结与独立双审。
- [x] 审查关闭、归档、列出待确认提交范围；未获确认不 commit。

## Decisions
- 当前官方仓库仍存在同样清理路径，上游 issue #947 与本机观察相符；不盲目升级 beta 或改 ConPTY DLL 模式。采用精确版本、实现指纹校验的局部兼容，未来上游修复时移除。
- 只在真实退出后丢弃输入待写队列，此时目标进程已退出；保持输出由原依赖冲刷并通知退出，不用 kill 来替代资源清理。
- 回滚为恢复本轮前 adapter、npm manifest/lock 与测试入口内容，不撤销前轮重启策略成果。
- 上游依据：[官方 issue #947](https://github.com/microsoft/node-pty/issues/947)、[当前官方源码](https://github.com/microsoft/node-pty/blob/main/src/windowsPtyAgent.ts)。依赖公共 IPty kill/destroy 无法在当前非 DLL 路径关闭输入，故不以 kill 替代退出清理。
- 原生命周期脚本未改。修复后两组 8 轮输入资源均释放，但 Windows 总句柄仍增长，本轮验收不等同消除全部资源泄漏；另外定位记入 backlog，不隐瞒该观察。

## Evidence / Freeze
- `& ./.cache/validation-runtime/node.exe node_modules/typescript/bin/tsc --noEmit`、`& ./.cache/validation-runtime/node.exe node_modules/typescript/bin/tsc -p tsconfig.build.json`，均退出 0。
- 原探针：`& ./.cache/validation-runtime/node.exe scripts/smoke-pty-lifecycle.mjs *> .cache/pty-cleanup-lifecycle.log`，退出 0；之后 `Copy-Item -LiteralPath .cache/pty-lifecycle-evidence.json -Destination .cache/pty-cleanup-lifecycle-evidence.json` 保存证据；前轮冻结证据未覆盖。
- 新契约：`& ./.cache/validation-runtime/node.exe scripts/smoke-pty-cleanup.mjs *> .cache/pty-cleanup-contract.log`，退出 0，7 项 PASS；两项预期错误 worker 退出 1 并包含指定异常，非吞掉错误后的假通过。证据 `.cache/pty-cleanup-contract-evidence.json`。
- 正常/异常退出末尾 FINAL_OUTPUT 已验证，重复底层 exit 不重复公开通知、退出后写/resize/kill 不触达旧 Socket；强杀后 Socket 不再属于 active handles 且 queued bytes=0。
- 本轮变更：adapter、package manifest/lock（精确依赖和新命令）、新增 scripts/smoke-pty-cleanup.mjs、README 双语、backlog、TASK/归档；原生命周期探针及其前轮冻结证据不变。生产 supervisor 无本轮改动。
- `& ./.cache/validation-runtime/node.exe node_modules/tsx/dist/cli.mjs scripts/smoke-supervisor.ts *> .cache/pty-cleanup-supervisor.log`，退出 0，所有状态机检查通过，覆盖重复 stop/dispose 和取消重启。
- `& ./.cache/validation-runtime/node.exe scripts/smoke-restart-policy.mjs *> .cache/pty-cleanup-e2e.log`，退出 0，51 项 HTTP/WS/真实 PTY 回归通过，用户配置指纹未变。
- `& ./.cache/validation-runtime/node.exe --check scripts/smoke-pty-cleanup.mjs` 退出 0；`git diff --check` 首次发现 lockfile 混合行尾，经 LF 规范化仅剩预期 1 行依赖差异，最终退出 0。
- 修订后的最终生命周期两组均 active inputs=0、queued bytes=0，但总 OS 句柄 194→311，其他句柄风险未关闭。原始生命周期脚本与基准备份相同。
- 当前冻结并开始独立双审。未获用户提交确认，不 stage/commit/push。

## Review round 1 / 修正
- Diff Review P2 confirmed：真实 spawn 后才拒绝 Socket 形状，仅调用延迟 public kill，可能留下无输出子进程/资源；假的 shape 对象只验证调用不能证明清理。
- 修正为在 spawn 前验证 WindowsPtyAgent/WindowsTerminal 两个确切包文件 SHA256（锁版本对应实现）；此实现确定创建并暴露真实 net.Socket。不再生成真实 PTY 后拒绝私有布局，也不依赖失败后的 public kill 清理。
- Acceptance 的兼容拒绝由事后形状检查加强为事前实现指纹检查，用户目标和行为未变；修改安装包（即使版本号不变）也需先重新验证兼容。
- shape 负测只在 worker 内替换 artifact 读取内容、不改依赖文件，断言拒绝前真实 spawn 调用为 0；新增旧对象 resize/native kill/taskkill 计数断言。
- 审查结束后修正，完整回归和双补审均完成，首轮 P2 confirmed defect 已 fixed。
- 修订后 typecheck/server build/syntax/diff 均退出 0；新契约 7 项仍退出 0，兼容拒绝真实 spawn=0；原生命周期仍退出 0，输入/队列均 0、OS 总句柄 194→311。最终 supervisor/HTTP+WS 回归按原命令执行，退出 0，全部状态机与 51 项 E2E 通过。

## Closure / 提交准备
- 新上下文 `pty_cleanup_diff_review`、`pty_cleanup_conformance_review` 和修订补审均完成；P2 失败清理缺口 fixed，文档旧措辞/旧句柄值已统一。补审后仅更新任务/归档文字，受验收影响的源码、脚本、依赖不再修改。
- Goal 完成是输入 Socket 释放候选，其他 OS 句柄增长为已明确范围外剩余任务，真实 RWR 与三平台未验证。本次无需更新项目规则，TASK 保留。
- 提交策略 confirm；未获确认不提交。独立提交提案为 adapter、package.json（仅本轮精确依赖和 smoke:pty-cleanup 命令）、package-lock.json、新契约脚本、README 双语（仅本轮兼容说明）、backlog（仅本轮 Windows 风险更新）、本 TASK、归档，共 9 文件。
- 提案使用 `.cache/pty-cleanup-proposal/index` 临时 Git index，不触碰真实暂存区；基于 HEAD 加本轮变更，保留前轮修改归属。完整差异 `.cache/pty-cleanup-proposed-commit.patch`。计划标题 `fix: release Windows PTY input sockets after exit`。
- 最终基准 HEAD `7fd667461a08ef7b6bb861a8412e0672f7dcf402`，无 commit/push/发布/部署。
- 独立提交材料补审通过：9 文件归属清晰、没有前轮改动或遗漏运行依赖。独立 HEAD 归档副本仅叠加该 9 文件，`& ./.cache/validation-runtime/node.exe node_modules/typescript/bin/tsc -p .cache/pty-cleanup-proposal-validation/tsconfig.build.json` 与 `& ./.cache/validation-runtime/node.exe .cache/pty-cleanup-proposal-validation/scripts/smoke-pty-cleanup.mjs` 均退出 0，7 项 PASS；日志 `.cache/pty-cleanup-proposal-validation.log`。目前仅待用户确认实际提交。
