# Windows PTY 退出窗口的有界调查

- 日期：2026-10-01；风险：中；提交：none。
- 基准：main / `7fd667461a08ef7b6bb861a8412e0672f7dcf402`。前次重启策略、表单和 CI 修改保留。

## 结果
Node 24.21.0 / node-pty 1.2.0-beta.12 / 本机 Windows ConPTY 的实际 supervisor/adapter 上，11 个隔离场景都确认真实子进程已消失、PTY exit 尚未发生，并发生了实际底层 socket 调用。覆盖命令、原始输入、捕获命令和计划 stopCommand，以及零码、非零和外部强杀退出。

没有观察到自然发生的未捕获异常。**最终为 10 PASS、1 INCONCLUSIVE，诊断退出码 2，不能称为全部安全通过。** 高压 capture/forced 场景在 2s 排空预算结束时仍有 409,650 字节待写，额外 500ms 后虽然为零，仍保留未排除结论。更早运行另有约 1MiB 在观察内未排空的场景，表现受调度影响；没有反复运行直到 green。

生产 supervisor/adapter 和依赖未改，也未启动真实 RWR。仅新增可重复调查脚本、npm 入口、双语说明并更新 backlog。用户配置指纹未变，正式 fixture 清理完成。

## 决定与探测边界
- 使用真实编译组件，只有测试 worker 观察私有 inSocket.write，委托原函数；不改 node_modules、不增加吞错误的全局处理器。
- OS 存活检测与 PTY 事件独立；无真实窗口写入时检查必须失败。ready PID 必须是完整标记并与实际 PTY PID 相符。
- 写入计数不代表调用成功。生产计划停服会捕获同步写错误，因此观察器必须记录后原样 rethrow，并明确判失败。
- 2s 预算判断一旦形成，不被额外 500ms 的排空改写。额外时间只观察异步错误。
- 退出 0 表示本轮有界观察无错误且预算内排空；退出 2 表示未排除；退出 1 表示异常、覆盖前提失败或清理失败。此调查命令未接入 CI。
- worker 显式退出，不能据此声称底层 input handle 已自行关闭；尚不能确认跨实例累积或内存泄漏。

## 验证与审查
- `npm run smoke:pty-exit-window`，先构建服务端，Node >=24，Windows 专用。正式运行的精确命令及结果的过程 TASK 已随归档清理删除；本机证据见下条缓存文件。
- build:server、根 typecheck、脚本 syntax、diff 检查通过；观测 exit 2 单独保留，没有用静态通过替代它。
- 缓存负测确认：注入异步 socket error，worker/父级退出 1；计划 stop 写入同步 throw 即使被生产捕获，探测也退出 1；模拟第 2.3s 排空，预算截止有 64 bytes、最终 0 bytes，仍退出 2。负测不构成自然生产缺陷复现。
- 独立 Diff / Conformance Review 发现同步异常与预算边界的假通过风险；修复、复验、补审后均关闭为 fixed，无新增可行动问题。
- 正式证据 `.cache/pty-exit-window-observation-evidence.json`、日志 `.cache/pty-exit-window.log`；负测各有专用 evidence/proof；最终指纹 `.cache/pty-exit-window-validation.json`。缓存为本机材料，不随仓库提交。

## 后续
继续确认待写队列和输入句柄的生命周期，特别是反复重启是否累积。真实 pipe 故障、RWR、其他 Windows/ConPTY 版本和更高压力仍未验证，不能推导全面安全。对应 [backlog](../backlog.md) 保留未排除状态。

没有提交、推送、发布或部署，过程记录保留；本次无需更新项目规则。

## 指针
- `scripts/smoke-pty-exit-window.mjs` / `package.json`
- `src/core/pty/pty-process-adapter.ts`、`src/core/instance/instance-supervisor.ts`（本次未改）
- README / README.zh-CN 的本地调查入口
