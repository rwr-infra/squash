# 实例模板

- 日期：2026-10-09
- 风险：中（新持久化文件、新 REST 接口）
- Commits：`04590fe`、`0f32865`、`e3f3677`（PR #9，分支 `feat/instance-templates`）
- 相关 ADR：无

## 结果
新建实例时可以选一个模板预填表单（ID 仍留空）。模板保存在服务端的 `config/templates.json`，支持 `/api/templates` 增删改查，前端有模板管理抽屉，Create/Edit 弹窗里可以"Save as template"。模板只是快照：改模板不影响已建实例。文件不存在时生成两个可删的种子模板：RWR dedicated server（`./rwr_server`，stopCommand `quit` + 空行，Keep running）和 SteamCMD（`./steamcmd`，stopCommand `quit`，Disabled）。

`smoke:templates` 覆盖存储（种子、持久化、损坏文件不改写）和接口（CRUD、校验、401）；`smoke:instance-form` 增加了模板预填、另存、抽屉等浏览器检查，原有实例表单回归保持通过。用户人工验证通过。

## 关键决策
| 决策 | 原因 | 否决方案及原因 |
| --- | --- | --- |
| 存服务端 `config/templates.json` | 多浏览器共享，随 `config/` 一起备份 | localStorage：换浏览器就没了 |
| 种子只在文件**不存在**时写入；`[]` 不补；JSON 损坏或 id 重复时启动报错、不覆盖；接受 UTF-8 BOM | 删光模板是用户的选择；损坏文件可能是手改到一半，覆盖会丢数据 | 每次启动补种子：删不掉 |
| 种子可执行文件全平台用 `./rwr_server` | 裸名 `rwr_server` 会走 PATH 查找而启动失败；Windows 上 `resolveCommand` 会补 `.exe` | Windows 用 `rwr_server.exe`：同样走 PATH |
| 写入是事务式的：副本上改 → `.tmp` → rename → 成功后才替换内存；串行执行，重名检查在同一段里 | 写失败时列表和文件都不变；并发请求不会都通过重名检查 | 先改内存再写盘：写失败后内存和磁盘不一致 |
| 只在改名时检查重名（大小写不敏感）；保持原名总是允许 | 手改文件造成的重名不会把编辑锁死 | 每次保存都检查：无法编辑已冲突的模板 |
| 重名返回 409 `TEMPLATE_NAME_TAKEN` | 前端可以在模板名字段上报错 | 400：和 schema 错误混在一起 |
| 前端按模板 schema 过滤模板值 | 手改文件里错类型、越界或多余的字段被丢弃，不会白屏；创建实例时仍由实例 schema 把关 | 原样灌进表单 |

## 确立的规范
- 新的 `config/*.json` 存储沿用 `template-store.ts` 的写法：注入路径、事务式写入、损坏即报错不覆盖、接受 BOM。
- 浏览器 smoke 要用 `VITE_API_URL= npm --prefix frontend run build` 构建；`frontend/.env.local` 里的 `VITE_API_URL` 会被烤进产物，页面会连到别的服务。

## Pitfalls
- antd 的 toast 和进行中的动画会挡住点击：Select 用键盘选，点击前先检查目标是否被遮挡。
- 经 CDP 序列化时，值为 `undefined` 的键会消失；需要比较"键存在且为空"时用 `null`。
- 模板弹窗用 `open` 控制而不是 `key` 重挂载，才能保留关闭动画和焦点归还；实例弹窗仍依赖 `ResetFormOnMount`（见 CLAUDE.md）。
- PR #9 先于鉴权修复 PR #10 合入，`smoke:auth` 的路由清单守卫随即在 main 上失败；补登记见 PR #11。多个 PR 同时在途时，后合的那个要在合入前对最新 main 再跑一遍 CI。

## 剩余风险 / 后续
- 模板没有审计记录（实例的 PUT 也没有，保持一致）。
- 模板不包含 env 和 logDir（表单本来就不编辑这两项）。
- `smoke:templates`、`smoke:instance-form` 是否进 CI 尚未决定。

## 指针
- `src/core/config/template-store.ts`、`src/services/template-service.ts`、`src/api/http/routes/template-routes.ts`
- `frontend/src/components/TemplatesDrawer.tsx`、`TemplateModal.tsx`、`InstanceFormFields.tsx`；`frontend/src/services/instanceForm.ts`（`sanitizeTemplateValues`）
- `scripts/smoke-templates.ts`、`scripts/smoke-instance-form.mjs`
