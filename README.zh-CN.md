# squash

> 中文说明 | [English](README.md)

> [!WARNING]
> **开发中**:本项目尚处于早期阶段,应被视为**不稳定**。功能可能在没有预先通知的情况下变更或失效。

**squash** 是 [rwr-infra](https://github.com/rwr-infra) 组织下的社区项目——一个面向 Running with Rifles(`rwr_server`)游戏服务器的终端代理工具,用于多实例管理,类似于 MCSManager。

## 免责声明

**squash** 是 [rwr-infra](https://github.com/rwr-infra) 组织下由社区驱动的项目,**与 Osumia Games 无任何隶属、授权、维护、赞助或背书关系**。

所有 **Running With Rifles** 相关的内容、资源与商标——包括但不限于本工具所解析的游戏数据——均为 **Osumia Games** 的独有财产。本工具仅作为社区资源提供,用于与原始安装所提供的游戏文件进行交互。

## 功能特性

- **基于 PTY 的终端转发**——完整捕获 `rwr_server` 实例的 stdin/stdout
- **多实例管理**——以独立工作目录运行多个游戏服务器实例
- **实时终端流**——基于 WebSocket + xterm.js 的终端
- **实例生命周期管理**——启动、停止、重启、删除实例
- **有上限的优雅停止**——按实例配置控制台停止命令(如 `quit`)、停止超时后强制结束、重启会等旧进程退出、squash 退出前先停掉所有实例(见[停止](#停止))
- **崩溃自动重启**——按实例可选开启,带指数退避、最大重试次数上限,以及在稳定运行一段时间后重置计数器的冷却机制
- **Windows 崩溃弹窗恢复**——检测引擎生成的 `rwr_crashdump.dmp`,强制结束卡在「未处理异常」弹窗后面的进程,使自动重启仍能触发
- **带时间戳的日志**——按实例分文件、按行缓冲输出的日志

## 技术栈

**后端**:Node.js 24 + TypeScript + Fastify + node-pty + Zod + Pino
**前端**:React + Vite + Ant Design + xterm.js + TanStack Query

## 项目结构

```
squash/
├── src/                    # 后端
│   ├── core/pty/          # PTY 适配器
│   ├── core/instance/     # 实例管理器(supervisor)与注册表(registry)
│   ├── core/log/          # 日志写入器与输出解析器
│   ├── services/          # 业务逻辑
│   └── api/               # HTTP + WebSocket 接口
├── frontend/              # 前端(React + Vite)
├── scripts/               # 开发脚本(PTY 冒烟测试、打包)
├── config/                # 实例配置(instances.json)
├── Dockerfile             # 容器镜像
└── LICENSE
```

## 快速开始

### 环境要求

- **发行包:无需任何依赖。** 每个发行包都自带 Node.js 运行时——下载、解压、运行即可
  (见[便携发行包](#便携发行包无需-nodejs))。
- **从源码运行:** [Node.js](https://nodejs.org/en/download) 24。CI 与发行包使用的确切版本
  固定在 [`.node-version`](.node-version) 中。
- Docker——可选,用于容器化部署
- CI 在 Linux、macOS、Windows 上用普通 shell 冒烟测试 PTY 往返;真实 `rwr_server` 已在 Windows Server 上人工验证过,Linux 尚未验证,macOS 存在已知的 node-pty 问题(见「已知问题」)

### Docker(推荐)

```bash
# 构建镜像
docker build -t rwr-infra/squash .

# 运行容器。必须设置 AUTH_PASSWORD:镜像监听 0.0.0.0,而默认密码下服务器拒绝在非回环地址启动。
# 生成一个随机密码并记下打印出的值——它就是登录密码。
SQUASH_PASSWORD="$(openssl rand -hex 16)"; echo "squash password: $SQUASH_PASSWORD"
docker run -d \
  --name squash \
  --stop-timeout 20 \
  -p 3000:3000 \
  -e AUTH_USERNAME=admin \
  -e AUTH_PASSWORD="$SQUASH_PASSWORD" \
  -v squash-data:/app/config \
  -v squash-logs:/app/logs \
  rwr-infra/squash
```

然后打开 `http://localhost:3000`。

`--stop-timeout 20` 不能省:`docker stop` 时 squash 会先停掉所有实例,最长需要各实例停止超时的最大值
(默认 15 秒)再加 2 秒,而 Docker 默认只给 10 秒宽限,之后直接强杀全部进程。使用 Compose 时写
`stop_grace_period: 20s`;如果配置了更长的停止超时,两者都要相应调大(见[停止](#停止))。

### Docker 环境变量

与下方 [配置(`.env`)](#配置env) 一节相同
(`PORT`、`HOST`、`LOG_LEVEL`、`AUTH_USERNAME`、`AUTH_PASSWORD`、`AUTH_TOKEN`、`CORS_ORIGIN`)。
镜像中 `HOST` 默认为 `0.0.0.0`(因此容器内不会回退到回环地址——没有非默认的 `AUTH_PASSWORD` 就拒绝启动),
`SQUASH_STATIC_DIR` 默认为 `/app/frontend/dist`。将 `/app/config` 与
`/app/logs` 挂载为数据卷以持久化实例配置和日志。

### 开发模式

```bash
npm install
npm run dev          # tsx watch——运行 src/index.ts 并在变更时热重载
```

### 生产模式(编译)

服务器会被编译为纯 JavaScript 并用 `node` 运行(运行时不再依赖 `tsx`):

```bash
npm install
npm run build        # 将服务器编译到 dist/,将前端编译到 frontend/dist/
npm start            # node dist/index.js
```

### 配置(`.env`)

服务器启动时会自动从工作目录加载 `.env` 文件
(通过 Node 内置的 env-file 加载器——无需额外依赖)。复制模板并编辑:

```bash
cp .env.example .env
```

环境变量(全部可选;可通过 `.env` 或真实环境变量设置):

| 变量 | 默认值 | 说明 |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP 服务器端口 |
| `HOST` | _(自动)_ | 绑定地址。未设置时:面板处于**弱保护**(密码为默认值 `admin`(不区分大小写)、为空白,或完全没有鉴权)则绑定 `127.0.0.1`,否则绑定 `0.0.0.0`。弱保护下显式设置非回环 `HOST`(如 `0.0.0.0`)会使服务器**拒绝启动**——请先设置强 `AUTH_PASSWORD`。回环地址(`127.x.x.x`、`localhost`、`::1`)始终允许。 |
| `LOG_LEVEL` | `info` | Pino 日志级别 |
| `AUTH_USERNAME` | `admin` | 登录用户名。登录**默认开启**(admin/admin);暴露服务器前请修改。 |
| `AUTH_PASSWORD` | `admin` | 登录密码。 |
| `AUTH_TOKEN` | _(无)_ | 可选的静态 bearer token(与登录并存;遗留方式) |
| `CORS_ORIGIN` | `*` | API 允许的 CORS 源 |
| `SQUASH_STATIC_DIR` | _(应用同级目录)_ | 前端静态文件路径(自动推导;仅在你迁移了 `frontend/dist` 时才需覆盖) |

### 鉴权

登录**默认开启**,凭据为 `admin` / `admin`。这是有意为之:解压即用的实例不应被
第一个访问到该端口的人直接驱动。这两个默认值是公开的弱口令,因此**暴露服务器前请务必修改**——
作为兜底,只要密码仍是 `admin`(无论未设置还是显式写入,例如直接复制了 `.env.example`),
或完全没有配置鉴权,服务器就只监听回环地址:未设置 `HOST` 时回退为 `127.0.0.1`,
显式设置非回环 `HOST` 则启动报错退出(见 `HOST`)。默认密码生效时,启动日志会打印一条警告。

登录(`POST /api/auth/login`)会签发一个会话 token(有效期 7 天,保存在内存中——重启服务器会使会话失效)。
前端将 token 存入 `localStorage`,并以 `Authorization: Bearer <token>` 形式发送
(终端 WebSocket 则通过 `?token=` 查询参数传递)。

静态的 `AUTH_TOKEN` 仍会被接受,用于向后兼容/程序化访问,与登录并存。

**仅 token 鉴权(API/自动化):** 设置 `AUTH_PASSWORD=`(留空)关闭用户名/密码登录,并把
`AUTH_TOKEN` 设为一个足够长的随机值;客户端发送 `Authorization: Bearer <token>`。
这种方式下 Web 界面无法使用(没有输入 token 的地方,登录页也会拒绝所有尝试),所以有人通过
浏览器使用时请保留登录。服务器不检查 token 强度:`AUTH_TOKEN` 非空且未设置 `HOST` 时会监听
`0.0.0.0`。既没有密码也没有 token 时 API 完全开放——此时服务器拒绝任何非回环 `HOST`。

> **从旧版本升级:** 当 `HOST` 为非回环地址、而密码仍是 `admin` 或未配置任何鉴权时,
> 服务器现在会拒绝启动(退出码 1,日志含 `Refusing to listen on …`)。受影响的情形:
> 从旧版 `.env.example` 复制的 `.env`(当时写了 `HOST=0.0.0.0` 和 `admin/admin`),以及
> 未传 `AUTH_PASSWORD` 的 `docker run`。请设置强 `AUTH_PASSWORD`,或删除 `HOST` 仅供本机使用。
> 同样地,未设置 `HOST` 时,在 `.env` 里显式写 `admin` 密码(或完全没有鉴权)现在只监听
> `127.0.0.1`——以前会监听 `0.0.0.0`。

### 审计日志

用户操作会记录到 `logs/audit.log`(JSONL 格式),并通过 `GET /api/audit` 暴露。
记录的操作有:`login`、`create`、`start`、`stop`、`restart`、`delete` 和 `command`
(`command` 会捕获通过终端「快捷命令框」发送的命令文本)。每条记录包含
`time`、`user`、`action`,以及可选的 `instanceId` / `detail`。Web UI 在实例列表页的
**审计日志(Audit log)** 抽屉中展示这些记录。

### 便携发行包(无需 Node.js)

每个 [GitHub Release](https://github.com/rwr-infra/squash/releases) 为每个平台提供一个归档。
归档内自带固定版本的 Node.js 运行时(`runtime/`),目标机器**无需安装 Node.js、npm 或构建工具**。

| 平台 | 归档 | 说明 |
|------|------|------|
| Windows x64 | `squash-<ver>-win32-x64.zip` | Windows 10/11、Server 2019+(需要 ConPTY);CI 在 Windows Server 2025 上测试 |
| Linux x64 | `squash-<ver>-linux-x64.tar.gz` | glibc 2.28+(如 Debian 10+、Ubuntu 20.04+、RHEL 8+);不支持 Alpine/musl |
| macOS Apple 芯片 | `squash-<ver>-darwin-arm64.tar.gz` | 尽力支持——见「已知问题」 |

其他平台(linux-arm64、win32-arm64、darwin-x64)已固定运行时校验和,可在对应平台上用
`npm run package` 自行构建,但不随 Release 发布,CI 也未覆盖。

1. **校验**下载文件,对照同一 Release 中的 `SHA256SUMS.txt`:
   - Linux:`grep linux-x64 SHA256SUMS.txt | sha256sum -c`
   - macOS:`grep darwin-arm64 SHA256SUMS.txt | shasum -a 256 -c`
   - Windows(PowerShell):`(Get-FileHash .\squash-<ver>-win32-x64.zip).Hash`——与对应行比对(不区分大小写)。
2. **解压**到一个当前用户可写的新空目录——归档没有顶层目录,`config/` 和 `logs/` 会创建在其中
   (所以不要放在 `C:\Program Files`)。Windows:右键 →「全部解压缩…」到例如 `C:\squash`。
   Linux/macOS:`mkdir squash && tar -xzf squash-<ver>-<platform>-<arch>.tar.gz -C squash`。
3. **启动**:Windows 上双击 `start.bat`(启动失败时窗口会暂停,便于阅读错误);Linux/macOS 上运行
   `./start.sh`。按 Ctrl+C 或关闭窗口停止:squash 会先停掉所有运行中的实例(见[停止](#停止))。使用默认的 `admin/admin` 登录时只监听 `127.0.0.1`。打开
   `http://localhost:3000`。
4. **如需暴露到网络**,用模板创建 `.env`(Windows 上 `copy .env.example .env`,其他平台
   `cp .env.example .env`——记事本可能会存成 `.env.txt`),将 `AUTH_USERNAME` 和 `AUTH_PASSWORD`
   **同时**设置为强口令并重启。只有密码不再是 `admin`,服务器才会监听 `0.0.0.0`(见[鉴权](#鉴权));
   请在防火墙中放行该端口(Windows 首次启动时会询问)。若可被可信局域网以外访问,请放在带 TLS 的
   反向代理之后。

启动出错时进程以非 0 退出码退出,日志中该行的 `msg` 会说明如何处理——端口已被占用(或被 Windows
保留)、目录不可写、缺少 `runtime/` 目录。`build-info.json` 记录了源码 commit 以及内置的 Node.js 与
node-pty 版本,便于排查问题。

**升级:** 数据保存在 squash 目录内的 `config/`(实例定义)、`logs/`(实例日志与审计日志)和 `.env` 中。
请把游戏服务器文件放在 squash 目录**之外**,并给实例使用绝对路径的 `cwd`,使其不依赖 squash 目录。
先停止运行中的实例和 squash,把新版本解压到一个**新**目录,从旧目录复制这三项过去,再启动新版本。
在新版本跑通之前保留旧目录——回滚就是重新启动旧版本。(此前版本的启动脚本会强制 `PORT=3000`;
现在 `.env` 中的 `PORT` 会生效。)

**自行构建发行包**(需在目标操作系统/架构上构建——node-pty 按平台提供预编译原生二进制):

```bash
npm run package          # 构建服务器与前端,为当前操作系统/架构打包 → release/
npm run smoke:release    # 解压归档,按用户的实际使用方式进行测试
```

- 打包时会下载 `.node-version` 指定的 Node.js,并用
  [`scripts/node-runtime.sha256`](scripts/node-runtime.sha256) 中固定的 SHA-256 校验
  (缓存在 `.cache/node-runtime/`)。在代理后面请设置 `NODE_USE_ENV_PROXY=1`(配合 `HTTPS_PROXY`),
  或使用镜像:`SQUASH_NODE_MIRROR=https://npmmirror.com/mirrors/node`——固定的校验和依然生效。
- 如果 `frontend/.env*`(或环境变量)设置了 `VITE_API_URL`、`VITE_WS_URL` 或 `VITE_AUTH_TOKEN`,
  打包会中止,因为 Vite 会把它们写进产物。打包期间请把开发用的 `frontend/.env.local` 移开。
  (如果它只设置了 `VITE_API_URL`,也可以在 POSIX shell 中运行 `VITE_API_URL= npm run package`;
  空的 `VITE_WS_URL` 仍会被拒绝,因为它会导致 WebSocket 失效。)
- 升级 Node.js 时,修改 `.node-version`,替换 `scripts/node-runtime.sha256` 中的哈希行
  (文件头部给出了命令),然后运行 `npm run package && npm run smoke:release`。Docker 镜像
  (`node:24-slim`)不跟随 `.node-version`。

### 跨平台构建(CI)

[`.github/workflows/release.yml`](.github/workflows/release.yml) 在 `ubuntu-latest`、`macos-latest`、
`windows-latest` 上使用 `.node-version` 指定的 Node.js 构建。每个任务先运行 `npm run package`,再对
**最终归档**运行 `npm run smoke:release`(解压到含空格与非 ASCII 字符的路径、无系统 Node、经启动脚本启动):
健康检查、前端、登录、PTY 往返、默认仅回环、弱口令拒绝启动,以及终止启动脚本后服务退出并释放端口。推送 `v*` 标签时,只有所有平台
都通过才会发布 GitHub Release;Release 附带各归档与 `SHA256SUMS.txt`。

### 前端(开发)

```bash
cd frontend
npm install

# 让前端指向后端(必须同时设置两项——API 和 WebSocket)
echo "VITE_API_URL=http://localhost:3000" > .env.local
echo "VITE_WS_URL=ws://localhost:3000" >> .env.local

npm run dev
```

前端开发服务器运行在 `http://localhost:5173`。开启登录后,你通过应用的登录页登录
(`.env.local` 中无需 token——它在登录时获取并存入 `localStorage`)。
对于静态 token 的部署方式,`VITE_AUTH_TOKEN` 仍作为后备被支持。

> 在前后端分离的开发模式下,需**同时**将 `VITE_API_URL` 和 `VITE_WS_URL` 设为后端的源。
> 如果缺少 `VITE_WS_URL`,它会回退到页面自身的源(同源生产部署时正确,但当开发后端
> 在不同端口时则错误)。

### 快速测试

```bash
# 健康检查
curl http://localhost:3000/api/health

# 创建一个测试实例
curl -X POST http://localhost:3000/api/instances \
  -H "Content-Type: application/json" \
  -d '{
    "id": "test-1",
    "name": "Test Server",
    "cwd": "/tmp",
    "executable": "sleep",
    "args": ["10"],
    "logDir": "logs"
  }'

# 启动它
curl -X POST http://localhost:3000/api/instances/test-1/start

# 列出实例
curl http://localhost:3000/api/instances
```

> 开启登录后,请加上 `-H "Authorization: Bearer <token>"`(token 从 `POST /api/auth/login` 获取)。

## API 接口

所有后端接口都挂在 `/api` 前缀下;其余路径都交给 SPA(前端单页应用)。

| 方法 | 路径 | 鉴权 | 说明 |
|--------|------|------|-------------|
| GET | `/api/health` | 公开 | 健康检查 |
| GET | `/api/auth/status` | 公开 | 是否需要登录(`{ loginEnabled }`) |
| POST | `/api/auth/login` | 公开 | 用 `{ username, password }` 登录 → `{ token }` |
| GET | `/api/auth/me` | 是 | 当前 token 对应的用户 |
| POST | `/api/auth/logout` | 是 | 使当前会话 token 失效 |
| GET | `/api/instances` | 是 | 列出所有实例 |
| POST | `/api/instances` | 是 | 创建实例 |
| GET | `/api/instances/:id` | 是 | 获取实例详情 |
| PUT | `/api/instances/:id` | 是 | 更新实例配置(必须处于 stopped/crashed 状态) |
| DELETE | `/api/instances/:id` | 是 | 删除实例 |
| POST | `/api/instances/:id/start` | 是 | 启动实例 |
| POST | `/api/instances/:id/stop` | 是 | 停止实例;可选请求体 `{"force": true}` 会强制结束已处于 `stopping` 的实例(见[停止](#停止)) |
| POST | `/api/instances/:id/restart` | 是 | 重启实例:等旧进程退出后再启动 |
| POST | `/api/instances/:id/command` | 是 | 向实例的 stdin 发送命令 |
| GET | `/api/instances/:id/logs/tail` | 是 | 拉取实例日志末尾 |
| GET | `/api/audit` | 是 | 最近的审计日志条目(`?limit=`) |

「鉴权:是」的接口在配置了登录(或 `AUTH_TOKEN`)时,需要 `Authorization: Bearer <token>`。

### 发送命令

`POST /instances/:id/command` 会将命令转发到运行中实例的 stdin
(与交互式终端是同一通道)。适合程序化地下发游戏内控制台命令,例如 `status`。

```bash
# 即发即弃(默认会追加一个 \r)
curl -X POST http://localhost:3000/api/instances/test-1/command \
  -H "Content-Type: application/json" \
  -d '{ "command": "status" }'

# 在指定时间窗口(毫秒)内捕获产生的输出并返回
curl -X POST http://localhost:3000/api/instances/test-1/command \
  -H "Content-Type: application/json" \
  -d '{ "command": "status", "captureMs": 1500 }'
```

| 字段 | 默认值 | 说明 |
|-------|---------|-------------|
| `command` | _(必填)_ | 命令字符串 |
| `appendNewline` | `true` | 追加 `\r`(设为 `false` 则写入原始字节) |
| `captureMs` | _(无)_ | 若 > 0,则采集这么多毫秒的 stdout(上限 10000)并作为 `data.output` 返回;否则返回 `data.accepted: true` |

> 注意:PTY 是单一输出流,因此被捕获的输出可能混入无关的周期性日志,
> 并非严格的请求/响应对应关系。它适用于像 `status` 这类快速回显的控制台命令。

WebSocket(终端流):`ws://localhost:3000/api/terminal/:instanceId?token=<token>`

## Windows 部署

当 `rwr_server.exe` 在 Windows 上崩溃时,RWR **引擎自带的崩溃处理器**会先写出一个
转储文件(`rwr_crashdump.dmp`),然后弹出一个模态对话框 **「An unhandled exception
occurred!」**(内存不足时是 `bad allocation` 那一种)。此时进程会**卡死**在这个弹窗的
消息循环里——它不会自行退出,所以 `onExit` 永远不会触发,普通的自动重启也就无从触发。

> 注意:这**不是** Windows 错误报告(WER)的弹窗。异常在到达 WER 之前就被引擎自己的
> 处理器接住了,所以抑制 WER(改注册表之类)对它毫无作用。

squash 的处理方式是**检测崩溃转储文件**:引擎在崩溃时会把 `rwr_crashdump.dmp` 写到
服务器**同一工作目录**(实例的 `cwd`)下。对开启了 `autoRestart` 的实例,squash 的看门狗
每隔几秒检查该文件;一旦发现一个**比本次启动更新**的转储,就强制结束卡死的进程树
(`taskkill /T /F`,它能终结一个卡在 `MessageBox` 里的进程),然后自动重启。

无论弹窗是哪种类型,你也可以随时手动恢复:**「停止(Stop)」**或**「重启(Restart)」**会用同样的
`taskkill /T /F` 结束卡死的进程——没有配置停止命令的实例立即结束,配置了的在停止超时后结束;
**「强制停止(Force stop)」**(实例处于 `stopping` 时的 Stop 按钮)则立即结束。

## 停止

一次停止——**Stop** 按钮、**Restart**,或 squash 自身关停——最终一定是进程退出、实例落到 `stopped`:

1. squash 先请服务器自行退出:在控制台里输入该实例的**停止命令**;没有配置时用平台默认方式——
   Linux/macOS 发送 SIGHUP,Windows 立即 `taskkill /T /F`(Windows 上没有更温和的信号)。
2. 超过**停止超时**进程仍未退出,squash 就强制结束它及其启动的所有进程(向进程组发 SIGKILL;
   Windows 上 `taskkill /T /F`),并在实例日志里写入 `[squash] stop timed out after <n>ms; force-killing`。

按实例配置(实例表单,或创建/更新 API):

| 字段 | 默认值 | 含义 |
|------|--------|------|
| `stopCommand` | 无 | 让服务器关闭的控制台命令,每行一条,逐条发送并回车,行与行之间间隔约 1 秒;第一条命令之后的空行只发送一次回车。留空 = 使用上面的平台默认方式。 |
| `stopTimeoutMs` | `15000` | 等待进程退出的时长,超过后强制结束(1000–600000),从发送第一行命令时开始计算。 |

**`rwr_server` 实例请把 `stopCommand` 设为 `quit` 加一个空行**——Windows 上也一样。`rwr_server` 收到 `quit`
后回复 `Exit requested`,还要再收到一次回车才会退出,空行就是这次回车;只填 `quit` 时它会一直等到停止超时
被强杀。完全不配置停止命令时,Windows 上的停止会立即强杀服务器,可能丢失自上次 `save_profiles` 以来的
玩家进度——想先保存,就写三行:`save_profiles`、`quit`、一个空行。

各行按固定时间表发送,每隔 1 秒一行,不会等服务器处理完上一行;停止超时从第一行开始计算,所以要比
「每多一行 1 秒」宽裕得多(不够时 squash 会在日志里警告)。表单会在输入框下方显示将要发送的内容,
包括结尾空行代表的那次回车。

- **强制停止**:实例处于 `stopping` 时,Stop 按钮变为 **Force stop**(需二次确认),立即结束进程。
  对应 API 是带 `{"force": true}` 的 `POST /api/instances/:id/stop`;`stopping` 中不带 force 的 Stop
  什么都不做,所以双击或页面状态过期都不会打断正在进行的优雅关停。
- **重启**走同样的停止流程,等旧进程退出后才启动新进程,不会出现新旧两个进程同时运行。实例处于
  `stopping` 时 Restart 不可用;重启等待期间点 Stop 会取消这次重启。
- **关停 squash**(Ctrl+C、关闭其窗口或终端、`docker stop`、SIGTERM)会以同样方式并行停止所有运行中的实例,
  然后以退出码 0 退出,最长耗时为各实例 `stopTimeoutMs` 的最大值加 2 秒。第一次 Ctrl+C 之后隔 1 秒以上
  再按一次,会强制结束剩下的实例并立即退出。Windows 上关闭控制台窗口时,系统只给约 5 秒就会结束 squash,
  实例随控制台一起退出。
- 放在反向代理后面时,**Restart** 请求会一直挂着,直到旧进程退出——最长为该实例的 `stopTimeoutMs`
  加 5 秒。代理的读超时要大于这个值(nginx 的 `proxy_read_timeout` 默认 60 秒);否则页面可能报
  重启失败,而服务器上的重启其实仍会完成。
- `nohup ./start.sh` 不能让 squash 在 SSH 会话结束后继续运行——squash 会把挂断当作关停请求。请改用
  `tmux`/`screen` 或服务管理器。systemd unit 需要 `KillMode=mixed`(默认的 `control-group` 会把 SIGTERM
  直接发给各实例)以及不小于「最长停止超时 + 5 秒」的 `TimeoutStopSec=`。

## 自动重启

创建实例时设置 `autoRestart: true`(可选地附带 `restartDelayMs`,默认 `3000`)。
当实例发生非预期退出(进入 `crashed`)时,squash 会以指数退避
(`restartDelayMs * 2^n`,上限 60 秒)重启它,最多连续尝试 5 次;之后实例保持 `crashed`。
一旦实例干净运行满 60 秒,尝试计数器就会重置。手动停止/重启总是会清零计数器。

## 已知问题

- **macOS `posix_spawnp failed`**:node-pty 的 spawn-helper 二进制文件在 macOS 上可能缺少执行权限。
  修复方法:`chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper`(使用 pnpm 的源码检出中为
  `node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/darwin-*/spawn-helper`)。Linux 不受影响。
- **macOS:用浏览器下载的发行包可能无法加载原生模块**——Gatekeeper 可能隔离仅 ad-hoc 签名的
  `pty.node` / `spawn-helper`。对解压后的目录清除该标记:`xattr -dr com.apple.quarantine <squash 目录>`。
- **Windows 上未配置 `stopCommand` 的停止就是立即强杀**:Windows 没有请控制台程序自行退出的信号,进程树会被
  立即结束,未保存的状态可能丢失。请配置停止命令(`rwr_server` 用 `quit` 加一个空行,见[停止](#停止))。
- **发行包未做代码签名**:Windows SmartScreen 可能在首次运行 `start.bat` 时给出警告。
- **针对真实 `rwr_server` 的运行时验证**只在 Windows Server 上人工做过;Linux 尚未用实际的游戏服务器二进制文件验证。

## 路线图

- [ ] 真实游戏服务器运行时验证(Linux)
- [x] 崩溃时的自动重启策略
- [ ] 通过解析 `status` 输出进行健康探测
- [ ] 日志轮转
- [ ] SQLite 配置存储(计划中)

## 许可证

MIT 许可证。详见 [LICENSE](LICENSE)。
