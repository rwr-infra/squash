# `smoke:supervisor` 接入 CI 三平台（含仓库收尾清理）

- 日期：2026-09-30
- 风险：低-中（改 CI = 改变"检查"本身的含义；tag 推送时会阻断发布）
- Commits：a0fed08（`.gitignore`）、f717cf9（workflow），分支 `ci/smoke-supervisor`
- 相关 ADR：无

## 结果
`release.yml` 的 `package` job 在 `Typecheck` 之后、`Package` 之前跑 `npm run smoke:supervisor`（`timeout-minutes: 5`），ubuntu / macos / windows 每次 push（含 `v*` tag）都跑；失败即 job 红、跳过打包，`release` job 因 `needs: package` 被阻断。脚本无需修改即三平台通过。

同批完成的收尾清理（无长期规则，不单独归档）：删除 `dist-bin/`（pkg 实验产物）；`test-instances.json` 保留并 ignore；恢复 `frontend/.env.local`；关闭 PR #1（被 #2 / ADR 0001 取代，`4d3be41` 可经 `refs/pull/1/head` 找回）；删除远端与本地 `feature/bundled-runtime`、`feature/pkg`。

## 关键决策
| 决策 | 原因 | 否决方案及原因 |
| --- | --- | --- |
| 放进现有 `package` job，而非新 job/新 workflow | 复用 checkout / setup-node / `npm ci`（含 dev 依赖 `tsx` 与原生 node-pty） | 新 job：重复装依赖，多一份维护 |
| 放在 `Package` 之前 | 状态机回归几秒内暴露，不白跑 20 分钟打包 | 放在 `smoke:release` 旁：失败太晚 |
| 变异验证在一次性分支 `ci/smoke-mutation` 上做，出结果后删分支 | PR 历史不留变异/revert commit，证明力相同 | 本分支推变异再 revert：历史噪音；只用本地变异：看不到 CI 真的拦截（用户选定） |

## 确立的规范
- 改 CI 检查前后都要有"会红"的证据：临时变异推到一次性分支，确认目标 job 失败且后续步骤被 skip，再删分支。
- 从 `origin/main` 切分支后 `git branch --unset-upstream`，首次 `git push -u origin <branch>` 再建立跟踪，避免误推到 `main`。

## Pitfalls
- **Windows 上 supervisor 冒烟覆盖不到"停服期间有输出"**：`kill()` = `taskkill /T /F`，停服无输出（状态 `stopping → stopped`），把 `onData` 改回写 `running` 的变异在 Windows 仍绿、只有 POSIX 变红。Windows 一旦有优雅停服（stop-escalation 任务的 `stopCommand`），必须补 Windows 用例。
- `gh run view --log` 在 run 未结束时拿不到已完成 job 的日志；用 `gh api --allow-escape-sequences repos/<o>/<r>/actions/jobs/<job-id>/logs`（不加该参数会因 ANSI 转义被拒绝输出）。
- zsh 把 `===`/`====` 当 `=cmd` 展开（`=== not found`），echo 分隔线别用等号开头。

## 剩余风险 / 后续
- 见上 Windows 覆盖缺口 → 已写入 `docs/tasks/2026-09-30-stop-escalation/TASK.md` Pitfalls。
- CI 只在 `push` 触发，无 `pull_request`：fork 来的 PR 不会跑检查（当前仓库无外部贡献者，暂不处理）。

## 指针
- `.github/workflows/release.yml`（`package` job，`Smoke-test the supervisor state machine` 步骤）
- `scripts/smoke-supervisor.ts`；前序 `docs/archive/2026-09-30-stop-marked-crashed.md`（其"未进 CI、只在 darwin 验证"的剩余风险由本任务关闭）
- CI 证据：run `36673358486`（绿）、`36673606111`（变异，红）
