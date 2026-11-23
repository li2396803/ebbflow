# 在 Windows 上运行 Ebbflow

本文面向 Windows 10/11。命令默认在 **PowerShell** 下执行，`cmd.exe` 的差异会单独标注。

> 验证状态：跨平台逻辑由 `tests/cases/platform.mjs` 覆盖（入口判断、项目根目录、空库载荷），
> 在 macOS 上通过。**本文的 Windows 步骤未在真实 Windows 机器上逐条实跑**，
> 依据是 Node 文档与代码路径；遇到与本文不符的情况请提 Issue。

---

## 1. 前置

| 项 | 要求 | 检查方式 |
| --- | --- | --- |
| Node.js | ≥ 22.5，需要内置 `node:sqlite` | `node -v` |
| 终端 | PowerShell 5.1+ 或 Windows Terminal | `$PSVersionTable.PSVersion` |
| Git | 任意近期版本 | `git --version` |
| 磁盘 | 本地盘，预留约 1 GB（SQLite 库 + 站点产物） | — |

PowerShell 里请用 **`npm.cmd` / `npx.cmd`**。`npm.ps1` 受执行策略限制时会出现
`无法加载文件 …npm.ps1，因为在此系统上禁止运行脚本`，改用 `.cmd` 后缀即可绕过。

```powershell
node -v
node -e "console.log(Object.keys(require('node:sqlite')))"   # 能打印导出即可
npm.cmd -v
```

---

## 2. 三步快速开始

```powershell
# ① 克隆
git clone https://github.com/li2396803/ebbflow.git
Set-Location ebbflow

# ② 配置 token（.env 已在 .gitignore 中）
Copy-Item .env.example .env
notepad .env        # 把 TUSHARE_TOKEN 换成自己的；保存为 UTF-8（不要 BOM）

# ③ 起服务
npm.cmd start       # http://127.0.0.1:5188
```

只运行站点 **不需要** `npm install`：服务端只用 Node 内置模块，`site/` 里已有构建产物。

需要重建前端（`npm run build` 里的 Vite 步骤）时再安装依赖：

```powershell
npm.cmd install
```

首次启动是空库，另开一个终端灌数据：

| 方式 | 命令 | 说明 |
| --- | --- | --- |
| 全量回补 | `npm.cmd run backfill` | 建 5 年历史，耗时取决于积分与网络 |
| 只跑增量 | `npm.cmd run update` | 只补最近 15 个交易日 |
| 行情历史 | `npm.cmd run quotes` | 折溢价 / 成交额 / 换手率的数据源 |

`data/etf.db` 是唯一需要保留的本地状态。

---

## 3. 日常命令（PowerShell）

| 命令 | 作用 |
| --- | --- |
| `npm.cmd start` | 起服务，`127.0.0.1:5188`；`$env:PORT="8080"` 换端口 |
| `npm.cmd run update` | 增量更新：份额 / 净值 / 行情 / 折算检测 → 重算 → 构站 |
| `npm.cmd run build` | 只用本地库重建 `site/`（需要 `npm install` 提供 Vite） |
| `$env:SKIP_VITE="1"; npm.cmd run build` | 不重建前端，只更新 `site/data/`（无 `node_modules` 时用） |
| `npm.cmd run backfill` | 全量回补份额历史 |
| `npm.cmd run quotes` | 回补行情历史 |
| `npm.cmd run reconcile` | 双口径交叉校验，写 `data/quality.json` |
| `npm.cmd test` | 数据校验用例 |
| `npm.cmd run verify:origin` | 与原看板逐点回归 |
| `npm.cmd run lint` | 仓库自检 |

`cmd.exe` 下把 `npm.cmd` 写作 `npm`、`$env:SKIP_VITE="1"` 改为 `set SKIP_VITE=1`。

检查服务：

```powershell
Invoke-RestMethod http://127.0.0.1:5188/api/status | ConvertTo-Json -Depth 4
```

---

## 4. 后台运行与日志

```powershell
New-Item -ItemType Directory -Force .run | Out-Null

Start-Process -FilePath "node" -ArgumentList "server.mjs" `
  -WorkingDirectory (Get-Location) -WindowStyle Hidden `
  -RedirectStandardOutput .run\server.log -RedirectStandardError .run\server.err
```

停止（按端口找进程）：

```powershell
Get-NetTCPConnection -LocalPort 5188 -State Listen |
  Select-Object -ExpandProperty OwningProcess |
  ForEach-Object { Stop-Process -Id $_ -Force }
```

没有 `Get-NetTCPConnection` 的旧系统：

```cmd
netstat -ano | findstr :5188
taskkill /PID <PID> /F
```

日志：`.run\server.log`、`.run\server.err`；更新日志在 `.run\update.log`。

---

## 5. 定时更新（任务计划程序）

`bin/*.sh` 是 bash 脚本，任务计划程序不能直接调用。用 PowerShell 注册计划任务：

```powershell
$action = New-ScheduledTaskAction -Execute "cmd.exe" `
  -Argument '/c cd /d "D:\ebbflow" && npm.cmd run update >> .run\update.log 2>&1'
$trigger = New-ScheduledTaskTrigger -Weekly `
  -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 16:10
Register-ScheduledTask -TaskName "Ebbflow Update" -Action $action -Trigger $trigger `
  -Description "Ebbflow daily data update" -Force
```

开机启动服务：

```powershell
$action = New-ScheduledTaskAction -Execute "node" -Argument "server.mjs" `
  -WorkingDirectory "D:\ebbflow"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "Ebbflow Server" -Action $action -Trigger $trigger -Force
```

手动触发与查看结果：

```powershell
Start-ScheduledTask -TaskName "Ebbflow Update"
Get-ScheduledTaskInfo -TaskName "Ebbflow Update"
```

`schtasks` 等价写法（引号较脆，优先上面）：

```cmd
schtasks /Create /TN "Ebbflow Update" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 16:10 /TR "cmd /c cd /d D:\ebbflow && npm.cmd run update" /F
```

注意任务计划程序默认在用户未登录时也能运行，但 `npm.cmd` 依赖 Node 的 PATH；
建议在「操作」里写 `node.exe` 的绝对路径，或在任务里设置 `PATH`。

---

## 6. 常见报错对照

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `'bash' 不是内部或外部命令` | 在 cmd/PowerShell 里执行了 `bin/*.sh` | 用本文 §3/§5 的 PowerShell 等价命令；或装 Git Bash / WSL 后运行 `bash bin/update.sh` |
| `spawn npx ENOENT` / `ENOENT: npx` | 没有 `node_modules`，或直接 spawn 了无扩展名的 `npx` | 先 `npm.cmd install`；项目内部已改用 `lib/cli.mjs` 的 `runLocalBin()`，会优先 `.cmd` 并回退 `npx.cmd` |
| `无法加载文件 …npm.ps1` | PowerShell 执行策略 | 改用 `npm.cmd`，或 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| 路径含空格或中文时报错 | 旧版本子进程未加引号 | 已修：`runLocalBin()` 在 Windows 下给含空格的路径加引号；路径含 `&` 时请改名 |
| `EPERM` / `EBUSY` 删除 `data/etf.db*`、`.update.lock` | Windows 文件锁：服务、编辑器、杀软或索引服务占用 | 先停服务；关掉占用程序；把项目目录加入杀软排除；重试 |
| `data/lastrun.json` 不存在 | 还没跑过 `update` | 不影响构建；服务会判定数据过期并尝试刷新，或加 `--no-refresh` 启动 |
| `GET /api/meta` 返回 500 | 库为空且没有 `site/data/`，动态兜底构建失败；或库被另一个进程锁住 | 先 `npm.cmd run build`；确认没有第二个 `update` 在跑；看 `.run\server.log` |
| 读不到 `TUSHARE_TOKEN` | `.env` 存成了带 BOM 的 UTF-8，或文件名成了 `.env.txt` | 用「另存为 → UTF-8（无 BOM）」；确认文件名是 `.env`（资源管理器会隐藏扩展名） |
| `SQLITE_BUSY` / `database is locked` | 服务或另一个更新进程持有写锁 | 同一时间只跑一个写任务；停服务后再回补/删库 |
| `ENAMETOOLONG` | 路径超过 260 字符（`node_modules` 较深） | 开启长路径支持（§8），或把项目放到 `D:\ebbflow` 这类短路径 |

---

## 7. 与 macOS / Linux 的差异

| 维度 | macOS / Linux | Windows |
| --- | --- | --- |
| 换行 | LF | 仓库 `.gitattributes` 强制 LF，检出也是 LF；不要用编辑器转成 CRLF |
| 路径分隔符 | `/` | `\`（代码统一用 `node:path`，不要手写 `/`） |
| 大小写 | 区分 | 不区分：不要靠大小写区分 `Data` 与 `data` |
| 后台进程 | `bin/start.sh`（nohup + pid 文件） | `Start-Process` 或任务计划程序 |
| 定时更新 | LaunchAgent（`launchd/*.plist`） | 任务计划程序（§5） |
| 权限位 | `chmod` 可执行 | 无 `chmod` 概念；项目不依赖权限位 |
| 文件锁 | 可删除已打开文件 | 删除/改名被占用文件会 `EPERM`，先停进程 |
| 控制台编码 | UTF-8 | cmd 默认 GBK，中文可能乱码：`chcp 65001` 或用 Windows Terminal |
| 脚本 | `bin/*.sh`、`publish-db-seed.sh` | 需 Git Bash / WSL，或用 PowerShell 等价命令 |

WSL 下可以照常跑 `bash bin/*.sh`，但 SQLite 放在 `/mnt/d/...` 会明显变慢，建议放 WSL 自己的文件系统。

---

## 8. 数据与文件锁

- 库文件：`data/etf.db`，运行时伴随 `data/etf.db-wal`、`data/etf.db-shm`。
  **删除或拷贝库之前先停服务**，否则 Windows 会拒绝或拿到不一致快照。
- 拷贝库时三个文件一起拷，或先做 checkpoint：

```powershell
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/etf.db');d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close()"
```

- 更新锁：`data/.update.lock` 是目录。进程被强杀后若残留，且确认没有更新在跑，
  可以 `Remove-Item -Recurse -Force data\.update.lock` 后重试。
- 长路径：以管理员身份执行

```cmd
reg add HKLM\SYSTEM\CurrentControlSet\Control\FileSystem /v LongPathsEnabled /t REG_DWORD /d 1 /f
```

然后再打开终端（需要重启资源管理器或注销）。

- UNC 路径（`\\server\share\...`）：Node 能读写，但 SQLite 在 SMB 上的锁语义不可靠，
  请把项目放在本地盘。

---

## 9. 编码与文件

- `.env`、`data/*.json` 用 **UTF-8 无 BOM**。带 BOM 的 JSON 会让 `JSON.parse` 抛错；
  读到 `.env` 时项目会去掉 BOM，但其他工具不一定。
- 写文件统一 LF：构建产物是 JSON，不含多行文本；Git 已用 `.gitattributes` 固定。
- 控制台乱码：`chcp 65001`，或直接用 Windows Terminal / PowerShell 7。

---

## 10. 自检

```powershell
npm.cmd test
npm.cmd run lint
$env:SKIP_VITE="1"; npm.cmd run build
```

三条都应通过；`npm.cmd run build` 之后再执行 `npm.cmd start`，
打开 <http://127.0.0.1:5188> 应能看到页面与数据。

---

## 11. 未覆盖 / 已知限制

1. **没有 Windows 原生服务**：不提供 `sc.exe` 服务包装，用任务计划程序（§5）。
2. **没有 `.cmd` / `.ps1` 版的 `bin/*.sh`**：本文给等价命令；需要“一键脚本”可以另加，但会多一套需要维护的入口。
3. **CI 只在 Ubuntu 上跑**：`.github/workflows/*.yml` 的 bash 步骤不保证在 Windows 本地可执行，Windows 请用 `npm.cmd` 命令。
4. **未在 Windows 实机验证**：本文按代码与 Node 文档编写；跨平台逻辑由测试覆盖，但涉及杀软、组策略、企业环境的差异无法预判。
