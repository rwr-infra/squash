# Task: 保留历史服务器日志；实例表单分 Simple/Advanced

- Risk: 高 —— 会在服务器上自动改名和删除文件（保留策略），匹配规则一旦出错就可能误删游戏目录里的文件；另外还动了 supervisor 的启动路径
- Commit policy: auto（每个 checkpoint 在功能分支上提交；push/PR/merge 每次单独问）
- Branch: feat/server-log-history

## Goal
开启"保留历史日志"的实例，每次启动进程前把上一轮的服务器日志（如 `rwr_server.log`）改名，存成带时间戳的备份；按天数和个数自动清理；备份能在网页 Log 页里选中查看。实例表单分 Simple/Advanced 两种模式。

## Scope
- 必须完成：
  - 实例配置新增 `serverLogHistory?: { keepDays, keepFiles }`，缺失表示关闭。实例与模板的 schema、表单、模板清洗都要支持。全新安装的 RWR 种子模板带 7 天 / 50 个。
  - supervisor 每次 spawn 前（Start、Restart、自动重启）做备份；spawn 后异步清理。
  - 接口：列出备份；现有三个 server-log 接口加可选的 `archive` 查询参数，用来读某个备份。
  - Log 页：下拉选择"当前 / 某个备份"。
  - 实例弹窗：Simple/Advanced 切换。
  - 测试、README（中英）、backlog 同步更新。
- 明确不做：压缩备份；下载或在网页上删除备份；运行中按大小轮转；squash 关闭时备份；迁移已有 `templates.json`；已有实例自动开启；模板弹窗加 Simple/Advanced。

## Decisions
- 已有实例缺字段 = 关闭，需要编辑实例才能开启 —— 升级不应悄悄在游戏目录建目录、占磁盘（用户 2026-10-15）
- 不迁移已有 `templates.json`，用户自己在 Templates 抽屉里给 RWR 模板填 7/50 —— 沿用"从不改动已有文件"原则（用户 2026-10-15）
- 天数和个数两个上限同时生效，都必填：天数 1–3650，个数 1–1000 —— 磁盘占用始终有界（用户 2026-10-15）
- 备份放在日志旁的专用子目录：`<日志所在目录>/<日志文件名>.history/`，例如 `<cwd>/rwr_server.log.history/` —— 同一个盘内改名是原子操作，GB 级文件也是瞬间完成；清理只在这个目录里进行；游戏目录不会散落文件（用户 2026-10-15）
- 网页可以查看历史备份（用户 2026-10-15）
- 实例弹窗加 Simple/Advanced（用户 2026-10-15）：
  - Simple 只显示模板、ID、Name、Working Directory、Executable；
  - 其余字段用 `Form.Item hidden` 隐藏，仍然注册、校验和提交；
  - 模式记在 localStorage；
  - 隐藏字段校验失败时自动切到 Advanced。
- 备份名：`<stem>.<YYYY-MM-DD_HH-mm-ss>[-N]<ext>`，例如 `rwr_server.2026-10-15_10-30-00.log` —— 时间取旧日志的 mtime（本地时间），也就是那一轮最后一次写日志的时间，大致等于那一轮结束的时刻。不用"备份时刻"：实例可能停了好几天才再启动，那时的时刻和日志内容对不上。同一秒重名时加 `-1`、`-2`，绝不覆盖已有文件。（用户确认 2026-10-15）
- 备份用**同步**的 `stat` + `mkdir` + `rename`，在 `createPtyProcess` 之前调用 —— start() 里不多出 await，状态机不会有新的竞态窗口（比如 stop 恰好插进 backup 和 spawn 之间）；改名只改元数据，耗时是毫秒级。清理改为 spawn 之后异步执行，排进队列，dispose 时等它完成。（用户确认 2026-10-15）
- 备份失败（目录名被同名文件占了、无权限、EXDEV、EBUSY）只在实例日志里记一行 `[squash]`，服务器照常启动 —— 服务可用比日志更重要。（用户确认 2026-10-15）
- 按年龄清理用备份文件的 mtime；按个数清理时按 mtime 从新到旧排序（mtime 相同再比名字），只保留最新的 keepFiles 个；**最新的那个备份永远不删** —— 停服两周后再启动时，刚备份的上一轮日志不应该被年龄规则立刻删掉。（用户确认 2026-10-15）
- 清理只删这些文件：位于 history 目录内、名字完全符合本日志的备份格式、lstat 结果是普通文件。不跟随条目上的符号链接；其他文件一律不碰。
- `serverLogFile` 为 `''` 时忽略 `serverLogHistory`，既不备份也不建目录。
- （审查后补充）history 目录本身必须是真实目录，用 lstat 判断：如果它是符号链接或 junction，不往里备份（抛错，记一行日志），列表和清理都当作没有备份处理。否则改名和删除会作用到 cwd 之外 —— cp1 审查（2026-10-15）
- （审查后补充）清理时把刚备份的那份当作"最新"，由 `newest` 参数传入，不按 mtime 排序决定 —— 同一秒内后缀会被复用，时钟回拨时也会排错，刚备份的那份可能被个数规则删掉（cp1 审查，2026-10-15）
- （审查后补充）`archiveServerLog` 遇到不是普通文件的日志时返回 undefined，不抛错；单个条目 lstat 失败只跳过这一个；备份名用 NFC 匹配 —— cp1 审查（2026-10-15）
- （cp3）列表接口与保留功能当前是否开启无关：即使关了，之前的备份也照样列出、可读。列表里同时返回实例的设置（`keep`，关闭时为 null）。
- （cp3 审查后）备份的索引缓存按路径作 key，最多 8 个，最近最少使用的先淘汰。备份索引使用 `stableGeneration`：generation 由路径、dev、ino、size、mtime 派生，淘汰后重建也不变，否则前端会把它当成"日志被重置"。备份在检查之后被删掉时返回 404，不返回空文件。`file` 按当前配置的写法返回（2026-10-15）
- （cp4）表单里两个数字框始终挂载，开关关闭时只是隐藏，值里始终是默认值或已保存的值。是否发送、是否校验，都在提交那一刻从表单 store 读取，不看 watch。原因：最初数字框是按 watch 条件挂载的，e2e 发现套用模板后立即提交会把设置悄悄丢掉（2026-10-15）
- （cp4 审查后）校验失败自动切到 Advanced 时只影响这一次打开的弹窗，不改写记住的选择，并滚动、聚焦到出错的字段；每次打开弹窗都从记住的选择开始。"Save as template" 和提交用同一个条件：没有日志文件时不带保留设置（2026-10-15）
- （cp5）Log 页查看备份时不轮询，回到标签页时也不重新请求：备份不会变化，而缓存没命中时每次请求都要重新扫描整个文件。外层页面读取 `?archive=`（空值视为当前日志），内层视图按 instanceId 和 archive 加 key 重新挂载，状态不会从一个日志带到另一个。备份不存在、或名字不合法（400）都视为最终结果，显示"没有这份之前的日志"；读行或搜索时发现备份已删，也显示同样的提示。重新登录后保留 `?archive=`（2026-10-15）
- 接受的风险：
  - `isFree` 检查和 rename 之间，如果另一个进程恰好建了同名文件，它会被覆盖。squash 内部全程同步，rwr 此时也没在运行。
  - 改日志文件名（包括只改大小写）后，旧备份不再列出，也不再清理。
  - 年份 ≥ 10000 的 mtime 不匹配格式。
  - 读备份时对符号链接的检查（lstat）只代表检查那一刻：有 cwd 写权限的人可以在打开前把它换成链接，硬链接也查不出来。这与已接受的"当前日志跟随链接"风险同源（见 `docs/archive/2026-10-10-server-log-file.md`），不增加攻击者的能力。
  - 崩溃循环产生的短日志会占用个数名额，但每轮最多 5 次重试就暂停。
  - spawn 失败时不做清理，最多多出 1 个文件，下次成功启动时会清掉。
  - dispose 要等清理完成：网络盘卡住时，编辑或删除实例会跟着变慢。"dispose 等清理"这一点只有代码保证，没有能区分的测试。
  - 用键盘在下拉框里切换日志后，视图重新挂载，焦点落回 body。
  - 下拉框里的时间按浏览器的时区显示，备份文件名按服务器的时区生成。两边时区不同时，两者对不上（README 里说明）。
  - 查看备份时，如果所需的行都已加载，备份被删后要等再读一块（滚动、搜索）或刷新页面才会显示"已删除"。
  - 手改出的非法 `serverLogHistory`，在编辑表单里显示为关闭；保存后会从配置中删掉。服务端本来就把它当作关闭，运行行为不变。
  - Windows 上只改名一次，不重试。如果有程序一直开着日志、不共享删除（例如 `Get-Content -Wait`、BareTail），或杀毒软件短暂占用，就只记一行日志，那一轮的日志会被 rwr 清空。README 里说明，重试记入 backlog。
- （审查后补充）清理在**执行时**读取本 supervisor 最后一次备份的文件名（`latestBackup`），不在入队时取值。否则队列积压时 `newest` 会过时，keepFiles=1 时可能删掉最近一轮的日志（cp2 审查，2026-10-15）
- （cp3 期间修正）同一秒内的后缀取"该时间已用的最大后缀 + 1"，不取第一个空位；超过 9999 时回到第一个空位。这样被清理释放的名字不会再分给后来的那一轮，名字顺序就等于备份顺序（mtime 可能只精确到秒）。见 Pitfall（2026-10-15）
- （审查后补充）`resolveServerLogPath` 在 `cwd` 不是字符串时返回 undefined。supervisor 构造时会调用它，手改的坏配置不能让整个注册表加载失败（cp2 审查，2026-10-15）

## Acceptance
- 成功路径：
  - 实例配置为 `serverLogFile: rwr_server.log`、`serverLogHistory: {7, 50}`。每次 Start、Restart 或崩溃后自动重启时，如果 `<cwd>/rwr_server.log` 非空，就在新进程 spawn **之前**把它移到 `<cwd>/rwr_server.log.history/rwr_server.<mtime>.log`。新进程启动时这个文件已经不存在。实例日志（`logs/<id>.log`）里有一行 `[squash]`，写明备份名。
  - 每次备份后清理：删除 mtime 早于 now − keepDays 的备份，最多保留最新的 keepFiles 个，最新的那个永远保留。
  - `GET /api/instances/:id/server-log/history` 按从新到旧列出备份，每项有 `name`、`size`、`modifiedAt`。
  - 带 `?archive=<name>` 时，现有三个接口改读那个备份，包括行区间读取和全文搜索。
  - Log 页的下拉框列出"Current"和各个备份（显示时间和大小）。选中备份后，可以照常滚动和搜索；URL 里带着这个选择，刷新后保持不变。
  - 实例弹窗有 Simple/Advanced 切换。Advanced 里有 "Keep previous logs" 开关和两个数字框，打开开关时预填 7 / 50。模板表单也能设置这两个值。全新安装生成的 RWR 种子模板带 `{7, 50}`。
- 失败/边界路径：
  - 日志文件不存在、为空或不是普通文件：不备份，不报错。
  - 备份失败：实例日志记一行 `[squash]`，内容带错误码，进程照常启动。
  - 同一秒内两次备份：后一个名字加 `-1`，前一个文件不变。
  - `serverLogHistory` 缺失，或 `serverLogFile` 为 `''`：什么也不做，也不建目录。
  - `archive` 不符合格式（比如 `../x`、`rwr_server.log`、`a/b`、编码过的 `%2F`）：400。格式对但文件不存在（例如已被清理）：404 `SERVER_LOG_ARCHIVE_NOT_FOUND`。实例没有日志文件：404 `SERVER_LOG_DISABLED`（与现有行为一致）。
  - history 目录不存在时，列表接口返回空数组。
  - 表单里关掉开关：请求里不带该字段，实例随之关闭备份。
- 不允许发生：
  - 删除或覆盖 history 目录里符合格式的备份以外的任何文件；跟随符号链接去删除；删到正在使用的日志。
  - 因为备份或清理让启动失败或变慢（只有同步改名那一步在 spawn 之前）。
  - 已有实例和已有 `templates.json` 在没人编辑的情况下改变行为或被改写。
  - 新的 `/api` 路由不需要登录就能访问。
  - 任何接口接受路径参数：`archive` 只是文件名，只在服务端算出的 history 目录里查找。

## Evidence
- 自动检查：`npm run typecheck`；`npm test`；`npm --prefix frontend run lint`；`npm --prefix frontend run build`
- 浏览器：`VITE_API_URL= npm --prefix frontend run build && npm run smoke:instance-form && npm run smoke:server-log-ui`（本地运行，需要先把 `frontend/.env.local` 移开）
- 收尾：`npm run build:server && npm run smoke:restart-policy`
- 人工检查（macOS，127.0.0.1:4747 上的 dev 服务器，用假服务，逐步验证）：
  - Simple/Advanced 切换；
  - 开启保留后多次 Restart，看 history 目录和 Log 页下拉框；
  - 关闭保留；
  - 有条件时在 Windows 上用真实 rwr 验证。
- 高风险 diff（需要你亲自读）：`src/core/log/server-log-history.ts` 的清理和改名，以及 supervisor `start()` 里的调用位置

## Checkpoints
- [x] 1. 契约和核心：类型、实例和模板 schema、种子模板、`server-log-history.ts`（解析路径、生成和识别备份名、同步改名、异步清理、列出备份；和 ServerLogService 共用路径解析）；单测（名字和格式、清理选择）、集成测试（临时目录：改名、重名、目录名被文件占用、清理只删符合格式的文件、不跟随符号链接、保留最新的那个）
      证据：`npm run typecheck` 通过；`npm test` 1007/1007；删除和改名逻辑的 13 个变异全部被抓到；Diff Review 和 Conformance Review 的发现已处理（见 Decisions）；用户已读 diff ｜ commit：e2176dc
- [x] 2. supervisor 接入：spawn 前备份，spawn 后清理，dispose 等清理完成，失败不影响启动，写 `[squash]` 日志行；`supervisor.test.ts` 加场景（多次 restart 得到多个备份；备份失败时仍然启动）
      证据：typecheck 通过；`npm test` 1025/1025；supervisor 新增 5 个场景共 17 项（spawn 那一刻日志已被移走，靠 onStatus 检查；首次 Start、自动重启、restart 三条路径；newest；失败；关闭/无日志文件）；6 个变异全部被抓到；两份审查的发现已处理；用户已读 diff ｜ commit：e1d7488（另有修复 4f66587：被清理释放的名字不再复用）
- [x] 3. 查看接口：`/server-log/history`；三个接口支持 `?archive=`；按备份缓存索引（有上限）；PROTECTED_ROUTES；集成测试（排序、读和搜索备份、各种非法名字、被清理后返回 404、关闭日志的实例）
      证据：typecheck 通过；`npm test` 13 个文件 1068/1068；新增 `server-log-service.test.ts`（缓存上限和 LRU、generation 稳定、检查后被删、file 写法）；路由的 400/404/鉴权都有用例；13 个变异全部被抓到；两份审查的发现已处理 ｜ commit：47732ed
- [x] 4. 实例表单：Simple/Advanced 和 Keep previous logs（实例表单和模板表单）；`instanceForm.ts` 的映射和清洗；更新 `smoke:instance-form`
      证据：后端 typecheck 通过；`npm test` 1073/1073（前端映射和后端规则跑同一张用例表）；前端 lint 通过；`smoke:instance-form` 72/72（新增 15 项）；`smoke:server-log-ui` 73/73；4 个前端变异全部被抓到；两份审查的发现已处理；人工验证与 cp5 合并进行（见 cp6） ｜ commit：8750923
- [x] 5. Log 页：选择并查看备份；更新 `smoke:server-log-ui`
      证据：后端 typecheck 通过；`npm test` 1073/1073；前端 lint 通过；`smoke:server-log-ui` 86/86（新增 13 项，包括不轮询、读到时已删除、手机宽度、坏链接）；`smoke:instance-form` 72/72，修掉抽屉检查的偶发失败后连续 3 次通过；4 个变异全部被抓到；两份审查的发现已处理 ｜ commit：（见 git log）
- [ ] 6. 文档：README 中英文、backlog 删掉已完成的条目、新增后续条目；人工验证
      证据： ｜ commit：

## Pitfalls
### Pitfall: 同一秒内被清理释放的后缀会被复用
- 现象：`supervisor.test.ts` 的 "each start logged its backup, by the name on disk" 偶发失败，大约 4 次失败 1 次。四轮运行落在同一秒内，run 0 的 `…45.log` 被清理之后，run 3 又拿到了 `…45.log`。
- 状态：CONFIRMED（实例日志里能看到同一个名字被用了两次）
- 原因：后缀按"第一个空闲"分配。Diff Review 在 cp1 已经提过（第 3 条 b），当时只为它加了 `newest` 保护，没有改命名规则。
- 已否决：只改测试、允许名字重复。那样一个名字会先后指向两轮不同的日志；在 mtime 只精确到秒的文件系统上，名字顺序也不再等于备份顺序。
- 来源：`src/core/log/server-log-history.ts` 的 `archiveServerLog`
- 下一步：无，已修复。

### Pitfall: instance-form e2e 的抽屉列表检查偶发失败
- 现象：`smoke:instance-form` 偶发失败（约 1/7），每次都卡在执行顺序第 42 项 "drawer lists every template"，之后的项全部标为"未记录"（27 或 31 项失败）。
- 状态：CONFIRMED（失败位置固定）。修复后连续多次通过。
- 原因：刚保存的模板要等列表重新拉取才会出现，而 `openDrawer()` 只等到出现任意一个列表项（缓存里的旧列表）就继续。这是测试本身的竞态，不是产品问题；本任务新增的检查让整个流程更长，失败才显露出来。
- 已否决：重跑直到通过（按 dev-loop 规则，flaky 测试视为损坏的检查）。
- 来源：`test/e2e/instance-form.test.ts`，"drawer lists every template" 之前的等待。
- 下一步：无。

## Sources
- `src/core/instance/instance-supervisor.ts`（`start()` 约在 L365，spawn 在 `createPtyProcess`）
- `src/core/log/server-log-file.ts`、`src/services/server-log-service.ts`（路径解析和越界检查）、`src/core/log/line-index.ts`（每次操作都是打开后关闭，不常驻句柄）
- `src/api/http/routes/server-log-routes.ts`、`schemas/{instance,template,server-log}-schemas.ts`
- `src/core/config/template-store.ts`（种子）
- `frontend/src/components/InstanceFormFields.tsx`、`services/instanceForm.ts`、`pages/{InstanceListPage,ServerLogPage}.tsx`、`services/apiService.ts`
- `test/integration/auth.test.ts`（PROTECTED_ROUTES）、`supervisor.test.ts`、`server-log.test.ts`、`templates.test.ts`；`test/e2e/{instance-form,server-log-ui}.test.ts`
- 归档：`docs/archive/2026-10-10-server-log-file.md`、`2026-10-10-server-log-viewer.md`、`2026-10-09-instance-templates.md`
