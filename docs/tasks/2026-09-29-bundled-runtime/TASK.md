# Task: 降低部署难度 —— 安全默认值 + 自带 Node 运行时的便携包

- Risk: 高 —— 改认证/监听门禁、改发布链（打包脚本、CI、package.json scripts）、构建期新增网络下载；可 git 回滚，无生产数据
- Commit policy: auto（每个验证通过的 checkpoint 一个语义 commit；push/发布单独授权）
- Branch: feature/bundled-runtime（从 main @ 7caefe2 切出）

## Goal
目标机**无需安装 Node/npm**：下载本平台 Release 归档 → 解压 → 运行启动器，即得到仅本机可访问、可登录、PTY 可用的 squash 面板；且任何配置组合都不会在弱保护下对外监听。

## Scope
- 必须完成：
  - 阶段 0：弱保护判定改为按值（口令 = 众所周知默认值，或无任何认证），弱保护 + 显式非回环 HOST → 拒绝启动；`.env.example` 不再显式开放 `0.0.0.0`。
  - 阶段 1：打包时下载并校验（SHA-256）固定版本的官方 Node 24 运行时放入 `runtime/`；启动器只用包内运行时；清晰错误信息；最终归档在"PATH 无 node"环境下的冒烟脚本；CI 对最终归档跑冒烟、Release 附 `SHA256SUMS.txt`；中英 README。
- 明确不做：
  - Windows 安装器、Linux install.sh / systemd、程序与数据目录分离（阶段 2，另起任务）
  - SEA / pkg 单文件、Go 重写（阶段 3）；不合并 `feature/pkg`
  - 扩展 arm64 矩阵、发布 Docker 镜像
  - 真实 `rwr_server` 联调（列为剩余风险）
  - 工作区现有未跟踪 `dist-bin/`、`test-instances.json`（不碰、不暂存）

## Decisions
- 搁置 `feature/pkg`，走"便携包 + 包内官方 Node"路线 —— 维护面小：无 esbuild 打包、无 node-pty patch、无前端解压到 tmp；pkg 分支作为单文件实验样本保留（2026-09-29）
- 本次范围 = 报告阶段 0 + 1 —— 安装器依赖数据目录分离，体量大，另起任务（2026-09-29）
- 弱保护 + 显式非回环 HOST → 拒绝启动（exit 1 + 指引），HOST 未设 → 自动 127.0.0.1 —— 强制回环在 Docker 容器内会导致端口映射后不可达，报错更清晰（2026-09-29）
- "弱保护" = 登录启用且密码等于内置默认值 `admin`（不论是否显式写入），或完全无认证（登录禁用且无 AUTH_TOKEN）—— 原实现只看变量是否未设置，`cp .env.example .env` 即绕过（2026-09-29）
- 弱保护判定：密码 trim + 忽略大小写后等于 `admin` 或为空白也算默认 —— 审查发现 `Admin`/空格同样可猜；不扩展成通用弱口令黑名单（服务端无法判断强度，文档如实说明）（2026-09-29）
- "HOST 未设 → 127.0.0.1" 仅指弱保护情形；非弱保护 + HOST 未设 → `0.0.0.0` 为既有行为，保持不变（2026-09-29）
- Node 版本由仓库根 `.node-version` 固定，CI `setup-node` 与打包下载同读此文件 —— 构建与包内运行时一致（2026-09-29）
- 运行时哈希钉在仓库 `scripts/node-runtime.sha256`（SHASUMS256 格式、按带版本号的文件名索引），不在构建时拉官方 SHASUMS —— 构建可复现、镜像无法替换二进制；升级 `.node-version` 而忘更新哈希时打包直接失败（2026-09-29）
- `SQUASH_NODE_MIRROR` 可换下载源（如 npmmirror），哈希钉仍生效 —— 国内/代理网络可用（2026-09-29）
- 打包前拒绝把 `frontend/.env*` 的 `VITE_API_URL`/`VITE_WS_URL`/`VITE_AUTH_TOKEN` 烘焙进产物，按 Vite 优先级计算生效值；`VITE_API_URL= npm run package` 可在不动开发者文件的情况下覆盖；`SQUASH_ALLOW_FRONTEND_ENV=1` 显式放行 —— 审查发现本机打包会把 dev 地址 `localhost:4747` 写进前端（原有缺陷）（2026-09-29）
- 回环地址白名单：`127.0.0.0/8`、`localhost`、`::1` —— 其余（含 `0.0.0.0`、`::`、局域网 IP、`[::1]`/`::ffff:127.x`/zone 写法）视为非回环，拒绝而非信任罕见写法（2026-09-29）

## Acceptance
- 成功路径：
  - 在 PATH 中无 `node` 的环境，解压本平台最终归档（解压路径含空格与中文）→ 经 `start.sh` / `start.bat` 启动 → 日志显示绑定 `127.0.0.1` → `GET /api/health` 200 → `GET /` 返回前端 HTML → `admin/admin` 登录成功 → 创建 shell 实例并启动 → 经 WebSocket 收到输入标记的回显、经 `POST /api/instances/:id/command`（captureMs）捕获到标记 → 停止实例 → 终止服务后进程退出。
  - 复制 `.env.example` 为 `.env` 后启动，仍只绑定回环。
  - 强口令 + `HOST=0.0.0.0` → 绑定 `0.0.0.0`（显式开放仍可用）。
- 失败/边界路径：
  - 默认口令（未设或显式 admin/admin）+ `HOST=0.0.0.0` → 退出码非 0，日志含设置 `AUTH_USERNAME`/`AUTH_PASSWORD` 的指引。
  - `AUTH_PASSWORD=` 空且无 `AUTH_TOKEN` + `HOST=0.0.0.0` → 同上拒绝。
  - 默认口令 + `HOST=localhost` 或 `::1` → 允许启动。
  - 包内 `runtime/` 缺失 → 启动器输出明确错误并非 0 退出（Windows 双击时窗口不闪退）。
  - 端口被占用 → 日志给出"端口已被占用，改 PORT"类提示。
  - 下载的 Node 归档 SHA-256 与官方 SHASUMS256.txt 不符 → 打包失败。
- 不允许发生：
  - 打包把构建机 PATH 里任意 `node` 当作包内运行时。
  - 发布包含 `.env`。
  - 冒烟未通过的平台包进入 Release。
  - 弱保护下监听非回环地址。

## Evidence
- 自动检查：
  - `npm run typecheck`
  - `npm run build`
  - `npm run package`（本机 darwin-arm64）
  - `npm run smoke:release`（对 `release/` 下本平台归档）
  - 门禁矩阵：`npx tsx src/index.ts` 在上述 env 组合下的退出码与绑定地址
- 人工检查：
  - push 分支后观察 GitHub Actions 三平台 job（需单独授权 push）
  - Windows 干净机（无 Node）双击 `start.bat`：窗口不闪退、浏览器可登录
  - 真实 `rwr_server` 联调（本任务外，剩余风险）
- 高风险 diff（需你阅读第一手 diff）：`src/api/http/auth.ts`、`src/index.ts`（绑定门禁）、`scripts/package.mjs`（下载与校验）、`.github/workflows/release.yml`

## Checkpoints
- [x] 1. 安全门禁：按值判定弱保护；弱保护 + 显式非回环 → exit 1；`.env.example` 注释掉 HOST；Dockerfile/README 相关说明同步
      证据：`npm run typecheck` → 通过；门禁矩阵（tsx，23 组 env）→ 23/23；`node dist/index.js` + HOST=0.0.0.0 → exit 1、fatal 日志；复制 `.env.example` 为 `.env` → 仅 127.0.0.1（lsof）；Diff + Conformance 审查发现已修（trim/大小写、白名单收紧、fatal 级、Docker 示例随机密码）；用户已阅 diff ｜ commit：见 git log（feat(auth) refuse non-loopback…）
- [x] 2. 包内运行时：`.node-version`；下载 + SHA-256 校验 + 缓存；`runtime/` + LICENSE + `build-info.json`；启动器改用包内 node 并处理缺失/出错；监听错误友好提示；本机 `npm run package` 成功
      证据：`npm run typecheck` rc=0；`VITE_API_URL= npm run package` → 下载/缓存 v24.21.0 darwin-arm64、哈希校验通过、产物前端无 `localhost:4747`；前端 env 守卫 4 拒 1 放；运行时负向脚本 5/5 + 不可达镜像报 ECONNREFUSED 与代理提示；6 条哈希与官方 SHASUMS256 逐行一致；解压包在无 node 的 PATH 下经 start.sh 冒烟 19/19；只读 logs、端口占用、runtime 缺失均 exit 1 且提示明确；Diff + Conformance 审查发现已修（gitignore 粘行、bat `%~dp0`/pushd/Ctrl+C、System32 tar、fetch cause、写入探测、EACCES 平台化、压缩失败退出、build-info dirty）。未证：start.bat 在 Windows 实跑（→ cp4 CI + 人工） ｜ commit：见 git log（feat(package) bundle pinned Node runtime…）
- [ ] 3. 最终归档冒烟：`scripts/smoke-release.mjs` + `npm run smoke:release`，覆盖 Acceptance 成功路径与门禁拒绝用例；本机通过
      证据： ｜ commit：
- [ ] 4. CI：`setup-node` 读 `.node-version`；Package 后跑冒烟；release job 生成并上传 `SHA256SUMS.txt`
      证据： ｜ commit：
- [ ] 5. 文档：README.md / README.zh-CN.md —— 无 Node 前置、下载选择与校验、默认仅本机、远程访问步骤、门禁行为、升级时保留 `config/` `logs/`、平台支持边界；升级破坏性变化提示（旧 `.env` 含 `HOST=0.0.0.0`+admin、Docker 未传密码 → 启动即退出）；"仅 token 鉴权"配置方式（`AUTH_PASSWORD=` 空 + `AUTH_TOKEN`）
      证据： ｜ commit：

## Pitfalls
### Pitfall: Vite 在 production 构建也读 `frontend/.env.local`
- 现象：本机 `npm run package` 产物前端 API 指向 `http://localhost:4747/api`
- 状态：CONFIRMED
- 原因：Vite 所有模式都加载 `.env.local`；前端 `VITE_API_URL ?? ''` 取值
- 已否决：`--mode` 切换（`.env.local` 仍加载）
- 来源：`frontend/src/services/apiService.ts:6`、`scripts/package.mjs` 守卫
- 下一步：打包前守卫；空环境变量可覆盖文件值（已实测 Vite 8）

### Pitfall: `VITE_WS_URL` 置空不会回落同源
- 现象：空串经 `??` 保留为 ''，WebSocket 地址失效
- 状态：CONFIRMED（静态）
- 来源：`frontend/src/services/terminalService.ts:25`
- 下一步：守卫对 `VITE_WS_URL` 空值同样拒绝，需从文件删除

### Pitfall: 仓库文件末尾无换行，追加内容粘行
- 现象：`.gitignore` 变成 `.cursor//.cache/`，两条规则都失效
- 状态：CONFIRMED
- 下一步：追加前检查末尾换行，用 `git check-ignore -v` 验证

## Sources
- 调研报告（用户提供，2026-09-29）：阶段 0/1、CI/CD 建议、风险表
- `src/api/http/auth.ts:17` 原默认口令判定；`src/index.ts:26` 原 HOST 解析
- `scripts/package.mjs`、`.github/workflows/release.yml`、`Dockerfile`、`.env.example`
- `node_modules/node-pty/prebuilds/*`（N-API prebuilds，6 平台）
- Node 官方分发：`https://nodejs.org/dist/v<ver>/SHASUMS256.txt`
- `feature/pkg` @ 4d3be41（单文件实验，不合并）
