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
- **崩溃自动重启**——按实例可选开启,带指数退避、最大重试次数上限,以及在稳定运行一段时间后重置计数器的冷却机制
- **Windows 崩溃弹窗恢复**——检测引擎生成的 `rwr_crashdump.dmp`,强制结束卡在「未处理异常」弹窗后面的进程,使自动重启仍能触发
- **带时间戳的日志**——按实例分文件、按行缓冲输出的日志

## 技术栈

**后端**:Node.js 20 + TypeScript + Fastify + node-pty + Zod + Pino
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

- Node.js >= 24(唯一的运行时要求;支持 Linux、macOS 和 Windows)
- Docker——可选,用于容器化部署
- PTY 行为仅在 Linux 上验证过;macOS 存在已知的 node-pty 权限问题(见「已知问题」)

### Docker(推荐)

```bash
# 构建镜像
docker build -t rwr-infra/squash .

# 运行容器(带登录凭据)
docker run -d \
  --name squash \
  -p 3000:3000 \
  -e AUTH_USERNAME=admin \
  -e AUTH_PASSWORD=change-me \
  -v squash-data:/app/config \
  -v squash-logs:/app/logs \
  rwr-infra/squash
```

然后打开 `http://localhost:3000`。

### Docker 环境变量

与下方 [配置(`.env`)](#配置-env) 一节相同
(`PORT`、`HOST`、`LOG_LEVEL`、`AUTH_USERNAME`、`AUTH_PASSWORD`、`AUTH_TOKEN`、`CORS_ORIGIN`)。
镜像中 `SQUASH_STATIC_DIR` 默认为 `/app/frontend/dist`。将 `/app/config` 与
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
| `HOST` | `0.0.0.0` | 绑定地址 |
| `LOG_LEVEL` | `info` | Pino 日志级别 |
| `AUTH_USERNAME` | _(无)_ | 登录用户名——与 `AUTH_PASSWORD` 同时设置即可要求登录 |
| `AUTH_PASSWORD` | _(无)_ | 登录密码 |
| `AUTH_TOKEN` | _(无)_ | 可选的静态 bearer token(与登录并存;遗留方式) |
| `CORS_ORIGIN` | `*` | API 允许的 CORS 源 |
| `SQUASH_STATIC_DIR` | _(应用同级目录)_ | 前端静态文件路径(自动推导;仅在你迁移了 `frontend/dist` 时才需覆盖) |

### 鉴权

**同时**设置 `AUTH_USERNAME` 和 `AUTH_PASSWORD`,即可要求 Web UI 和 API 进行用户名/密码登录。
登录(`POST /api/auth/login`)会签发一个会话 token(有效期 7 天,保存在内存中——重启服务器会使会话失效)。
前端将 token 存入 `localStorage`,并以 `Authorization: Bearer <token>` 形式发送
(终端 WebSocket 则通过 `?token=` 查询参数传递)。

如果两个凭据都未设置,则鉴权**禁用**,访问完全开放。静态的
`AUTH_TOKEN` 仍会被接受,用于向后兼容/程序化访问。

### 审计日志

用户操作会记录到 `logs/audit.log`(JSONL 格式),并通过 `GET /api/audit` 暴露。
记录的操作有:`login`、`create`、`start`、`stop`、`restart`、`delete` 和 `command`
(`command` 会捕获通过终端「快捷命令框」发送的命令文本)。每条记录包含
`time`、`user`、`action`,以及可选的 `instanceId` / `detail`。Web UI 在实例列表页的
**审计日志(Audit log)** 抽屉中展示这些记录。

### 便携式发行版(Windows 免 Docker)

`npm run package` 会为**当前操作系统/架构**在 `release/` 下生成一个自包含的发行包
(Windows 上是 `.zip`,其他平台是 `.tar.gz`),内含编译后的服务器、构建好的前端、
生产环境的 `node_modules`,以及 `start.bat` / `start.sh` 启动脚本。

```bash
npm run package
```

在目标机器上(仅需安装 **Node.js >= 24**——无需构建工具):

1. 解压发行包。
2. 设置凭据:编辑 `start.bat` / `start.sh`(或在它们旁边放一个 `.env`),填入
   `AUTH_USERNAME` / `AUTH_PASSWORD`。
3. 运行 `start.bat` / `./start.sh`。打开 `http://localhost:3000`。

> 由于 `node-pty` 是原生模块,发行包必须在它将要运行的**同一操作系统/架构**上构建。
> 要生成 Windows 发行版,请在 Windows 机器上构建(或使用下方的 CI 矩阵)。

### 跨平台构建(CI)

[`.github/workflows/release.yml`](.github/workflows/release.yml) 会在
`ubuntu-latest`、`macos-latest` 和 `windows-latest` 的矩阵上运行 `npm run package`,
并将每个发行包作为构建产物上传。推送 `v*` 标签时,还会额外将它们发布到 GitHub Release。

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
| POST | `/api/instances/:id/stop` | 是 | 停止实例 |
| POST | `/api/instances/:id/restart` | 是 | 重启实例 |
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

你也可以随时在 UI 上点 **「重启(Restart)」** 手动恢复——它用的是同一套强杀逻辑,
无论弹窗是哪种类型都能把卡死的进程端掉再拉起。

## 自动重启

创建实例时设置 `autoRestart: true`(可选地附带 `restartDelayMs`,默认 `3000`)。
当实例发生非预期退出(进入 `crashed`)时,squash 会以指数退避
(`restartDelayMs * 2^n`,上限 60 秒)重启它,最多连续尝试 5 次;之后实例保持 `crashed`。
一旦实例干净运行满 60 秒,尝试计数器就会重置。手动停止/重启总是会清零计数器。

## 已知问题

- **macOS `posix_spawnp failed`**:node-pty 的 spawn-helper 二进制文件在 macOS 上可能缺少执行权限。
  修复方法:`chmod +x node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/darwin-*/spawn-helper`。Linux 不受影响。
- **针对真实 `rwr_server` 的运行时验证**尚未在实际的游戏服务器二进制文件上进行过。

## 路线图

- [ ] 真实游戏服务器运行时验证(Linux)
- [x] 崩溃时的自动重启策略
- [ ] 通过解析 `status` 输出进行健康探测
- [ ] 日志轮转
- [ ] SQLite 配置存储(计划中)

## 许可证

MIT 许可证。详见 [LICENSE](LICENSE)。
