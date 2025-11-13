# 游戏存档双端同步工具（Windows 双端）

一个基于 Node.js 的交互式 CLI 工具，支持：
- 本地与远程（SSH）之间的双向同步：本地 -> 远程、远程 -> 本地
- 仅备份本地存档（不会访问远程）
- 同步前自动备份本地与远程存档到 `backups/` 目录
- 自动创建本地/远程目录
- 传输方式：
  - 默认使用 SFTP（内置库，无需外部命令，适合 Windows 双端）
  - 可选强制使用 scp/pscp（若系统已安装 `pscp` 或 `scp`）

## node 环境安装
程序使用nodejs 可以使用 nvm 安装
https://github.com/coreybutler/nvm-windows

```
nvm install 20.11.1
```
WINDOWS 装完后要重启才能用

## game-save-manager安装

```bash
npm install
（安装依赖）
npm start
（启动game-save-manager）
```

配置文件保存在 `data/config.json`。

## 使用方式（交互模式）

每次执行 `npm start` 后，按照提示完成以下步骤：
1. 选择或新建游戏，并填写本地存档路径（目录会自动创建）。
2. 为该游戏填写远程存档完整路径（例如 `C:/Users/foo/Saved Games/<Game>`）。
3. 选择操作：
   - 本地 -> 远程（用本地覆盖远程，远程会被清空后再上传）
   - 远程 -> 本地（用远程覆盖本地，本地会被清空后再下载）
   - 仅备份本地存档（在 `backups/` 目录生成一份本地备份，不访问远程）
4. 若选择双向同步，会继续提示填写/确认远程 SSH 信息（host、port、user、password），并自动测试连接。

## 命令行参数

无需完全依赖交互式流程，可通过命令行参数直接指定游戏与操作：

- `--game <游戏名称>`：按名称选择已配置的游戏。
- `--direction <操作>`：可填 `local2remote`、`remote2local`、`backup`（分别对应“本地 -> 远程”“远程 -> 本地”“仅备份本地”）。

示例（使用 npm 时记得带上 `--` 传递参数）：

```bash
npm start -- --game "mc dungeons" --direction local2remote
```

如果只想做本地备份：

```bash
npm start -- --game "mc dungeons" --direction backup
```

未通过参数指定时，会自动进入交互式选择。

## 备份策略

每次同步前会在 `backups/<游戏名>_<时间戳>/` 下生成：
- `local/`：本地存档备份
- `remote/`：远程存档备份

若远程目录不存在，仍会创建一个空目录作为备份记录；仅备份本地时，只生成 `local/`。

## 远程路径书写

- Windows 远程建议使用正斜杠：例如 `C:/Users/foo/Saved Games`
- 每个游戏都需要提供远程存档的完整路径，可在创建游戏时输入，也可事后在 `data/config.json` 内调整游戏条目的 `remoteFullPath` 字段。

## 选择 scp/pscp

- 默认：SFTP（推荐）。无需外部命令，兼容 Windows 远程（OpenSSH Server）。
- 强制 scp：需系统存在 `pscp`（PuTTY）或 `scp`。
  - `pscp` 支持 `-pw` 非交互密码，非常适合自动化
  - `scp` 不支持直接传递密码，若未配置免密登录，命令会卡在密码输入

你可在首次运行时选择“强制 scp/pscp”，或手动编辑 `data/config.json` 的 `preferScpTool` 为 `"scp"`。


## 注意

- 若使用 `scp` 且未配置免密，请考虑改为 `pscp` 或切回默认的 SFTP。
- SFTP 模式下，工具会递归创建远程目录并进行上传/下载，可兼容 Windows 远程盘符（例如 `C:/`、`D:/`）。
- 当选择“本地 -> 远程”时，远程目标目录会在同步前清空，确保最终内容与本地一致（远程多余文件会被移除）。
- 当选择“远程 -> 本地”时，本地目标目录会在同步前清空，以确保最终内容与远程完全一致（缺失文件会被移除）。
- “仅备份本地存档”不会访问远程，无需远程 SSH 凭据即可使用。
- 请确保远程主机已启用 SSH/SFTP 服务。


## 额外提示 ：win掌机安装openssh步骤
我发现windows家庭版（掌机默认系统）是不带openssh的，需要手工安装。

https://github.com/PowerShell/Win32-OpenSSH/releases

等它下载并安装完，然后再执行命令开放 22 port：

```
New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server (sshd)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

查看用户名：rogallyx

```
whoami
> rog\rogallyx
```
密码是开机密码（不是pin）, 可使用命令修改(掌机上命令行管理员模式)

```
net user rogallyx <newpwd>
```

查看ip地址 192.168.31.204

```
PS C:\Users\rober> ipconfig /all |findstr IPv4
   IPv4 ?? . . . . . . . . . . . . : 198.18.0.1(??)
   IPv4 ?? . . . . . . . . . . . . : 192.168.31.204(??)
```

从windows设备进行链接
```
ssh rogallyx@192.168.31.204
```

然后输入密码就行。

这样就可以使用 winscp 之类的ssh传输文件工具和终端了。