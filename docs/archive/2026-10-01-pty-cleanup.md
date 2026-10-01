# Windows PTY 输入资源释放候选

当前 node-pty 1.2.0-beta.12 的非 DLL Windows 自然退出路径未销毁输入 Socket。候选修复在适配层检查精确依赖版本和创建/暴露输入 Socket 的实现指纹（在 spawn 前拒绝不兼容实现），在真实 PTY exit 后关闭输入并忽略旧对象后续写入/resize/kill，公开退出只通知一次；不提前关闭输出，不在 supervisor 访问私有字段，不使用全局异常 handler。仅退出后的明确关闭类输入错误可被容忍，活动期间和其他错误仍失败退出。

依赖精确锁定到 1.2.0-beta.12。官方 [issue #947](https://github.com/microsoft/node-pty/issues/947) 与本机观察一致，[当前源码](https://github.com/microsoft/node-pty/blob/main/src/windowsPtyAgent.ts) 仍有同样清理路径。公共 kill/destroy 不能在该路径释放输入，未盲目升级 beta 或切换 ConPTY DLL。未来依赖更新需重新验证此局部兼容。

原生命周期探针未改：Node 24.21.0 下，两组各 8 轮，从修复前最终 8 个活动输入 Socket 改为 0，队列为 0，实跑退出 0。**OS 总句柄仍从 194 增至 311**，故仅证明输入 Socket 残留被处理，其他 native/helper/管道资源尚待定位，不代表全部泄漏解决或 RWR bad allocation 根因已确认。

新增 `npm run smoke:pty-cleanup`：真实 ConPTY 正常退出、exit1、强杀、重复/退出后操作、末尾输出冲刷与两类错误边界，以及版本/实现指纹负测，共 7 项。错误注入两 worker 预期退出 1，父级核对指定异常；假服务器通过独立枚举清理。生命周期、契约、supervisor 状态机和 HTTP/WS 51 项回归均退出 0；类型检查、构建、脚本语法和 diff 检查通过。证据、精确命令及审查状态见 [TASK](../tasks/2026-10-01-pty-cleanup/TASK.md)。

独立 Diff / Conformance Review 及修订补审已完成。首轮发现事后 Socket 形状拒绝仅调用延迟 kill，无法保证失败清理，已改为在创建 PTY 前检查精确实现指纹；负测确认拒绝时真实 spawn=0。全部回归在修订后重新通过，补审没有新增阻断项。

提交策略 confirm，提交前由用户确认；基准 HEAD `7fd667461a08ef7b6bb861a8412e0672f7dcf402`，此前成果和用户 `.zcodeignore` 保留，无 push/发布/部署。本轮 9 文件的独立提交差异为 `.cache/pty-cleanup-proposed-commit.patch`，通过临时 index 准备，不触碰真实暂存区。本轮相关文件为 adapter、精确依赖 manifest/lock、新契约探针、README/backlog 和调查文档。TASK 保留，本次无需更新项目规则。回退只恢复本轮前相关文件内容，不撤销此前重启策略。真实 RWR、其他平台、长时及并发仍未验证。
