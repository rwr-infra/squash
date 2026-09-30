# 网页终端尺寸同步到 PTY

- 日期：2026-09-30
- 风险：低（前端为主 + supervisor 一处；失败当场可见）
- Commits：bec1c64（supervisor + 网关 + 冒烟）、425a735（前端）、d53e199 + 9c53b5c（冒烟子进程改为轮询 TTY handle 取尺寸，Windows 需要），分支 `fix/terminal-resize`
- 相关 ADR：无

## 结果
PTY 尺寸始终等于浏览器 xterm 的行列数：打开终端、缩放窗口、Start / Restart / 自动重启之后都一致（以前恒为 120×40，首键按 120 列重绘导致错位）。停止状态下打开或缩放不报错，下次 Start 用最新尺寸。

## 关键决策
| 决策 | 原因 | 否决方案及原因 |
| --- | --- | --- |
| 后端记忆尺寸 + 前端补发，两者都做 | 只靠前端补发覆盖不了无人观看时的自动重启；只靠后端记忆覆盖不了首次打开 | 只做其一：各漏一种场景 |
| supervisor `resize()` 非 `running` 时只记录尺寸、不抛错 | 尺寸不是状态；停止时打开页面的 resize 必须留到下次 spawn | 继续抛错由网关吞掉：尺寸丢失，Start 后回到默认值 |
| 网关校验 cols/rows 为 1–1000 的整数 | 尺寸被记忆后会作用于之后每次 spawn，坏值会"粘住" | 只校验 `typeof number`（原状）：0、负数、小数、1e9 都会被转发 |
| 前端每次收到 `running` 推送都发尺寸，不做变化检测 | 从 running 点 Restart 只推 running → running，中间没有状态 | 只在状态变化时发：漏掉手动 Restart |
| `ResizeObserver` 观察终端容器，`fit()` 放到下一帧 | 容器高度随"实例已停止"横幅变化，window `resize` 捕捉不到；下一帧执行避免观察回路 | window `resize` + 状态变化时手动 fit：要猜横幅何时渲染完 |
| 多个浏览器同时连接时，最后一次 resize 生效 | 与 tmux / ttyd 常见行为一致，协商收益低 | 取最小尺寸协商：复杂，收益低 |

## 确立的规范
- 终端尺寸是 supervisor 的持久属性（不是状态）：任何会 spawn 的路径都用记忆尺寸；改 spawn 逻辑时保持这一点，并跑 `npm run smoke:supervisor`（含 resize 用例）。
- 前端要让后端拿到尺寸：WS 每次（重）连 `onOpen`、每次 `running` 推送、xterm `onResize` 都发 `{type:'resize'}`。`fit()` 只在尺寸变化时触发 `onResize`，不能单靠它。

## Pitfalls
- **Windows ConPTY 下 node 子进程收不到 stdout `'resize'`**：伪控制台确实已 resize（输出 `\e[8;30;100t` 并重绘），但子进程 5s 内没有触发事件（CI run `36676865584`）。而且公开的 `process.stdout.getWindowSize()` **不是实时查询**，只返回那次事件缓存的 `columns/rows`（d53e199 误以为是实时查询，CI run `36677104580` 仍失败）。要观测子进程实际看到的尺寸，就轮询 `process.stdout._handle.getWindowSize(arr)`（Node 自己 `_refreshSize()` 调用的就是它，底层是 libuv `uv_tty_get_winsize`）。CI run `36677463667` 证实：Windows 子进程经 handle 读到 `120x40 → 100x30`，即 Windows 控制台程序能看到新尺寸，只是拿不到事件。真实 rwr_server 是否处理尺寸变化未知。
- **bash 3.2 多行一次性输入（粘贴）时，提示符会跑到命令输出前**（如 `bash-3.2$ t30 90`）。这是 bash 自己输出的字节序：执行上一条命令期间，后面的输入被提前回显，与提示符交错（WS 原始输出已证实）。与尺寸无关 —— 人工验证时让用户逐条手打。
- macOS 上 resize 成相同尺寸不发 SIGWINCH（PTY 无输出）；尺寸变化时 bash 在空闲提示符下输出 `\r\e[K` 加提示符重画。
- 本机 dev 手测：根 `.env` 设了 `HOST=0.0.0.0` 且是弱密码 → 绑定门禁拒绝启动（正确行为），用 `HOST=127.0.0.1 PORT=4747 npm run dev`。前端 Vite dev server 没有 WS 代理，所以先 `npm --prefix frontend run build`，让后端同源托管 `frontend/dist`，浏览器开 `http://localhost:4747`（`.env.local` 的 `VITE_API_URL` 指向 `localhost:4747`，用 `127.0.0.1` 会跨域）。
- Diff Review 提出"`disconnect()` 后 ResizeObserver 回调仍会触发"：规范中 `disconnect()` 同时清空 `observationTargets` 与 `activeTargets`，不会再投递；况且回调只做 `requestAnimationFrame` 调度，cleanup 已 `cancelAnimationFrame` —— 驳回，未加防护代码。

## 剩余风险 / 后续
- 编辑实例会 `dispose()` 旧 supervisor 并新建 → 新 supervisor 回到 120×40；已打开的终端页仍连着旧对象，需要重新进入页面（既有行为，未改）。
- 多观众时尺寸以最后一次 resize 为准，其他观众可能看到折行。
- 真实 rwr_server 控制台对 resize 的反应未验证（只测过 bash 与 node 假子进程）。

## 指针
- `src/core/instance/instance-supervisor.ts`（`ptySize`、`start()`、`resize()`）；`src/api/ws/terminal-gateway.ts`（`isTerminalDimension`）
- `frontend/src/pages/TerminalPage.tsx`（`sendSize`、`ResizeObserver`）；`frontend/src/services/terminalService.ts`（`onOpen`）
- `scripts/smoke-supervisor.ts`（`checkResize`，`size` 子进程模式）
