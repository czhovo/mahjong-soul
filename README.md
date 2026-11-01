# 听风执牌 v4 · 雀魂 · 听风 v70

Windows 上运行的雀魂自动执牌程序：从窗口截图识别局面，维护公开事件和本方手牌，调用本地听风引擎，再通过 AutoHotkey v2 执行操作并检查后续画面。

默认引擎为 **v70-parallel-3p3**；长考剩余时间不超过 5 秒时使用 **v70-parallel-1p7**。两个编译好的 Windows x64 引擎由 [Release](https://github.com/czhovo/mahjong-soul/releases/tag/v4.0.0-v70) 提供，安装脚本自动下载并校验。仓库不含听风 C++ 源码，不需要编译器，也不需要 Codex、语言模型或 API 密钥。

这是仍在迭代的实机程序，已知存在短暂漏识别、误判完整性和历史衔接问题。启动自检通过代表固定样本与运行链路通过，不代表任意牌局均无误；首次使用请有人观察运行。

## 运行条件

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10/11 x64 |
| Node.js | 22 或更高版本；标准库即可，无需 `npm install` |
| Python | 3.12 x64；安装脚本创建独立 `.venv` |
| 原生依赖 | 若 ONNX Runtime 报 DLL 加载错误，安装 [Microsoft Visual C++ x64 运行库](https://aka.ms/vs/17/release/vc_redist.x64.exe) 后重试 |
| 雀魂 | 中文 Steam 桌面客户端 `Jantama_MahjongSoul.exe`；窗口标题为「雀魂麻将」或「雀魂麻將」 |
| 牌面 | 使用默认牌面，并安装本仓库生成的彩色编码牌面；原版牌面无法直接识别 |
| 窗口 | 有标题栏的窗口模式，客户区约 16:9，客户区高度至少 568 像素；基准为 1366×768，支持等比例缩放和移动 |
| 规则与界面 | 当前面向四人东及已标定的中文界面；三人麻将、任意皮肤或其他语言布局未适配 |

程序会恢复、激活游戏窗口并发送鼠标输入。游戏与程序请保持相同权限级别，运行中不要同时手动点击游戏。不需要管理员权限，除非游戏安装目录的写入权限另有要求。

## 从零安装

先安装 [Node.js](https://nodejs.org/) 和 [Python 3.12 x64](https://www.python.org/downloads/windows/)。安装 Python 时启用 PATH；也可以在下面显式传入 `python.exe` 的完整路径。

下载仓库 ZIP 并解压到可写目录，或执行：

```powershell
git clone https://github.com/czhovo/mahjong-soul.git
cd mahjong-soul
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

如果 `python` 指向其他版本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Python 'C:\Python312\python.exe'
```

安装脚本完成以下操作：

1. 检查 Node.js 和 Python，建立 `.venv`，安装 `requirements.txt` 中的依赖。
2. 从 AutoHotkey 官方 Release 下载 v2.0.30，校验 ZIP 的 SHA-256，解压到 `runtime/ahk-v2`。
3. 从本仓库 Release 下载两个 v70 引擎，解压到 `engines/v70-parallel-3p3`、`engines/v70-parallel-1p7`，核对 `bot.exe` 的 SHA-256。
4. 运行离线自检：实际识别固定样本、执行两个引擎的决策与 analyze、检查 OCR，并启动/退出 AHK 工作进程。**离线自检不点击游戏。**

首次安装需要联网。之后识别、决策和 OCR 都在本机运行，不需要在线推理服务。下载或依赖安装失败会停止并显示错误；修复网络后可重新运行安装脚本。

## 安装编码牌面

**关闭雀魂后执行。** 将示例路径替换为包含 `Jantama_MahjongSoul.exe` 的实际安装目录（Steam「管理 → 浏览本地文件」）：

```powershell
.\.venv\Scripts\python.exe .\patch-tiles.py --game-dir 'D:\SteamLibrary\steamapps\common\MahjongSoul' --install
```

工具读取自己安装的游戏资源，在本仓库 `private/tile-backups` 备份原文件，生成带黑白编码、颜色条和中文牌名的默认牌面，重新读取验证像素后才安装。仓库不分发完整游戏资源包。启动游戏后选择**默认牌面**。

去掉 `--install` 只生成与验证，不修改游戏。恢复原牌面：

```powershell
.\.venv\Scripts\python.exe .\patch-tiles.py --game-dir 'D:\SteamLibrary\steamapps\common\MahjongSoul' --restore
```

备份与游戏文件哈希不一致时不会直接覆盖。游戏更新可能改变资源文件名、贴图布局或还原牌面；当前工具匹配已验证的默认资源文件。提示找不到 bundle 时，先核对游戏目录。只有已确认新文件仍包含同样四张默认贴图时才使用 `--bundle 新文件名`；不同布局需要重新适配。请保留备份，勿把 `private` 目录提交到 GitHub。

## 启动与停止

开启雀魂，完成登录，使用中文界面和默认编码牌面，调整为上述窗口模式，然后双击 `start.cmd` 或执行：

```powershell
node resident.mjs
```

默认从识别到的大厅页面依次选择 **段位场 → 银之间 → 四人东**；正在牌局中也支持接入。终局根据当前按钮继续确认或再来一局。默认启用连续游戏；不是只打一场后自动停止。

现有连续游戏流程还保留了连续两场 PT 为负后的 10 分钟冷却及客户端重启处理。

```powershell
node resident.mjs -b  # 铜之间、四人东
node resident.mjs -g  # 金之间、四人东
```

`-b` 与 `-g` 不能同时使用。历史版本参数 `--64/--66/--67/--68` 仍在代码中保留兼容，但本发行包只提供 v70，不要使用这些参数。默认无需传版本参数。

按 **Ctrl+C** 停止。控制器会完成清理并退出；已经发送的鼠标动作不会被撤销。启动时会检查固定识别样本、两个引擎和实际 AHK 操作链，操作自检会点击所选雀魂窗口标题栏一次。未找到窗口时等待。

确认立直且自动和牌开启后，程序继续识别局面、记录事件和处理结算，但不再请求听风逐手决策。

## 可选配置

无需配置即可使用默认 v70、银之间、四人东。需要关闭自动再来一局时，复制 `config.example.json` 为 `config.local.json`，把 `autoRematch` 改为 `false`：

```powershell
node resident.mjs .\config.local.json
```

| 字段 | 含义 |
|---|---|
| `autoRematch` | 默认 `true`；`false` 时整场结束后停止 |
| `initialScores` | 四个初始点数，默认均为 25000 |
| `pollMs` | 主循环的最小间隔，默认 250 ms；不代表识别耗时 |
| `directory` | 可选的运行记录根目录；相对路径基于启动目录 |

默认 Python 使用仓库 `.venv/Scripts/python.exe`。有完整依赖的其他 Python 可通过环境变量覆盖：

```powershell
$env:TINGFENG_PYTHON = 'C:\path\to\python.exe'
node resident.mjs
```

不要单独把 `executable` 配成 1p7：正常启动需要两个版本同时完成校验，运行时自动选择时间档位。引擎文件必须与 `release-manifest.json` 及代码内登记的哈希一致。

## 终端与运行记录

启动显示 `听风 v70-parallel 听风执牌v4`。各项自检在 `Ready` 后显示实际用时。对局中显示新事件、决策、预期价值提升、和牌率/防守或流局满贯路线说明、放铳率，以及操作确认等。识别失败会重试，不能把“已发送输入”当成游戏已执行。

| 目录 | 内容 |
|---|---|
| `test-evidence/resident/` | 每次运行的事件、状态、启动校验和听风输入输出 |
| `observations/` | 识别结果 JSONL；长期运行会增长，停止程序后可归档/清理 |
| `saved-rebuild-screenshots/` | 局面重建时的画面 |
| `saved-win-screenshots/`、`saved-win-settlements/`、`saved-match-results/` | 和牌与结算留存，具体以实际生成目录为准 |
| `queue/` | AHK 请求、回执与运行锁 |
| `private/` | 下载缓存和本机牌面备份 |

常规连续采集使用内存帧，不把每帧写成图片。`-d` 是显式调试选项，会保存全部截图到 `saved-debug-screenshots/`，日常使用不要加。以上运行目录均已被 `.gitignore` 排除；它们可能包含玩家昵称、对局内容和本机路径。

## 验证与排错

```powershell
npm test
node doctor.mjs
```

- `npm test` 检查发布目录中的本地模块引用、默认版本和必需模板。
- `doctor.mjs` 实际启动 Python 识别进程和两个 v70 二进制，验证固定识别样本及引擎输出，并检查 AHK 工作进程。它不接管当前牌局。
- 正式启动还会验证真实窗口和标题栏点击。离线通过不等于实机所有局面都通过。
- `recognize v4: Failed`：先确认依赖安装完整、`startup-fixtures` 与模板文件未缺失。不得删除标签校验来绕过失败。
- `Uncalibrated game client geometry`：调整为有标题栏、近似 16:9 的窗口，不要使用无边框或任意宽高比。
- `AHK worker exited`：检查 `runtime/ahk-v2/AutoHotkey64.exe` 是否存在、游戏权限级别是否一致。
- 引擎哈希不匹配：重新运行 `setup.ps1 -SkipPython` 下载本发行版二进制，不要用未知编译版本替换。
- 三次连续的 10 秒未推进重试达到退出条件时，程序会停止；查看本次 `events.jsonl`、`status.json`。
- 本版本仍可能出现暂时漏牌、完整性误标及重建；排查时请保留具体时间与对应 JSON 日志，不要仅依据泛化的“不完整”提示认定原因。

## 项目结构与协议

`resident.mjs` 是常驻入口；`live-cycle.mjs` 管理局内衔接与动作确认；`recognition-worker.py` / `recognize_coded_frame.py` 是 recognize v4；`bridge.mjs` 调用听风；`output.ahk` 执行输入；`patch-tiles.py` 生成游戏牌面。

听风标准输入是包含 `requests`、`responses`、`data`、`match_context` 的 JSON。公开事件历史与当前动作窗口由执牌程序维护。牌编码为 `W` 万、`B` 筒、`T` 条，`0` 为赤五；`Z1`–`Z7` 为东南西北白发中。当前鸣牌推断通过 `opponent_hand_constraints` schema 2 的 `any_of` 下界约束传递。引擎返回动作，执牌程序转换为点击坐标；牌的屏幕坐标不会作为麻将决策输入。

第三方依赖与素材来源见 [THIRD_PARTY.md](THIRD_PARTY.md)。本仓库公开了执牌与识别实现；听风引擎只提供二进制，没有包含或授予其 C++ 源码。
