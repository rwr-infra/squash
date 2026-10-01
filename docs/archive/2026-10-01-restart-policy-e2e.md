# 重启策略端到端验证

- 日期：2026-10-01；风险：中；commit policy：none。
- HEAD：`7fd667461a08ef7b6bb861a8412e0672f7dcf402`；上次功能实现与本次测试扩展均未提交。
- 用户选择继续补充端到端验证；本次未修改用户实例配置或生产实现，未启动实际 RWR、未部署。

## 结果与证据
- 新增 [smoke-restart-policy.mjs](../../scripts/smoke-restart-policy.mjs)，使用真实编译后的管理器、HTTP、WebSocket 和 Windows ConPTY 模拟子进程。
- 固定 Node 24.21.0 最终 **51 项 PASS，exit 0**；最终脚本 SHA-256 `7ae8515d46b810e39e4c9897ebb815f1ab8dfcadc3f5073a4249458538331d34` 与受审版本一致。
- 验证了三种策略和 legacy 布尔配置的零码/非零运行行为；HTTP 创建/编辑/拒绝非法策略及管理器重载；WS 初始、实时、晚连接完整暂停状态和 HTTP 字段一致性。
- 验证了待重启时 Stop/编辑/删除取消；五次重试持续暂停；真实稳定运行 60 秒后计数重置且观察期内不提前重置；精确 60000ms 退避预算和公开计划时间。
- Windows 模拟新/旧 crashdump、never 禁用 watchdog 与旧 PID 消失检查通过。真实管理器关闭处理器停止正在运行的 fixture，取消待重启，关闭 WS、释放端口。
- 子进程由独立 OS 枚举确认消失，临时应用清理完成；原 config/instances.json 指纹不变。
- HTML、JS 资源和终端 SPA 路由服务检查通过。独立新上下文 Diff Review、Conformance Review 和修改补审均完成，最终无确认缺陷。
- `node --check`、`git diff --check` 通过；原功能的 121 项回归对应同一未修改生产代码，未重复计作本次运行。
- 本地详细证据：`.cache/restart-policy-e2e-evidence.json`、`.cache/restart-policy-e2e.log`、`.cache/restart-policy-e2e-freeze.json`。

## 可复用决定与 Pitfalls
- `npm run smoke:restart-policy` 需要 Node >=24 和已构建的 server/frontend；入口与构建命令写在双语 README。
- appPaths 从代码位置推导根目录，因此把 dist 复制到项目缓存下的临时 app，即可隔离 config/logs；不复制或覆盖用户配置。
- 不用 runtime 报告的停止状态证明真实进程死亡。通过 fixture 独立 ready 输出和唯一命令行进程枚举交叉验证；不杀可能已被复用的历史 PID。
- 清理后再写证据，清理异常也标 failed。慢 WMI 枚举需放在短 pending 窗口之前，避免测试自身阻塞造成误失败。
- HTTP/WS 比对完整字段；退避验证日志精确预算与时间戳，不能用一秒的宽容差掩盖上限回归。
- 本次无需更新项目规则；测试约定已在脚本及 README 说明。过程 TASK 于 2026-10-01 获授权后随归档清理删除。

## 验证边界
- 浏览器 inventory 为空，内置浏览器返回 `Browser is not available: iab`；真实浏览器交互未验证，静态资源服务不能替代该证据。
- Windows 通过 IPC 触发真实 SIGTERM handler，未验证 OS 信号投递；模拟 dump 不等于复现实际 RWR bad allocation/崩溃弹窗。
- 稳定运行观察约 100ms 粒度；检查退避计划上限，没有等待完整 60 秒退避实际触发。仅枚举本轮 Node fixture，不作通用 node-pty 辅助进程泄漏检测。

## 指针
- [原功能归档](2026-09-30-restart-policy.md)
- [中文说明](../../README.zh-CN.md)
