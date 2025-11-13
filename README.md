# 游戏存档双端同步工具（Windows 双端）

一个基于 Node.js 的交互式 CLI 工具，支持：
- 本地与远程（SSH）之间的双向同步：本地 -> 远程、远程 -> 本地
- 同步前自动备份本地与远程存档到 `backups/` 目录
- 自动创建本地/远程目录
- 传输方式：
  - 默认使用 SFTP（内置库，无需外部命令，适合 Windows 双端）
  - 可选强制使用 scp/pscp（若系统已安装 `pscp` 或 `scp`）

## 安装

```bash
npm install
npm start
```

首次运行会提示你：
1) 新建游戏并填写本地存档路径（本地目录会被自动创建）
2) 为该游戏填写远程存档完整路径（例如 `C:/Users/foo/Saved Games/<Game>`）
3) 填写远程 SSH 信息（host、port、user、password）
4) 选择同步方向（本地覆盖远程 / 远程覆盖本地）

配置文件保存在 `data/config.json`。

## 备份策略

每次同步前会在 `backups/<游戏名>_<时间戳>/` 下生成：
- `local/`：本地存档备份
- `remote/`：远程存档备份

若远程目录不存在，仍会创建一个空目录作为备份记录。

## 远程路径书写

- Windows 远程建议使用正斜杠：例如 `C:/Users/foo/Saved Games`
- 每个游戏都需要提供远程存档的完整路径，可在创建游戏时输入，也可事后在 `data/config.json` 内调整游戏条目的 `remoteFullPath` 字段。

## 选择 scp/pscp

- 默认：SFTP（推荐）。无需外部命令，兼容 Windows 远程（OpenSSH Server）。
- 强制 scp：需系统存在 `pscp`（PuTTY）或 `scp`。
  - `pscp` 支持 `-pw` 非交互密码，非常适合自动化
  - `scp` 不支持直接传递密码，若未配置免密登录，命令会卡在密码输入

你可在首次运行时选择“强制 scp/pscp”，或手动编辑 `data/config.json` 的 `preferScpTool` 为 `"scp"`。

## 连接测试与日志

- 在同步开始前会先进行一次 SFTP 连通性测试，并打印当前远程目录候选路径。若测试失败会直接终止，避免误删。
- 可通过命令行输出查看同步步骤：备份、本地/远程路径、SFTP/pscp 调度等；当启用 scp/pscp 时，程序会在执行前原样打印完整命令（含密码等敏感参数）。

## 注意

- 若使用 `scp` 且未配置免密，请考虑改为 `pscp` 或切回默认的 SFTP。
- SFTP 模式下，工具会递归创建远程目录并进行上传/下载，可兼容 Windows 远程盘符（例如 `C:/`、`D:/`）。
- 当选择“本地 -> 远程”时，远程目标目录会在同步前清空，确保最终内容与本地一致（远程多余文件会被移除）。
- 当选择“远程 -> 本地”时，本地目标目录会在同步前清空，以确保最终内容与远程完全一致（缺失文件会被移除）。
- 请确保远程主机已启用 SSH/SFTP 服务。


## win掌机安装openssh步骤
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