# Windows PTY 连续生命周期调查

本轮只调查资源生命周期，未修改生产 adapter/supervisor，也未启动真实 RWR。Node 24.21.0、node-pty 1.2.0-beta.12 的 Windows ConPTY 中，同一个 supervisor 连续运行 8 轮，分别使用无退出窗口输入对照和高频输入压力。

两组均从 0 增至 8 个活动输入 Socket，父进程独立读取的 Windows HandleCount 从 190 增至 315；dispose 后等待 5s、跨事件循环 GC 后仍保留。历史对象只用 WeakRef 保存，避免测试自身强引用制造保留。该结果支持当前依赖路径存在输入资源未释放问题，但有界观察不能证明永久泄漏，也不能确定所有新增 OS 句柄都属于输入 Socket。

压力输入确实在 OS 确认子进程消失到 PTY 通知退出之间到达底层 Socket。待写数据跨轮保留，最终 5s 观察排空，不能声称队列永久累积或 RSS 增长就是内存泄漏。未观察到自然发生的未捕获异常；真实 RWR 的 bad allocation 原因、长时间运行、强杀及多实例并发未在本轮验证。

当前依赖的 `WindowsPtyAgent._cleanUpProcess` 将输入 Socket 标为不可读，只销毁输出 Socket，与上述观察一致。后续先评估依赖层修复；若需适配层兼容，必须明确版本和 Windows 条件，在真实退出后释放输入资源、处理异步错误并保证退出只通知一次。不要在 supervisor 中直接访问依赖私有字段，也不要用全局 uncaughtException 吞掉故障。候选修复应重新验证正常/异常/强杀、重复 stop/dispose、待写输入、退出通知和三平台行为。

新增 [调查脚本](../../scripts/smoke-pty-lifecycle.mjs) 和 `smoke:pty-lifecycle` 本地命令。先 `npm run build:server`，再在 Windows、Node >=24 下运行 `npm run smoke:pty-lifecycle`：0 表示最终有界观察无活动输入资源或队列，2 表示残留诊断，1 表示检查/清理失败。退出 2 不是安全通过，不接入 CI。假服务器/配置隔离，清理通过独立进程枚举验证，生产源码和用户配置指纹保持不变。

证据：`.cache/pty-lifecycle-observation-evidence.json` 和 `.cache/pty-lifecycle.log`；冻结副本由 `Copy-Item -LiteralPath .cache/pty-lifecycle-evidence.json -Destination .cache/pty-lifecycle-observation-evidence.json` 从脚本原始输出保存，完整命令的过程 TASK 已随归档清理删除。服务端构建、类型检查、脚本语法检查和 diff 检查均退出 0；实际调查退出 2。新上下文 Diff / Conformance Review 均完成，唯一证据保存命令缺口已补齐，未改受审代码。本轮范围为脚本、npm 入口、README、backlog 和调查文档。提交策略 none，基准 HEAD `7fd667461a08ef7b6bb861a8412e0672f7dcf402`；保留此前改动和用户 `.zcodeignore`，无 push/发布/部署，本次无需更新项目规则。
