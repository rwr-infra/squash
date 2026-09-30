# 降低部署难度：安全默认值 + 自带 Node 运行时的便携包

- 日期：2026-09-29
- 风险：高（认证/监听门禁、发布链）
- Commits：7caefe2..c7e3246（分支 `feature/bundled-runtime`：6aabe3e、53eefa2、a3a7332、dd98cbd、c7e3246）
- 相关 ADR：[0001 便携包 + 固定 Node 运行时](../adr/0001-portable-bundle-with-pinned-node-runtime.md)

## 结果
Release 归档（win32-x64 / linux-x64 / darwin-arm64）自带固定版本官方 Node，目标机解压即用、无需装 Node；弱保护下服务端绝不监听非回环地址。CI 三平台对最终归档冒烟（27 项）通过后才可能发布，Release 附 `SHA256SUMS.txt`。

## 关键决策
| 决策 | 原因 | 否决方案及原因 |
| --- | --- | --- |
| 便携包 + 固定运行时（见 ADR 0001） | 零代码改动、维护面小 | pkg 单文件（需 esbuild + node-pty patch + 前端解压）、SEA、Go 重写 |
| 弱保护 = 密码 trim+忽略大小写后为 `admin` 或空白，或完全无鉴权 | 原实现只看变量是否设置，`cp .env.example .env` 即绕过 | 通用弱口令黑名单（服务端无法判断强度，文档如实说明） |
| 弱保护 + 显式非回环 HOST → 拒绝启动（fatal + exit 1）；HOST 未设 → 127.0.0.1 | 强制回环会让 Docker 端口映射静默失效 | 强制回环 + 警告 |
| 回环白名单仅 `127.0.0.0/8`、`::1`、`localhost` | 罕见写法（`[::1]`、`::ffff:127.x`）拒绝而非信任 | 规范化后放行（`[::1]` 实际 listen 失败） |
| 运行时哈希钉在仓库 `scripts/node-runtime.sha256`，版本单一来源 `.node-version`（CI setup-node 同读） | 可复现；镜像（`SQUASH_NODE_MIRROR`）无法换二进制 | 构建时拉 SHASUMS256.txt；复制构建机 `node` |
| 打包拒绝烘焙 `frontend/.env*` 的 `VITE_API_URL`/`VITE_WS_URL`/`VITE_AUTH_TOKEN` | 本机打包曾把 dev 地址 `localhost:4747` 写进前端 | 仅靠文档提醒 |
| Release 先 draft、上传完再公开；每平台 artifact 恰一个归档 | 不出现无资产的公开 Release、不夹带未测文件 | 直接 create 后 upload |

## 确立的规范
- 打包：`npm run package` → `npm run smoke:release`；发布前冒烟测的是**最终归档**（解压、PATH 无 node、经启动器），不是暂存目录。
- 包内运行时只来自钉住哈希的官方归档；升级 Node 必须同时改 `.node-version` 与 `scripts/node-runtime.sha256`。
- 服务端监听地址只经 `resolveBindHost`（`src/app/bind-host.ts`）决定；新增认证方式时同步更新 `isWeaklyProtected`（`src/api/http/auth.ts`）。
- 启动失败走 `logger.fatal` + 可操作的 `msg`（端口占用/保留、目录不可写、拒绝监听），不吞在 JSON `err` 里。
- Windows 上调用 tar 用 `tarCommand()`（System32 bsdtar）；非 ASCII 目标目录用 `cwd` 传，不用 `-C`。
- start.bat：开头一次性捕获 `%~dp0`、用 `pushd`、括号块内不展开路径、CRLF。start.sh：POSIX sh、`exec` 包内 node。
- 冒烟断言需经变异测试证明能失败；进程退出等 `'close'` 而非 `'exit'`，并探测端口已释放。

## Pitfalls
- Vite 在 production 构建也加载 `frontend/.env.local` → 打包守卫；空环境变量（`VITE_API_URL=`）能覆盖文件值，但 `VITE_WS_URL` 置空会因 `??` 失效。
- 追加内容到末尾无换行的文件会粘行（`.gitignore` 曾变成 `.cursor//.cache/`）→ 追加前检查末尾换行，用 `git check-ignore -v` 验证。
- `fetch()` 不走 `HTTPS_PROXY`（需 `NODE_USE_ENV_PROXY=1`），且错误原因在 `err.cause`。
- Windows `fs.access(dir, W_OK)` 对目录恒成功 → 用真实写入探测。
- Windows 系统 tar 按 ANSI 代码页转换 argv，CJK `-C` 路径会损坏（libarchive#2092）。
- cmd：`cd` 后 `%~dp0` 可能按新 cwd 重解析；`cmd /s /c` 只剥一层引号，含空格路径需 `""path""`。

## 剩余风险 / 后续
- **手动 Stop 可能被判 `crashed` 并被自动重启**（`autoRestart` 默认开）：`instance-supervisor.ts` onData 无条件把状态设回 `running`，覆盖 `stopping`。真实 rwr_server 停服会打印日志，极可能触发 → 另起任务修复。
- 真实 `rwr_server` 未联调；Windows 桌面双击 start.bat（失败暂停、SmartScreen/防火墙提示）未人工验证（CI 以 `SQUASH_NO_PAUSE=1` 运行）。
- `AUTH_TOKEN` 不检查强度（非空即视为强保护）；token-only 下 Web UI 不可用。
- start.sh 经符号链接调用会找不到 `runtime/`；Dockerfile `node:24-slim` 不跟随 `.node-version`；发布包未代码签名；macOS 浏览器下载可能被 quarantine。
- 未做：Windows 安装器、Linux install.sh/systemd、程序与数据目录分离（报告阶段 2）；arm64 矩阵。

## 指针
- 门禁：`src/app/bind-host.ts`、`src/api/http/auth.ts`、`src/index.ts`
- 打包：`scripts/package.mjs`、`scripts/node-runtime.mjs`、`scripts/node-runtime.sha256`、`.node-version`
- 冒烟：`scripts/smoke-release.mjs`（`npm run smoke:release`）
- CI：`.github/workflows/release.yml`
- 用户文档：`README.md` / `README.zh-CN.md`「Portable distribution / 便携发行包」「Authentication / 鉴权」
