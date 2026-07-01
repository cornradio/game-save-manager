<img width="200" height="" alt="Group 72 (2)" src="https://github.com/user-attachments/assets/b97e1e9e-d597-43c5-b22b-900e7f6d7d8b" />


# 🕹️ GSM

> 游戏存档双端同步工具+游戏存档备份恢复工具

<img width="800" height="" alt="image" src="https://github.com/user-attachments/assets/24a881f8-7cbe-45c2-b797-f68d4292df74" />

一个基于 Node.js 的交互式 CLI + WEB工具，支持：
- 本地与远程（SSH）之间的双向同步：本地 -> 远程、远程 -> 本地
- 备份本地存档
- 定时备份存档
- 传输方式：
  - 默认使用 SFTP（内置库，无需外部命令，适合 Windows 双端）
  - 可选强制使用 scp/pscp（若系统已安装 `pscp` 或 `scp`）



## 使用教程

```bash
npm install #安装依赖
npm start #启动程序（命令行客户端）
npm start -- --web  #启动程序（web 界面）
```

配置文件保存在 `data/config.json`。

## 使用方式

执行 `npm start` 后，按照提示完成：
1. 选择或新建游戏。
2. （首次）新建游戏需要填写远程/本地存档完整路径（例如 `C:/Users/foo/Saved Games/<Game>`）（可能需要百度）。
3. （首次）按照提示填写ssh的ip、用户、密码信息：
4. 选择同步方向（不用担心资料丢失，覆盖之前会先备份远程和本地的数据）
   - 本地 -> 远程（本地覆盖远程）
   - 远程 -> 本地（远程覆盖本地）
   - 仅备份本地存档（在 `backups/` 目录生成一份本地备份）
5. 后续使用可以用 `npm start -- --web` 直接进入web界面操作（推荐）

> 填写好的内容会被存储到"\data\config.json" 也可直接修改配置文件来新增游戏条目
> 
## 备份策略

每次同步前会在 `backups/<游戏名>_<时间戳>/` 下生成：
- `local/`：本地存档备份
- `remote/`：远程存档备份

若远程目录不存在，仍会创建一个空目录作为备份记录；仅备份本地时，只生成 `local/`。

## 命令行参数
用纯命令行+参数的方式创建快捷方式可以无需交互进行存档同步和备份：

- `--game <游戏名称>`：按名称选择已配置的游戏。
- `--direction <方向>`：可填 `local2remote`、`remote2local`、`backup`（分别对应“本地 -> 远程”“远程 -> 本地”“仅备份本地”）。

示例：

```bash
npm start -- --game "mc dungeons" --direction local2remote

npm start -- --game "mc dungeons" --direction backup
```

> 未通过参数指定时，会自动进入交互式选择。

# 额外示例

## node 环境安装
程序使用nodejs 可以使用 nvm 安装
https://github.com/coreybutler/nvm-windows

```
nvm install 20.11.1
```
WINDOWS 装完后要重启才能用

## win掌机安装openssh步骤
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
