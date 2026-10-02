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

配置文件保存在 `data/config.json`（一般不用手改，用网页配置即可）。

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
6. Windows 托盘模式：`npm run tray`（或 `npm start -- --tray --open`）
   - 右下角托盘图标可：打开 Web / 打开备份文件夹 / 打开配置 / 退出
   - 交互菜单里也可按 `T` 进入托盘模式

### CLI 快捷键

主菜单支持**直接按键**（不必再用方向键）：
- `1`~`9` 选游戏
- `W` 打开 Web
- `T` 托盘模式
- `N` 新建 / `F` 备份文件夹 / `E` 配置 / `Q` 退出

### Web 推荐流程（小白）

1. `npm start -- --web` 打开网页
2. 点左下角「+ 添加游戏」
3. 选择同步方式：
   - **PC ↔ 远程电脑**：填 PC 路径 + 远程路径；右上角 ⛓ 填 SSH
   - **PC ↔ Switch**：填 PC 路径 + Switch 路径（从资源管理器地址栏复制）
4. Switch 模式下按钮为：
   - `PC → Switch`：复制并去掉 `.sav`（`GameSave_00_GD.sav` → `GameSave_00_GD`）
   - `Switch → PC`：复制并加上 `.sav`

> 填写好的内容会被存储到 `data/config.json`，也可直接改配置文件（高级用户）
> 
## 备份策略

每次同步前会在 `backups/<游戏名>/<时间戳>/` 下生成：
- `local/`：本地存档备份
- `remote/`：远程存档备份（Switch 模式下为 Switch 侧备份）

截图相册保存在 `backups/<游戏名>/myImage/`（含图片与备注 meta.json）。

启动时会自动把旧结构 `backups/<游戏名>_<时间戳>` 迁移到新结构。

若远程目录不存在，仍会创建一个空目录作为备份记录；仅备份本地时，只生成 `local/`。

## Switch 配置示例

```json
{
  "name": "潜水员戴夫 Switch",
  "syncMode": "switch",
  "localPath": "C:\\Users\\kasus\\AppData\\LocalLow\\nexon\\DAVE THE DIVER\\SteamSData\\186400536",
  "switchPath": "你的Switch挂载盘:\\Saves\\Installed games\\潜水员戴夫",
  "nobackup": false
}
```

## 命令行参数
用纯命令行+参数的方式创建快捷方式可以无需交互进行存档同步和备份：

- `--game <游戏名称>`：按名称选择已配置的游戏。
- `--direction <方向>`：可填 `local2remote`、`remote2local`、`backup`（分别对应“本地 -> 远程”“远程 -> 本地”“仅备份本地”）。Switch 模式同样可用 `local2remote`/`remote2local`（PC↔Switch）。

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
