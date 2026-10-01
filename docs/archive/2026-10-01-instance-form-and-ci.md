# 实例编辑保存保护与重启策略 CI 接入

- 日期：2026-10-01；风险：中；提交：none。
- 基准：main / `7fd667461a08ef7b6bb861a8412e0672f7dcf402`，本次修改及前次重启策略改动均尚未提交。

## 结果
浏览器复现证实：实例表单的未注册 env/logDir 不参与提交，编辑会被 API 默认值覆盖。现在编辑显式携带该实例的原值，新建仍使用默认值。

保存期间同步 ref 防重复提交，界面显示 loading，禁用字段和关闭/切换入口；失败保留输入、提示错误并解除保护，成功关闭并刷新列表。清空 Restart Delay 的归一化来自前次实现，本次补了真实浏览器回归。

新增 `smoke:instance-form`：使用生产前端、实际编译 schema、隔离 API/JSON 和无头 Chromium。最终 Windows Edge 18 项通过，前端 build/typecheck/lint、脚本 syntax、工作流 YAML/结构及 diff 检查通过；用户配置未变，成功 fixture 清理。

`release.yml` 在三平台 Package 后、上传前新增 `smoke:restart-policy`，预算 10 分钟，保留原检查及默认失败门禁。Windows 本机 51 项通过；隔离变异真实失败并返回 1。**三平台云端运行和远端变异门禁未执行，仍待验收。**

## 关键决定与 Pitfalls
- 隐藏配置从编辑对象显式携带，不依赖 Form store 对未注册字段的处理；不展开未知配置字段进入 strict API body。
- 保存期间不允许 Cancel：关闭弹窗无法撤销已发出的写请求。ref 覆盖同一渲染间隔的重复提交，state 驱动 UI。
- 子控件显式 `disabled=false` 会覆盖 Form 的禁用上下文；初审发现新建 ID 的此问题，已修复并补全字段禁用回归。
- 测试不能只依赖构建时清空 API 地址。fixture 设置 CSP `connect-src 'self'`，阻止浏览器连接其他服务；错误 API 地址负测的第二个服务收到 0 请求，保存前失败。
- CI E2E 需要已有编译产物，放在 Package 后复用构建，失败阻断上传与发布；未添加远端写入或更改触发方式。

## 验证与审查
- 修改前源码在独立目录构建：隐藏字段断言失败；仅补隐藏字段但保留旧保存行为：重复请求断言失败。正式源码未为负测替换。
- 独立 Diff / Conformance Review 发现字段禁用缺口与测试隔离风险，修复、复验、补审后均关闭为 fixed。
- 51 项 E2E 后的最后补修只影响 UI ID 禁用和浏览器测试隔离，没有更改管理器或既有 E2E；最终前端版本以 18 项浏览器回归和 build/lint 验证。
- 精确命令、指纹与证据的过程 TASK 已随归档清理删除。本次相对基准的差异 `.cache/instance-form-review.patch`；正式正测 `.cache/instance-form-evidence.json`、`.cache/instance-form-ci-positive-evidence.json`；汇总 `.cache/instance-form-validation.json`。缓存是本机证据，不随仓库提交。

## 剩余范围
- API fixture 的读回不等于真实 PUT 路由验收；真实管理器 API 的既有 E2E 是另外一组证据。
- 真实 RWR 的 bad allocation、profiles 保存、Linux/systemd/Docker 停服、Windows PTY 退出窗口未验证。
- 浏览器回归覆盖桌面实例表单，不代表全部终端页面或移动端。
- 云端 CI 待推送后验证；未提交、推送、发布、部署或启动真实实例。TASK 保留，本次无需更新项目规则。

## 指针
- `frontend/src/pages/InstanceListPage.tsx`
- `scripts/smoke-instance-form.mjs` / `package.json`
- `.github/workflows/release.yml`
- [剩余 backlog](../backlog.md)
