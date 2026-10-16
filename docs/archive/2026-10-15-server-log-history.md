# 保留之前几轮的服务器日志；实例表单分 Simple/Advanced

- 日期：2026-10-15 – 2026-10-16
- 风险：高（服务器上自动改名和删除文件；改动 supervisor 的启动路径）
- Commits：`e2176dc`..`b56518e`（分支 `feat/server-log-history`，PR #17）
- 相关 ADR：无

## 结果
- **保留之前的日志。** 实例开启 `serverLogHistory: { keepDays, keepFiles }` 后（缺失表示关闭），每次 spawn 之前（Start、Restart、崩溃后的自动重启），非空的服务器日志会被移到它旁边的 `<日志名>.history/` 里，例如 `rwr_server.2026-10-15_18-29-44.log`（时间取它最后一次写入的时间）。spawn 之后，按天数和个数清理旧备份，最新的那份永远保留。
- **网页查看。** Log 页头部的下拉框可以选择查看某一份备份，选择写在 `?archive=` 里。
- **表单。** 实例弹窗分 Simple 和 Advanced 两种模式；Advanced 和模板表单里有 "Keep Previous Logs"。全新安装生成的 RWR 种子模板设为 7 天、50 份。
- **验证。** 用户在 macOS 上用假的 rwr_server 逐步人工验证了全部 8 步。

## 关键决策
| 决策 | 原因 | 否决方案及原因 |
| --- | --- | --- |
| 已有实例缺这个字段时视为关闭；不迁移已有 `templates.json` | 升级不应悄悄在游戏目录建目录、占用磁盘；模板存储的原则是从不改动已有文件 | rwr_server 实例自动开启：磁盘占用可能悄悄增加 50 倍 |
| 备份放在日志旁的 `<日志名>.history/`，用改名而不是复制 | 同一个盘内改名是原子操作，GB 级日志也是瞬间完成；清理范围限定在一个专用目录里 | 和日志放在同一目录：游戏目录里会散落 50 个文件。放进 squash 的 `logs/`：可能跨盘，只能复制 |
| 备份名里的时间取旧日志的 mtime（本地时间），同一秒内的后缀取"已用的最大后缀 + 1"（超过 9999 时回到第一个空位），绝不覆盖 | 时间对应日志内容本身；后缀不复用，名字顺序就等于备份顺序（有的文件系统 mtime 只精确到秒） | 用备份发生的时刻：停服几天后再启动，时间和内容对不上。用第一个空位：清理释放的名字会被下一轮重新拿到（见 Pitfall） |
| 在 `start()` 里同步改名，位置在标成 `starting` 之后、`createPtyProcess` 之前，中间没有 await；失败只写一行实例日志，照常启动 | 状态机不会多出新的竞态窗口；服务可用比日志更重要 | 异步改名：stop 可能插进改名和 spawn 之间 |
| 清理在 spawn 之后排队执行，dispose 会等它完成；`newest` 在清理**执行时**才读取 supervisor 最后一次备份的名字 | 刚备份的那份不能被删：时钟回拨、同秒的 mtime、排队中又出现更新的备份，都可能让 mtime 排序出错 | 入队时就传入 `newest`：队列积压时这个值会过时 |
| 只删除 history 目录里名字完全符合格式、lstat 为普通文件的条目；history 目录本身必须是真实目录（不能是符号链接或 junction） | 名字匹配一旦写错就是误删 | 先 realpath 再判断：每次刷新都要重新打开文件，有 TOCTOU 窗口，又不能真正做到约束 |
| 读备份用 `?archive=<名字>`，只是一个文件名；每次请求都用 lstat 检查；名字不合法返回 400，不存在返回 404 `SERVER_LOG_ARCHIVE_NOT_FOUND`；列表接口不管保留功能当前开没开 | 沿用"接口不接受路径"的原则；关掉保留之后，已有备份照样能看 | 新增一组带路径参数的路由：多一个读任意文件的入口 |
| 备份索引按路径缓存，最多 8 个，LRU；用 `stableGeneration` 让 generation 由文件身份派生 | 缓存淘汰后重建，generation 不变，前端就不会误报"日志被重置" | 每次重建都用随机 generation：页面会跳到末尾并清空搜索 |
| Log 页查看备份时不轮询，回到标签页时也不重新请求；内层视图按 instanceId 和 archive 加 key 重新挂载 | 缓存没命中时每次请求都要全量扫描；切换日志时不会带着旧状态 | 和当前日志一样每 2 秒轮询 |
| 表单里两个上限数字框始终挂载，开关关闭时只是隐藏；是否发送、是否校验，都在提交时从 store 读取 | 按 watch 条件挂载时，套用模板后立刻提交会把设置悄悄丢掉（e2e 抓到） | 按 `Form.useWatch` 条件挂载 |
| Simple 模式用 `Form.Item hidden` 隐藏字段；校验失败时只在这一次打开的弹窗里切到 Advanced，并定位到出错字段，不改写记住的选择 | 隐藏的字段照样注册、校验、提交；用户选的模式不该被一次报错改掉 | 卸载隐藏字段：值会丢失。自动切换也写进 localStorage：会覆盖用户的选择 |

## 确立的规范
- **服务器上的文件**：备份和日志一样，只能通过实例配置算出位置；接口只接受备份名，名字由 `isArchiveName` 校验，读之前再用 `resolveServerLogArchive` 做 lstat 检查。`resolveServerLogPath`（`server-log-file.ts`）是唯一的日志路径解析入口，ServerLogService 和 supervisor 都用它。
- **会删除文件的代码**：只删那些名字由我们自己生成、能被严格匹配回来的条目；不跟随条目上的符号链接，也不跟随目录本身的符号链接；每条删除路径都要有变异测试（这次删除和改名逻辑一共做了 20 多个变异）。
- **前端手抄的后端规则又多了一份**：`frontend/src/services/instanceForm.ts` 的 `sanitizeServerLogHistory`/`SERVER_LOG_HISTORY_LIMITS` 对应 `src/core/log/server-log-history.ts`，在 `test/unit/server-log-history.test.ts` 里跑同一张用例表，两边必须一起改。
- **antd 表单**：提交的数据不能依赖条件挂载的字段，按开关决定的字段要始终挂载、按需隐藏；包装组件要把 Form.Item 注入的 `id`/`checked`/`onChange` 原样传下去；`disabled` 不要显式传 `false`，用 `|| undefined`，否则会盖过 Form 的 disabled 上下文。
- **Log 页**：`ServerLogView` 按 instanceId 和 archive 加 key 重新挂载，需要跨日志保留的状态要放在外层 `ServerLogPage`。
- **e2e**：断言"列表里有刚保存的东西"之前，先等列表刷新出来；打开抽屉或对话框时看到的可能还是缓存里的旧列表。

## Pitfalls
- **被清理释放的后缀会被复用**：后缀按"第一个空位"分配时，同一秒内几轮重启加上一次清理，就会让一个名字先后指向两轮日志。现象是 supervisor 测试偶发失败。做法：取已用的最大后缀 + 1。
- **antd Form.Item 字段级 `initialValue` 与表单级 `initialValues` 冲突**：开发模式会报 "Form already set 'initialValues'"。默认值统一放在表单级的值里。
- **`Form.useWatch` 晚一帧**：它通过宏任务批量通知，首帧返回 undefined。不要拿它决定提交什么；首帧也别据此显示错误提示（例如 "Needs a Server Log File."）。
- **Windows 上删除 `process.env.TZ` 不会恢复时区**：测试里临时改了 TZ，再 `delete process.env.TZ`，同一文件里后面的测试仍按改后的时区运行（windows-latest 上差了 8 小时）。做法：还原时按名字设回原来实际生效的时区，见 CLAUDE.md 的 Platform notes。
- **e2e 只在 agent 下运行时，通过的测试看不到 console 输出**：调试时加 `--silent=false`。
- **instance-form e2e 的抽屉检查偶发失败**：`openDrawer()` 等到的是缓存里的旧列表；已改为先等新模板出现。

## 剩余风险 / 后续
- **Windows 未用真实 rwr_server 实跑**（已记入 backlog）：
  - taskkill 之后立即改名能否成功；
  - 杀毒软件或 `Get-Content -Wait` 之类占着日志时改名会失败，那一轮的日志就会丢失（只记一行日志，没有重试）；
  - junction 被识别为链接、因此拒绝写入。
- **已接受**：
  - `isFree` 检查和 rename 之间，外部进程创建同名文件会被覆盖；
  - 读备份时 lstat 检查之后被换成链接，会被跟随（与已接受的当前日志风险同源）；
  - 改日志文件名（包括只改大小写）后，旧备份不再列出，也不再清理；
  - 崩溃循环会产生一些短日志，占用个数名额；
  - spawn 失败时不清理；
  - dispose 要等清理完成；
  - 手改出的非法 `serverLogHistory` 在编辑保存时会被删掉；
  - 下拉框按浏览器时区显示时间，文件名按服务器时区生成；
  - 用键盘切换日志后焦点会丢失。
- **后续**（已记入 backlog）：网页上下载或删除备份、压缩、Windows 上的重试。

## 指针
- 后端：
  - `src/core/log/server-log-history.ts`：命名、改名、列出、清理、`resolveServerLogArchive`；
  - `src/core/log/server-log-file.ts`：`resolveServerLogPath`；
  - `src/core/instance/instance-supervisor.ts`：`archivePreviousServerLog`、`pruneServerLogHistory`、`latestBackup`；
  - `src/core/log/line-index.ts`：`stableGeneration`；
  - `src/services/server-log-service.ts`：备份读取和 LRU；
  - `src/api/http/routes/server-log-routes.ts`；
  - `schemas/{instance,template,server-log}-schemas.ts`。
- 前端：
  - `frontend/src/components/InstanceFormFields.tsx`；
  - `services/instanceForm.ts`；
  - `pages/{InstanceListPage,ServerLogPage}.tsx`；
  - `components/{LogSearchBar,TemplateModal,TemplatesDrawer}.tsx`；
  - `App.tsx`：登录后保留查询串。
- 测试：
  - `test/unit/server-log-history.test.ts`（含前后端同表用例）；
  - `test/integration/{server-log-history,server-log-service,server-log,supervisor,templates,auth}.test.ts`；
  - `test/e2e/{instance-form,server-log-ui}.test.ts`。
- 相关归档：[服务器日志文件可配置](2026-10-10-server-log-file.md)、[rwr_server.log 查看器](2026-10-10-server-log-viewer.md)、[实例模板](2026-10-09-instance-templates.md)
