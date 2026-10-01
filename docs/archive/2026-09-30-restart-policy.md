# 实例重启策略

- 日期：2026-09-30
- 风险：中
- Commit policy：none；HEAD `7fd667461a08ef7b6bb861a8412e0672f7dcf402`，全部本任务变更未提交。
- 用户授权：按推荐方案本地实现、建立 CodeGraph 索引并验证；未部署、未修改用户实例配置、未启动实际 RWR。

## 结果
实例可选择禁用、失败时重启、维持运行。维持运行模式恢复自主退出码为 0 的进程，解决仅依赖失败退出码时的恢复缺口；Stop 随时取消恢复。页面显示恢复时间、退出码/信号或暂停原因。

## 关键决定
- `restartPolicy`：`never` / `on-failure` / `always`。显式策略优先；未设置时沿用 `autoRestart` true → on-failure，false/未设置 → never。API 原 autoRestart 默认 true 不变，界面新建默认 always，编辑旧配置不自动改策略。
- 退出分类与恢复策略分开：零码自主退出仍记 stopped，但 always 会安排恢复。使用期望运行状态及定时器守卫，不依赖 bad allocation 日志匹配。
- 复用指数退避（基础 3000ms，上限 60000ms）、最多 5 次重试及稳定运行 60000ms 后重置。达到上限暂停恢复，人工 Start/Restart 重新开始；启动配置错误需人工修正。
- Stop、dispose、实例编辑/删除、管理器关闭取消恢复；人工 Start 清除旧定时器。Windows watchdog 根据有效策略启用，并在异步检测前后核对进程身份。
- 无需 ADR 或项目规则更新；这些约定已在代码与双语 README 中说明。

## 验证
- 固定 Node 24.21.0 由项目现有运行时脚本核对 SHA-256 后提取到忽略的项目缓存。
- typecheck、build:server、frontend typecheck/build/lint、smoke:supervisor 全部 exit 0；真实 Windows ConPTY 回归 121 项 PASS，耗时 97.519 秒。
- 根目录实际命令（使用固定 Node）：`node_modules/typescript/bin/tsc --noEmit`；`node_modules/typescript/bin/tsc -p tsconfig.build.json`；`--import tsx scripts/smoke-supervisor.ts`。
- frontend 目录实际命令（使用固定 Node）：`node_modules/typescript/bin/tsc -b`；`node_modules/vite/bin/vite.js build`；`node_modules/eslint/bin/eslint.js .`。
- `git diff --check` exit 0。独立新上下文 Diff Review、Conformance Review 已执行，未发现确认缺陷。
- 验证前后 tracked diff + 新增 RestartInfo.tsx 指纹一致：`e78088b4ad79c868997b8645e482e5a91be5b567c0bc3b9a56731273ef735426`；最终源码/测试/配置未再修改。
- 本地完整证据位于 `.cache/restart-policy-evidence.json`、`.cache/smoke-supervisor.log`；缓存可核对但不作为长期交付文件。

## Pitfalls / 限制
- 截图不能证明 RWR 实际退出码。本次通过真实子进程模拟零码/非零退出证明策略行为，未复现实际 bad allocation 或 Windows 崩溃弹窗。
- Windows PTY spawn 完成不等于子进程已输出就绪；检查启动次数前必须等待 child ready，不能用短固定 sleep 推断失败。
- dispose 不仅取消定时器，也需清除展示计数。此项首轮失败已修正，最终完整回归通过。
- HTTP 保存重载、实际浏览器显示、完整管理器退出、60 秒稳定运行重置和退避上限未单独动态验证；相关路径经独立静态审查。构建保留既有大 chunk 警告。
- 过程 TASK 于 2026-10-01 获授权后随归档清理删除。

## 指针
- [后续端到端动态验证：51 项通过及仍未覆盖的边界](2026-10-01-restart-policy-e2e.md)
- [状态机](../../src/core/instance/instance-supervisor.ts)
- [配置契约](../../src/core/instance/instance-types.ts)
- [回归检查](../../scripts/smoke-supervisor.ts)
- [中文使用说明](../../README.zh-CN.md)
