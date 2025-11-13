
using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading.Tasks;
using Renci.SshNet;
using Renci.SshNet.Sftp;
using Spectre.Console;


class Program
{
    // NOTE: This C# translation implements the core features of the original Node.js script:
    // - load/save JSON config
    // - interactive prompts via Console
    // - SFTP upload/download using Renci.SshNet
    // - optional scp/pscp fallback via external commands
    // - local backups and remote backups
    //
    // REQUIREMENTS:
    // - dotnet (SDK) installed
    // - Add package: dotnet add package Renci.SshNet
    //
    // USAGE:
    // 1. dotnet new console -n GameSaveSync
    // 2. move this file to the project (replace Program.cs) or copy into file
    // 3. dotnet add package Renci.SshNet
    // 4. dotnet run -- [--game NAME] [--direction push|pull|backupLocal] 
    //
    // This is a single-file, pragmatic translation and focuses on behavior parity, not 1:1 line mapping.

    static string ROOT = Directory.GetCurrentDirectory();
    static string DATA_DIR = Path.Combine(ROOT, "data");
    static string CONFIG_PATH = Path.Combine(DATA_DIR, "config.json");
    static string BACKUP_DIR = Path.Combine(ROOT, "backups");

    class Config
    {
        public List<Game> games { get; set; } = new List<Game>();
        public RemoteConfig remote { get; set; } = new RemoteConfig();
        public string preferScpTool { get; set; } = "auto";
    }

    class Game
    {
        public string name { get; set; } = "";
        public string localPath { get; set; } = "";
        public string remoteFullPath { get; set; } = "";
    }

    class RemoteConfig
    {
        public string host { get; set; } = "";
        public int port { get; set; } = 22;
        public string user { get; set; } = "";
        public string password { get; set; } = "";
    }

    static Dictionary<string, string> ParseArgs(string[] argv)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < argv.Length; i++)
        {
            var token = argv[i];
            if (!token.StartsWith("--")) continue;
            var stripped = token.Substring(2);
            if (string.IsNullOrEmpty(stripped)) continue;
            var eqIndex = stripped.IndexOf('=');
            if (eqIndex != -1)
            {
                var key = stripped.Substring(0, eqIndex);
                var value = stripped.Substring(eqIndex + 1);
                result[key] = value;
                continue;
            }
            var next = (i + 1) < argv.Length ? argv[i + 1] : null;
            if (next != null && !next.StartsWith("--"))
            {
                result[stripped] = next;
                i++;
            }
            else
            {
                result[stripped] = "true";
            }
        }
        return result;
    }

    static void EnsureDirs()
    {
        if (!Directory.Exists(DATA_DIR)) Directory.CreateDirectory(DATA_DIR);
        if (!Directory.Exists(BACKUP_DIR)) Directory.CreateDirectory(BACKUP_DIR);
    }

    static Config LoadConfig()
    {
        EnsureDirs();
        if (!File.Exists(CONFIG_PATH))
        {
            var defaultCfg = new Config();
            SaveConfig(defaultCfg);
            return defaultCfg;
        }
        var json = File.ReadAllText(CONFIG_PATH);
        var cfg = JsonSerializer.Deserialize<Config>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        if (cfg == null) cfg = new Config();
        return cfg;
    }

    static void SaveConfig(Config cfg)
    {
        EnsureDirs();
        var json = JsonSerializer.Serialize(cfg, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(CONFIG_PATH, json);
    }

    static string Timestamp()
    {
        return DateTime.Now.ToString("yyyyMMdd_HHmmss");
    }

    static string GetRemoteDir(Game game)
    {
        if (!string.IsNullOrWhiteSpace(game.remoteFullPath))
        {
            return game.remoteFullPath.Replace('\\', '/').Trim();
        }
        throw new Exception($"游戏 {game.name} 未配置 remoteFullPath，请重新设置。");
    }

    static List<string> RemotePathCandidates(string remotePath)
    {
        var cleaned = remotePath.Replace('\\', '/').TrimEnd('/');
        var list = new List<string>();
        if (System.Text.RegularExpressions.Regex.IsMatch(cleaned, @"^[A-Za-z]:/") && !cleaned.StartsWith("/"))
        {
            list.Add("/" + cleaned);
        }
        list.Add(cleaned);
        return list.Select(p => System.Text.RegularExpressions.Regex.Replace(p, "/+", "/")).Distinct().ToList();
    }

    static string ToSftpPath(string remotePath)
    {
        var candidates = RemotePathCandidates(remotePath);
        return candidates.FirstOrDefault() ?? remotePath;
    }

    static async Task<Game> PickOrCreateGame(Config cfg, string preselectName)
    {
        if (!string.IsNullOrEmpty(preselectName))
        {
            var matched = cfg.games.FirstOrDefault(g => g.name.Equals(preselectName, StringComparison.OrdinalIgnoreCase));
            if (matched != null) return matched;
            throw new Exception($"未找到名为 {preselectName} 的游戏。");
        }

        if (cfg.games.Count == 0)
        {
            AnsiConsole.MarkupLine("[yellow]尚未配置任何游戏，将创建新游戏。[/]");
            return await CreateGame(cfg);
        }

        var choices = cfg.games.Select(g => $"{g.name} - {g.localPath}").ToList();
        choices.Add("新建游戏");

        var selected = AnsiConsole.Prompt(
            new SelectionPrompt<string>()
                .Title("[cyan]选择一个游戏：[/]")
                .AddChoices(choices)
        );

        if (selected == "新建游戏")
            return await CreateGame(cfg);

        return cfg.games[choices.IndexOf(selected)];
    }


    static async Task<Game> CreateGame(Config cfg)
    {
        var name = AnsiConsole.Ask<string>("[yellow]输入游戏名称：[/]");
        var localPath = AnsiConsole.Ask<string>("[yellow]输入本地存档目录路径：[/]");
        var remotePath = AnsiConsole.Ask<string>("[yellow]输入远程存档完整路径：[/]");
        var game = new Game
        {
            name = name,
            localPath = Path.GetFullPath(localPath),
            remoteFullPath = remotePath.Replace("\\", "/")
        };
        Directory.CreateDirectory(game.localPath);
        cfg.games.Add(game);
        SaveConfig(cfg);
        return game;
    }

    static async Task<Game> EnsureGameRemotePath(Game game, Config cfg)
    {
        if (!string.IsNullOrWhiteSpace(game.remoteFullPath))
        {
            game.remoteFullPath = game.remoteFullPath.Trim().Replace('\\', '/');
            return game;
        }
        Console.Write($"为 {game.name} 输入远程存档完整路径：");
        var remoteFullPath = Console.ReadLine() ?? "";
        if (string.IsNullOrWhiteSpace(remoteFullPath)) throw new Exception("必填");
        game.remoteFullPath = remoteFullPath.Trim().Replace('\\', '/');
        SaveConfig(cfg);
        return game;
    }

    static async Task<RemoteConfig> EnsureRemote(Config cfg)
    {
        var r = cfg.remote ?? new RemoteConfig();
        if (string.IsNullOrWhiteSpace(r.host))
        {
            Console.Write("远程 SSH 地址（IP 或域名）：");
            r.host = Console.ReadLine() ?? "";
        }
        if (r.port == 0) r.port = 22;
        if (string.IsNullOrWhiteSpace(r.user))
        {
            Console.Write("远程用户名：");
            r.user = Console.ReadLine() ?? "";
        }
        if (string.IsNullOrWhiteSpace(r.password))
        {
            Console.Write("远程密码（输入后按回车）：");
            r.password = ReadPassword();
        }
        if (string.IsNullOrWhiteSpace(cfg.preferScpTool))
        {
            cfg.preferScpTool = "auto";
        }
        cfg.remote = r;
        SaveConfig(cfg);
        return r;
    }

    static string ReadPassword()
    {
        var pw = string.Empty;
        ConsoleKey key;
        do
        {
            var keyInfo = Console.ReadKey(true);
            key = keyInfo.Key;
            if (key == ConsoleKey.Backspace && pw.Length > 0)
            {
                pw = pw.Substring(0, pw.Length - 1);
                Console.Write("\b \b");
            }
            else if (!char.IsControl(keyInfo.KeyChar))
            {
                pw += keyInfo.KeyChar;
                Console.Write('*');
            }
        } while (key != ConsoleKey.Enter);
        Console.WriteLine();
        return pw;
    }

    static async Task BackupLocal(Game game, string dest)
    {
        if (Directory.Exists(dest)) Directory.Delete(dest, true);
        CopyDirectory(game.localPath, dest);
        Console.WriteLine($"本地备份完成：{dest}");
    }

    static void CopyDirectory(string sourceDir, string destDir)
    {
        Directory.CreateDirectory(destDir);
        foreach (var dirPath in Directory.GetDirectories(sourceDir, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(dirPath.Replace(sourceDir, destDir));
        }
        foreach (var newPath in Directory.GetFiles(sourceDir, "*.*", SearchOption.AllDirectories))
        {
            File.Copy(newPath, newPath.Replace(sourceDir, destDir), true);
        }
    }

    static async Task<TResult> WithSftp<TResult>(RemoteConfig remote, Func<SftpClient, Task<TResult>> fn)
    {
        using (var sftp = new SftpClient(remote.host, remote.port, remote.user, remote.password))
        {
            sftp.ConnectionInfo.Timeout = TimeSpan.FromSeconds(30);
            sftp.OperationTimeout = TimeSpan.FromSeconds(30);
            try
            {
                sftp.Connect();
                return await fn(sftp);
            }
            finally
            {
                try { if (sftp.IsConnected) sftp.Disconnect(); } catch { }
            }
        }
    }

    static async Task BackupRemote(Game game, RemoteConfig remote, string dest)
    {
        var remotePath = GetRemoteDir(game);
        Directory.CreateDirectory(dest);
        await WithSftp(remote, async (sftp) =>
        {
            var (exists, resolved, error) = SftpExistsSync(sftp, remotePath);
            if (!exists)
            {
                Console.WriteLine($"远程目录不存在，已创建空目录备份记录：{remotePath}");
                if (error != null) Console.WriteLine($"远程 stat 错误信息：{error.Message}");
                return true;
            }
            await SftpDownloadDir(sftp, resolved, dest);
            return true;
        });
        Console.WriteLine($"远程备份完成：{dest}");
    }

    static (bool exists, string path, Exception error) SftpExistsSync(SftpClient sftp, string remotePath)
    {
        Exception lastError = null;
        foreach (var candidate in RemotePathCandidates(remotePath))
        {
            try
            {
                sftp.GetAttributes(candidate);
                return (true, candidate, null);
            }
            catch (Exception ex)
            {
                lastError = ex;
            }
        }
        return (false, remotePath, lastError);
    }

    static async Task SftpMkdirp(SftpClient sftp, string remoteDir)
    {
        var segs = remoteDir.Replace('\\', '/').Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
        var cur = remoteDir.StartsWith("/") ? "/" : "";
        foreach (var seg in segs)
        {
            cur = string.IsNullOrEmpty(cur) ? seg : $"{cur}/{seg}";
            try { if (!sftp.Exists(cur)) sftp.CreateDirectory(cur); } catch { }
        }
    }

    static async Task SftpRemoveRecursive(SftpClient sftp, string remoteDir)
    {
        var normalized = remoteDir.Replace('\\', '/').TrimEnd('/');
        var list = sftp.ListDirectory(normalized);
        foreach (var item in list)
        {
            if (item.Name == "." || item.Name == "..") continue;
            var rp = $"{normalized}/{item.Name}";
            if (item.IsDirectory)
            {
                await SftpRemoveRecursive(sftp, rp);
                try { sftp.DeleteDirectory(rp); } catch { }
            }
            else
            {
                try { sftp.DeleteFile(rp); } catch { }
            }
        }
    }

    static async Task<string> SftpEnsureDirEmpty(SftpClient sftp, string remoteDir)
    {
        var candidates = RemotePathCandidates(remoteDir);
        foreach (var candidate in candidates)
        {
            try
            {
                sftp.GetAttributes(candidate);
                await SftpRemoveRecursive(sftp, candidate);
                return candidate;
            }
            catch { }
        }
        var target = ToSftpPath(remoteDir);
        await SftpMkdirp(sftp, target);
        await SftpRemoveRecursive(sftp, target);
        return target;
    }

    static async Task SftpUploadDir(SftpClient sftp, string localDir, string remoteDir)
    {
        var target = ToSftpPath(remoteDir);
        await SftpMkdirp(sftp, target);
        foreach (var path in Directory.GetFileSystemEntries(localDir))
        {
            var name = Path.GetFileName(path);
            var rp = target.TrimEnd('/') + "/" + name;
            if (Directory.Exists(path))
            {
                await SftpUploadDir(sftp, path, rp);
            }
            else
            {
                using (var fs = File.OpenRead(path))
                {
                    sftp.UploadFile(fs, rp);
                }
            }
        }
    }

    static async Task SftpDownloadDir(SftpClient sftp, string remoteDir, string localDir)
    {
        Directory.CreateDirectory(localDir);
        var list = sftp.ListDirectory(remoteDir);
        foreach (var item in list)
        {
            if (item.Name == "." || item.Name == "..") continue;
            var rp = $"{remoteDir.TrimEnd('/')}/{item.Name}";
            var lp = Path.Combine(localDir, item.Name);
            if (item.IsDirectory)
            {
                await SftpDownloadDir(sftp, rp, lp);
            }
            else
            {
                using (var fs = File.OpenWrite(lp))
                {
                    sftp.DownloadFile(rp, fs);
                }
            }
        }
    }

    static (string scpPath, string pscpPath) DetectScpTools()
    {
        string scp = null, pscp = null;
        try
        {
            scp = FindInPath("scp");
        }
        catch { }
        try
        {
            pscp = FindInPath("pscp");
        }
        catch { }
        return (scp, pscp);
    }

    static string FindInPath(string name)
    {
        string cmd = Environment.OSVersion.Platform == PlatformID.Win32NT ? "where" : "which";
        var psi = new ProcessStartInfo(cmd, name) { RedirectStandardOutput = true, UseShellExecute = false };
        var p = Process.Start(psi);
        var outp = p.StandardOutput.ReadToEnd();
        p.WaitForExit();
        var first = outp.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        return first;
    }

    static Task RunCommand(string cmd, string args, bool inheritStdIo = true)
    {
        Console.WriteLine($"即将执行命令（含敏感信息）：{cmd} {args}");
        var tcs = new TaskCompletionSource<bool>();
        var psi = new ProcessStartInfo(cmd, args)
        {
            RedirectStandardOutput = !inheritStdIo,
            RedirectStandardError = !inheritStdIo,
            UseShellExecute = inheritStdIo,
        };
        var p = Process.Start(psi);
        p.EnableRaisingEvents = true;
        p.Exited += (s, e) =>
        {
            if (p.ExitCode == 0) tcs.SetResult(true);
            else tcs.SetException(new Exception($"{cmd} 退出码 {p.ExitCode}"));
            p.Dispose();
        };
        return tcs.Task;
    }

    static async Task SyncLocalToRemote_SCP(Game game, RemoteConfig remote)
    {
        var remoteDir = GetRemoteDir(game).Replace('\\','/');
        var (scpPath, pscpPath) = DetectScpTools();
        await WithSftp(remote, async (sftp) =>
        {
            Console.WriteLine($"通过 SFTP 清理远程目录：{remoteDir}");
            await SftpEnsureDirEmpty(sftp, remoteDir);
            return true;
        });
        if (!string.IsNullOrEmpty(pscpPath))
        {
            var localPattern = Path.Combine(game.localPath, "*");
            var args = $"-pw {EscapeArg(remote.password)} -r \"{localPattern}\" {remote.user}@{remote.host}:\"{remoteDir}/\"";
            await RunCommand(pscpPath, args);
        }
        else if (!string.IsNullOrEmpty(scpPath))
        {
            Console.WriteLine("检测到 scp，但无法传递密码。建议配置密钥登录或安装 pscp。将尝试执行 scp（可能会卡在密码输入）...");
            var localSource = $"{game.localPath.Replace('\\','/')}/.";
            var args = $"-r \"{localSource}\" {remote.user}@{remote.host}:\"{remoteDir}\"";
            await RunCommand(scpPath, args);
        }
        else
        {
            throw new Exception("未找到 scp 或 pscp。");
        }
    }

    static async Task SyncRemoteToLocal_SCP(Game game, RemoteConfig remote)
    {
        var remoteDir = GetRemoteDir(game).Replace('\\','/');
        var (scpPath, pscpPath) = DetectScpTools();
        Directory.CreateDirectory(game.localPath);
        async Task DownloadWith(string cmdPath, string args)
        {
            var tempDir = Path.Combine(Path.GetTempPath(), $"gsm_download_{DateTimeOffset.Now.ToUnixTimeMilliseconds()}");
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true);
            Directory.CreateDirectory(tempDir);
            try
            {
                await RunCommand(cmdPath, args + " " + $"\"{tempDir}\"");
                var remoteFolderName = remoteDir.Split('/').Where(s => !string.IsNullOrWhiteSpace(s)).LastOrDefault() ?? game.name;
                var downloadedRoot = Path.Combine(tempDir, remoteFolderName);
                var contentsExist = Directory.Exists(downloadedRoot);
                if (Directory.Exists(game.localPath)) Directory.Delete(game.localPath, true);
                Directory.CreateDirectory(game.localPath);
                if (contentsExist)
                {
                    CopyDirectory(downloadedRoot, game.localPath);
                }
                else
                {
                    CopyDirectory(tempDir, game.localPath);
                }
            }
            finally
            {
                try { Directory.Delete(tempDir, true); } catch { }
            }
        }
        if (!string.IsNullOrEmpty(pscpPath))
        {
            await DownloadWith(pscpPath, $"-pw {EscapeArg(remote.password)} -r {remote.user}@{remote.host}:\"{remoteDir}\"");
            return;
        }
        if (!string.IsNullOrEmpty(scpPath))
        {
            Console.WriteLine("检测到 scp，但无法传递密码。建议配置密钥登录或安装 pscp。将尝试执行 scp（可能会卡在密码输入）...");
            await DownloadWith(scpPath, $"-r {remote.user}@{remote.host}:\"{remoteDir}\"");
            return;
        }
        throw new Exception("未找到 scp 或 pscp。");
    }

    static string EscapeArg(string s)
    {
        if (s == null) return "";
        return s.Replace("\"", "\\\"");
    }

    static async Task SyncLocalToRemote_SFTP(Game game, RemoteConfig remote)
    {
        await WithSftp(remote, async (sftp) =>
        {
            var remoteDir = GetRemoteDir(game);
            Console.WriteLine($"SFTP 上传目标目录：{remoteDir}");
            var target = await SftpEnsureDirEmpty(sftp, remoteDir);
            await SftpUploadDir(sftp, game.localPath, target);
            return true;
        });
    }

    static async Task SyncRemoteToLocal_SFTP(Game game, RemoteConfig remote)
    {
        await WithSftp(remote, async (sftp) =>
        {
            var remoteDir = GetRemoteDir(game);
            Console.WriteLine($"SFTP 下载源目录：{remoteDir}");
            var (exists, resolved, error) = SftpExistsSync(sftp, remoteDir);
            if (!exists)
            {
                Console.WriteLine($"远程目录不存在，已在本地确保目录存在：{remoteDir}");
                if (error != null) Console.WriteLine($"远程 stat 错误信息：{error.Message}");
                if (Directory.Exists(game.localPath)) Directory.Delete(game.localPath, true);
                Directory.CreateDirectory(game.localPath);
                return true;
            }
            if (Directory.Exists(game.localPath)) Directory.Delete(game.localPath, true);
            Directory.CreateDirectory(game.localPath);
            await SftpDownloadDir(sftp, resolved, game.localPath);
            return true;
        });
    }

    static async Task BackupBoth(Game game, RemoteConfig remote)
    {
        var root = Path.Combine(BACKUP_DIR, $"{game.name}_{Timestamp()}");
        var localDest = Path.Combine(root, "local");
        var remoteDest = Path.Combine(root, "remote");
        await BackupLocal(game, localDest);
        await BackupRemote(game, remote, remoteDest);
    }

    static async Task BackupLocalOnly(Game game)
    {
        var root = Path.Combine(BACKUP_DIR, $"{game.name}_{Timestamp()}");
        var localDest = Path.Combine(root, "local");
        await BackupLocal(game, localDest);
        Console.WriteLine($"本地存档备份已完成（仅备份模式）：{localDest}");
    }

    static async Task TestSftpConnection(Game game, RemoteConfig remote)
    {
        Console.WriteLine($"正在测试 SFTP 连接：{remote.user}@{remote.host}:{remote.port}");
        try
        {
            await WithSftp(remote, async (sftp) =>
            {
                Console.WriteLine("SFTP 连通性测试成功。");
                var remoteDir = GetRemoteDir(game);
                var variants = RemotePathCandidates(remoteDir);
                Console.WriteLine($"准备访问的远程目录：{string.Join(" | ", variants)}");
                var (exists, errorPath, error) = SftpExistsSync(sftp, remoteDir);
                if (exists)
                {
                    Console.WriteLine("检测到远程目录存在，将尝试读取内容。");
                }
                else
                {
                    Console.WriteLine("远程目录暂不存在，在后续同步时会自动创建。");
                    if (error != null) Console.WriteLine($"远程 stat 错误信息：{error.Message}");
                }
                return true;
            });
        }
        catch (Exception ex)
        {
            Console.WriteLine("SFTP 测试失败，请检查主机/账号/密码：" + ex.Message);
            throw;
        }
    }

    static string NormalizeDirectionInput(string input)
    {
        if (string.IsNullOrWhiteSpace(input)) return null;
        var normalized = input.Trim().ToLowerInvariant();
        switch (normalized)
        {
            case "local2remote":
            case "push":
            case "upload":
            case "l2r":
                return "push";
            case "remote2local":
            case "pull":
            case "download":
            case "r2l":
                return "pull";
            case "backup":
            case "backuplocal":
            case "localbackup":
            case "backup-only":
            case "backup_local":
                return "backupLocal";
            default:
                return null;
        }
    }

    static string DirectionLabel(string direction)
    {
        switch (direction)
        {
            case "push": return "本地 -> 远程";
            case "pull": return "远程 -> 本地";
            case "backupLocal": return "仅备份本地存档";
            default: return direction;
        }
    }
    
    static async Task<string> ResolveDirection(string arg)
    {
        if (!string.IsNullOrEmpty(arg)) return arg;
        var choice = AnsiConsole.Prompt(
            new SelectionPrompt<string>()
                .Title("[green]选择操作：[/]")
                .AddChoices("push - 本地 -> 远程", "pull - 远程 -> 本地", "backupLocal - 仅备份本地存档")
        );
        return choice.Split(' ')[0];
    }

    // static async Task<string> ResolveDirection(string argDirection)
    // {
    //     if (argDirection != null)
    //     {
    //         var mapped = NormalizeDirectionInput(argDirection);
    //         if (mapped == null) throw new Exception($"无法识别 --direction 参数 \"{argDirection}\"，可选值：local2remote、remote2local、backup");
    //         Console.WriteLine($"已通过命令行参数选择操作：{DirectionLabel(mapped)}");
    //         return mapped;
    //     }
    //     Console.WriteLine("选择操作：");
    //     Console.WriteLine("1: 本地 -> 远程（用本地覆盖远程）");
    //     Console.WriteLine("2: 远程 -> 本地（用远程覆盖本地）");
    //     Console.WriteLine("3: 仅备份本地存档");
    //     Console.Write("输入序号：");
    //     var input = Console.ReadLine();
    //     return input switch
    //     {
    //         "1" => "push",
    //         "2" => "pull",
    //         "3" => "backupLocal",
    //         _ => throw new Exception("无效选择")
    //     };
    // }

    static async Task<int> MainAsync(string[] args)
    {
        EnsureDirs();
        var parsed = ParseArgs(args);
        var cfg = LoadConfig();
        var game = await PickOrCreateGame(cfg, parsed.ContainsKey("game") ? parsed["game"] : null);
        var direction = await ResolveDirection(parsed.ContainsKey("direction") ? parsed["direction"] : null);
        if (direction == "backupLocal")
        {
            await BackupLocalOnly(game);
            return 0;
        }
        var remote = await EnsureRemote(cfg);
        var ensuredGame = await EnsureGameRemotePath(game, cfg);
        await TestSftpConnection(ensuredGame, remote);
        Console.WriteLine("开始备份本地与远程...");
        await BackupBoth(ensuredGame, remote);
        var prefer = cfg.preferScpTool ?? "auto";
        bool canUseScp = !string.IsNullOrEmpty(DetectScpTools().scpPath) || !string.IsNullOrEmpty(DetectScpTools().pscpPath);
        try
        {
            if (direction == "push")
            {
                if (prefer == "scp" && canUseScp) await SyncLocalToRemote_SCP(ensuredGame, remote);
                else await SyncLocalToRemote_SFTP(ensuredGame, remote);
                Console.WriteLine("同步完成（本地 -> 远程）。");
            }
            else
            {
                if (prefer == "scp" && canUseScp) await SyncRemoteToLocal_SCP(ensuredGame, remote);
                else await SyncRemoteToLocal_SFTP(ensuredGame, remote);
                Console.WriteLine("同步完成（远程 -> 本地）。");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("同步失败：" + ex.Message);
            return 1;
        }
        return 0;
    }

    static int Main(string[] args)
    {
        while(true){
            try
            {
                var task = MainAsync(args);
                task.Wait();
                Console.WriteLine("按回车键继续...");
                Console.ReadLine();
                // return task.Result;
            }
            catch (AggregateException aex)
            {
                Console.WriteLine(aex.InnerException?.Message ?? aex.Message);
                return 1;
            }
            catch (Exception ex)
            {
                Console.WriteLine(ex.Message);
                return 1;
            }

        }
    }
}
