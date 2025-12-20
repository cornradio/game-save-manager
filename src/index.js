import fs from 'fs';
import fse from 'fs-extra';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';
import dayjs from 'dayjs';
import which from 'which';
import { spawn } from 'child_process';
import SFTPClient from 'ssh2-sftp-client';
import http from 'http';
import net from 'net';

// 全局错误处理，防止进程崩溃
process.on('uncaughtException', (err) => {
	console.error('未捕获的异常:', err);
	// 不退出进程，让服务器继续运行
});

process.on('unhandledRejection', (reason, promise) => {
	console.error('未处理的Promise拒绝:', reason);
	// 不退出进程，让服务器继续运行
});

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const BACKUP_DIR = path.join(ROOT, 'backups');

function parseArgs(argv = []) {
	const result = {};
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (!token.startsWith('--')) continue;
		const stripped = token.slice(2);
		if (!stripped) continue;
		const eqIndex = stripped.indexOf('=');
		if (eqIndex !== -1) {
			const key = stripped.slice(0, eqIndex);
			const value = stripped.slice(eqIndex + 1);
			result[key] = value;
			continue;
		}
		const next = argv[i + 1];
		if (next && !next.startsWith('--')) {
			result[stripped] = next;
			i += 1;
		} else {
			result[stripped] = true;
		}
	}
	return result;
}

function ensureDirs() {
	if (!fs.existsSync(DATA_DIR)) fse.mkdirpSync(DATA_DIR);
	if (!fs.existsSync(BACKUP_DIR)) fse.mkdirpSync(BACKUP_DIR);
}

function loadConfig() {
	ensureDirs();
	if (!fs.existsSync(CONFIG_PATH)) {
		const defaultCfg = { games: [], remote: { host: '', port: 22, user: '', password: '' }, preferScpTool: 'auto' };
		fse.writeJsonSync(CONFIG_PATH, defaultCfg, { spaces: 2 });
		return defaultCfg;
	}
	return fse.readJsonSync(CONFIG_PATH);
}

function saveConfig(cfg) {
	fse.writeJsonSync(CONFIG_PATH, cfg, { spaces: 2 });
}

function timestamp() {
	return dayjs().format('YYYYMMDD_HHmmss');
}

function getDirSize(dirPath) {
	let size = 0;
	try {
		const files = fs.readdirSync(dirPath);
		for (const file of files) {
			const filePath = path.join(dirPath, file);
			const stats = fs.statSync(filePath);
			if (stats.isDirectory()) {
				size += getDirSize(filePath);
			} else {
				size += stats.size;
			}
		}
	} catch (err) {
		console.error(`Error calculating size for ${dirPath}:`, err);
	}
	return size;
}

async function openConfigFile() {
	console.log(`即将打开配置文件：${CONFIG_PATH}`);
	try {
		const child = spawn('code', [CONFIG_PATH], { detached: true, stdio: 'ignore', shell: true });
		child.unref();
		console.log('配置文件已在 VSCode 中打开。');
	} catch (spawnError) {
		console.error(`无法自动打开 VSCode。请手动打开文件：${CONFIG_PATH}`, spawnError);
	}
}

async function openBackupDir() {
	console.log(`即将打开备份文件所在目录：${BACKUP_DIR}`);
	try {
		const platform = os.platform();
		const command = platform === 'win32' ? 'explorer' : (platform === 'darwin' ? 'open' : 'xdg-open');
		const child = spawn(command, [BACKUP_DIR], { detached: true, stdio: 'ignore' });
		child.unref();
		console.log('目录已在文件浏览器中打开。');
	} catch (spawnError) {
		console.error(`无法自动打开目录。请手动打开：${BACKUP_DIR}`, spawnError);
	}
}

function getRemoteDir(game, remote) {
	if (game.remoteFullPath && typeof game.remoteFullPath === 'string' && game.remoteFullPath.trim().length > 0) {
		return game.remoteFullPath.trim().replace(/\\/g, '/');
	}
	throw new Error(`游戏 ${game.name} 未配置 remoteFullPath，请重新设置。`);
}

function remotePathCandidates(remotePath) {
	const cleaned = remotePath.replace(/\\/g, '/').replace(/\/+$/, '');
	const list = [];
	if (/^[A-Za-z]:\//.test(cleaned) && !cleaned.startsWith('/')) {
		list.push(`/${cleaned}`);
	}
	list.push(cleaned);
	return Array.from(new Set(list.map(p => p.replace(/\/+/g, '/'))));
}

function toSftpPath(remotePath) {
	return remotePathCandidates(remotePath)[0] || remotePath;
}

async function pickOrCreateGame(cfg, preselectName) {
	if (preselectName) {
		const matched = cfg.games.find(g => g.name === preselectName);
		if (!matched) {
			throw new Error(`未找到名为 "${preselectName}" 的游戏，请先通过交互界面创建。`);
		}
		console.log(`已通过命令行参数选择游戏：${matched.name}`);
		return matched;
	}

	const choices = cfg.games.map((g, idx) => ({ name: `${g.name}  - ${g.localPath}`, value: idx }));
	if (cfg.games.length > 0) {
		choices.push(new inquirer.Separator());
	}
	choices.push({ name: '新建游戏', value: -1 });
	choices.push({ name: '打开存档备份文件夹', value: 'openBackupDir' });
	choices.push({ name: '编辑配置文件', value: 'editConfig' });
	choices.push({ name: '退出程序', value: 'exit' });

	const { selection } = await inquirer.prompt([
		{ type: 'list', name: 'selection', message: '选择一个游戏或操作：', choices, pageSize: 15 }
	]);

	if (selection === 'editConfig') {
		await openConfigFile();
		return null;
	}
	if (selection === 'openBackupDir') {
		await openBackupDir();
		return null;
	}
	if (selection === -1) {
		return await createGame(cfg);
	}
	if (selection === 'exit') {
		console.log('程序退出。');
		process.exit(0);
	}
	return cfg.games[selection];
}

async function createGame(cfg) {
	const ans = await inquirer.prompt([
		{ type: 'input', name: 'name', message: '输入游戏名称（用于区分与远程目录名）：', validate: v => v ? true : '必填' },
		{ type: 'input', name: 'localPath', message: '输入本地存档目录路径：', validate: v => v ? true : '必填' },
		{ type: 'input', name: 'remoteFullPath', message: '输入远程存档完整路径：', validate: v => v ? true : '必填' }
	]);
	const remoteFullPath = ans.remoteFullPath ? ans.remoteFullPath.trim() : '';
	const game = {
		name: ans.name.trim(),
		localPath: path.resolve(ans.localPath.trim()),
		...(remoteFullPath ? { remoteFullPath: remoteFullPath.replace(/\\/g, '/') } : {})
	};
	// 确保本地目录存在
	fse.mkdirpSync(game.localPath);
	cfg.games.push(game);
	saveConfig(cfg);
	console.log(`已创建游戏：${game.name} -> ${game.localPath}`);
	return game;
}

async function ensureGameRemotePath(game, cfg) {
	if (game.remoteFullPath && game.remoteFullPath.trim()) {
		game.remoteFullPath = game.remoteFullPath.trim().replace(/\\/g, '/');
		return game;
	}
	const { remoteFullPath } = await inquirer.prompt([
		{ type: 'input', name: 'remoteFullPath', message: `为 ${game.name} 输入远程存档完整路径：`, validate: v => v ? true : '必填' }
	]);
	game.remoteFullPath = remoteFullPath.trim().replace(/\\/g, '/');
	saveConfig(cfg);
	return game;
}

async function ensureRemote(cfg) {
	const r = cfg.remote || {};
	const questions = [];
	if (!r.host) questions.push({ type: 'input', name: 'host', message: '远程 SSH 地址（IP 或域名）：', validate: v => v ? true : '必填' });
	if (!r.port) questions.push({ type: 'number', name: 'port', message: 'SSH 端口：', default: 22 });
	if (!r.user) questions.push({ type: 'input', name: 'user', message: '远程用户名：', validate: v => v ? true : '必填' });
	if (!r.password) questions.push({ type: 'password', name: 'password', message: '远程密码：', mask: '*' });
	if (cfg.preferScpTool === undefined) questions.push({
		type: 'list', name: 'preferScpTool', message: '文件传输方式：',
		choices: [
			{ name: '自动（优先 SFTP，无需外部命令）', value: 'auto' },
			{ name: '强制 scp/pscp（需系统安装）', value: 'scp' }
		], default: 'auto'
	});
	if (questions.length > 0) {
		const ans = await inquirer.prompt(questions);
		cfg.remote = { ...r, ...ans, port: ans.port ?? r.port ?? 22 };
		if (ans.preferScpTool) cfg.preferScpTool = ans.preferScpTool;
		saveConfig(cfg);
	}
	return cfg.remote;
}

async function backupLocal(game, dest) {
	await fse.copy(game.localPath, dest, { overwrite: true, errorOnExist: false });
	console.log(`本地备份完成：${dest}`);
}

async function withSFTP(remote, fn) {
	const sftp = new SFTPClient();
	try {
		await sftp.connect({
			host: remote.host,
			port: remote.port || 22,
			username: remote.user,
			password: remote.password,
			readyTimeout: 30000
		});
		return await fn(sftp);
	} finally {
		try { await sftp.end(); } catch { }
	}
}

async function backupRemote(game, remote, dest) {
	const remotePath = getRemoteDir(game, remote);
	await fse.mkdirp(dest);
	await withSFTP(remote, async (sftp) => {
		// 若远程目录不存在，跳过下载但仍创建一个空备份目录
		const { exists, path: resolvedPath, error } = await sftpExists(sftp, remotePath);
		if (!exists) {
			console.log(`远程目录不存在，已创建空目录备份记录：${remotePath}`);
			if (error) {
				console.log(`远程 stat 错误信息：${error.message || String(error)}`);
			}
			return;
		}
		await sftpDownloadDir(sftp, resolvedPath, dest);
	});
	console.log(`远程备份完成：${dest}`);
}

async function sftpExists(sftp, remotePath) {
	let lastError = null;
	for (const candidate of remotePathCandidates(remotePath)) {
		try {
			await sftp.stat(candidate);
			return { exists: true, path: candidate };
		} catch (err) {
			lastError = err;
		}
	}
	return { exists: false, path: remotePath, error: lastError };
}

async function sftpMkdirp(sftp, remoteDir) {
	const segs = remoteDir.replace(/\\/g, '/').split('/').filter(Boolean);
	let cur = remoteDir.startsWith('/') ? '/' : '';
	for (const seg of segs) {
		cur = cur ? `${cur}/${seg}`.replace(/\/+/, '/') : seg;
		try { await sftp.mkdir(cur); } catch { }
	}
}

async function sftpRemoveRecursive(sftp, remoteDir) {
	const normalized = remoteDir.replace(/\\/g, '/').replace(/\/+$/, '');
	const list = await sftp.list(normalized);
	for (const item of list) {
		const rp = `${normalized}/${item.name}`;
		if (item.type === 'd') {
			await sftpRemoveRecursive(sftp, rp);
			try { await sftp.rmdir(rp); } catch { }
		} else {
			try { await sftp.delete(rp); } catch { }
		}
	}
}

async function sftpEnsureDirEmpty(sftp, remoteDir) {
	const candidates = remotePathCandidates(remoteDir);
	for (const candidate of candidates) {
		try {
			await sftp.stat(candidate);
			await sftpRemoveRecursive(sftp, candidate);
			return candidate;
		} catch { }
	}
	const target = toSftpPath(remoteDir);
	await sftpMkdirp(sftp, target);
	await sftpRemoveRecursive(sftp, target);
	return target;
}

async function sftpUploadDir(sftp, localDir, remoteDir) {
	const target = toSftpPath(remoteDir);
	await sftpMkdirp(sftp, target);
	const items = await fse.readdir(localDir);
	for (const name of items) {
		const lp = path.join(localDir, name);
		const rp = target.replace(/\\/g, '/').replace(/\/$/, '') + '/' + name;
		const stat = await fse.stat(lp);
		if (stat.isDirectory()) {
			await sftpUploadDir(sftp, lp, rp);
		} else {
			await sftp.fastPut(lp, rp);
		}
	}
}

async function sftpDownloadDir(sftp, remoteDir, localDir) {
	await fse.mkdirp(localDir);
	const list = await sftp.list(remoteDir);
	for (const item of list) {
		const rp = `${remoteDir.replace(/\\/g, '/').replace(/\/$/, '')}/${item.name}`;
		const lp = path.join(localDir, item.name);
		if (item.type === 'd') {
			await sftpDownloadDir(sftp, rp, lp);
		} else {
			await sftp.fastGet(rp, lp);
		}
	}
}

function detectScpTools() {
	let scpPath = null;
	let pscpPath = null;
	try { scpPath = which.sync('scp'); } catch { }
	try { pscpPath = which.sync('pscp'); } catch { }
	return { scpPath, pscpPath };
}

function runCommand(cmd, args, options = {}) {
	const commandLine = `${cmd} ${args.join(' ')}`.trim();
	console.log(`即将执行命令（含敏感信息）：${commandLine}`);
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: 'inherit', shell: false, ...options });
		child.on('error', reject);
		child.on('exit', code => {
			if (code === 0) resolve();
			else reject(new Error(`${cmd} 退出码 ${code}`));
		});
	});
}

async function syncLocalToRemote_SCP(game, remote) {
	const remoteDir = getRemoteDir(game, remote).replace(/\\/g, '/');
	const { scpPath, pscpPath } = detectScpTools();
	await withSFTP(remote, async (sftp) => {
		console.log(`通过 SFTP 清理远程目录：${remoteDir}`);
		await sftpEnsureDirEmpty(sftp, remoteDir);
	});
	if (pscpPath) {
		// PuTTY pscp 支持 -pw 非交互，使用通配符推送目录内容
		const localPattern = path.join(game.localPath, '*');
		await runCommand(pscpPath, ['-pw', remote.password, '-r', localPattern, `${remote.user}@${remote.host}:"${remoteDir}/"`]);
	} else if (scpPath) {
		// scp 无法安全传密码，若远端未配置免密，这一步会失败
		console.warn('检测到 scp，但无法传递密码。建议配置密钥登录或安装 pscp。将尝试执行 scp（可能会卡在密码输入）...');
		const localSource = `${game.localPath.replace(/\\/g, '/')}/.`;
		await runCommand(scpPath, ['-r', localSource, `${remote.user}@${remote.host}:"${remoteDir}"`]);
	} else {
		throw new Error('未找到 scp 或 pscp。');
	}
}

async function syncRemoteToLocal_SCP(game, remote) {
	const remoteDir = getRemoteDir(game, remote).replace(/\\/g, '/');
	const { scpPath, pscpPath } = detectScpTools();
	await fse.mkdirp(game.localPath);
	const downloadWith = async (cmdPath, args) => {
		const tempDir = path.join(os.tmpdir(), `gsm_download_${Date.now()}`);
		await fse.emptyDir(tempDir);
		try {
			await runCommand(cmdPath, args.concat(tempDir));
			const remoteFolderName = remoteDir.split('/').filter(Boolean).pop() || game.name;
			const downloadedRoot = path.join(tempDir, remoteFolderName);
			const contentsExist = fs.existsSync(downloadedRoot);
			await fse.emptyDir(game.localPath);
			if (contentsExist) {
				await fse.copy(downloadedRoot, game.localPath, { overwrite: true });
			} else {
				// 某些实现会直接把内容放在 tempDir 下
				await fse.copy(tempDir, game.localPath, { overwrite: true });
			}
		} finally {
			try { await fse.remove(tempDir); } catch { }
		}
	};
	if (pscpPath) {
		await downloadWith(pscpPath, ['-pw', remote.password, '-r', `${remote.user}@${remote.host}:"${remoteDir}"`]);
		return;
	}
	if (scpPath) {
		console.warn('检测到 scp，但无法传递密码。建议配置密钥登录或安装 pscp。将尝试执行 scp（可能会卡在密码输入）...');
		await downloadWith(scpPath, ['-r', `${remote.user}@${remote.host}:"${remoteDir}"`]);
		return;
	}
	throw new Error('未找到 scp 或 pscp。');
}

async function syncLocalToRemote_SFTP(game, remote) {
	await withSFTP(remote, async (sftp) => {
		const remoteDir = getRemoteDir(game, remote);
		console.log(`SFTP 上传目标目录：${remoteDir}`);
		const target = await sftpEnsureDirEmpty(sftp, remoteDir);
		await sftpUploadDir(sftp, game.localPath, target);
	});
}

async function syncRemoteToLocal_SFTP(game, remote) {
	await withSFTP(remote, async (sftp) => {
		const remoteDir = getRemoteDir(game, remote);
		console.log(`SFTP 下载源目录：${remoteDir}`);
		const { exists, path: resolved, error } = await sftpExists(sftp, remoteDir);
		if (!exists) {
			console.log(`远程目录不存在，已在本地确保目录存在：${remoteDir}`);
			if (error) {
				console.log(`远程 stat 错误信息：${error.message || String(error)}`);
			}
			await fse.emptyDir(game.localPath);
			return;
		}
		await fse.emptyDir(game.localPath);
		await sftpDownloadDir(sftp, resolved, game.localPath);
	});
}

async function writeBackupLog(root, game, type, filename = 'backup.log') {
	const logPath = path.join(root, filename);
	const content = [
		`Timestamp: ${new Date().toISOString()}`,
		`Game: ${game.name}`,
		`Type: ${type}`,
		`Local Path: ${game.localPath}`,
		`Remote Path: ${game.remoteFullPath || 'N/A'}`,
		`Status: Success`,
		'----------------------------------------',
		''
	].join('\n');
	await fse.appendFile(logPath, content);
}

async function backupBoth(game, remote, direction) {
	if (game.nobackup) {
		console.log(`\n[配置] 游戏 "${game.name}" 已设置 nobackup=true，跳过备份步骤，直接进行同步。`);
		return;
	}

	const root = path.join(BACKUP_DIR, `${game.name}_${timestamp()}`);
	const localDest = path.join(root, 'local');
	const remoteDest = path.join(root, 'remote');
	await backupLocal(game, localDest);
	await backupRemote(game, remote, remoteDest);

	let logName = 'backup.log';
	let type = 'Full Backup';
	if (direction === 'push') {
		logName = 'local-to-remote.log';
		type = 'Pre-push Backup (Local -> Remote)';
	} else if (direction === 'pull') {
		logName = 'remote-to-local.log';
		type = 'Pre-pull Backup (Remote -> Local)';
	}
	await writeBackupLog(root, game, type, logName);
}

async function backupLocalOnly(game) {
	const root = path.join(BACKUP_DIR, `${game.name}_${timestamp()}`);
	const localDest = path.join(root, 'local');
	await backupLocal(game, localDest);
	await writeBackupLog(root, game, 'Local Only Backup', 'local-backup.log');
	console.log(`本地存档备份已完成（仅备份模式）：${localDest}`);
}

async function reconfigureRemote(cfg) {
	console.log('请重新输入 SSH 连接信息：');
	const ans = await inquirer.prompt([
		{ type: 'input', name: 'host', message: '远程 SSH 地址（IP 或域名）：', default: cfg.remote?.host, validate: v => v ? true : '必填' },
		{ type: 'number', name: 'port', message: 'SSH 端口：', default: cfg.remote?.port ?? 22 },
		{ type: 'input', name: 'user', message: '远程用户名：', default: cfg.remote?.user, validate: v => v ? true : '必填' },
		{ type: 'password', name: 'password', message: '远程密码：', mask: '*' }
	]);
	cfg.remote = { ...cfg.remote, ...ans };
	saveConfig(cfg);
	console.log('配置已更新。');
}

async function handleSshError(err, cfg) {
	console.error('\nSFTP 测试失败，请检查主机/账号/密码：', err.message || err);
	const { reconfigure } = await inquirer.prompt([{
		type: 'confirm',
		name: 'reconfigure',
		message: '是否现在手动重新输入连接信息？',
		default: true
	}]);

	if (reconfigure) {
		await reconfigureRemote(cfg);
	}
}

async function testSftpConnection(game, remote) {
	console.log(`正在测试 SFTP 连接：${remote.user}@${remote.host}:${remote.port || 22}`);
	// Throws on error, to be caught by run()
	await withSFTP(remote, async (sftp) => {
		console.log('SFTP 连通性测试成功。');
		const remoteDir = getRemoteDir(game, remote);
		const variants = remotePathCandidates(remoteDir);
		console.log(`准备访问的远程目录：${variants.join(' | ')}`);
		const { exists, error } = await sftpExists(sftp, remoteDir);
		if (exists) {
			console.log('检测到远程目录存在，将尝试读取内容。');
		} else {
			console.log('远程目录暂不存在，在后续同步时会自动创建。');
			if (error) {
				console.log(`远程 stat 错误信息：${error.message || String(error)}`);
			}
		}
	});
}

function normalizeDirectionInput(input) {
	if (!input) return null;
	const normalized = String(input).toLowerCase();
	switch (normalized) {
		case 'local2remote':
		case 'push':
		case 'upload':
		case 'l2r':
			return 'push';
		case 'remote2local':
		case 'pull':
		case 'download':
		case 'r2l':
			return 'pull';
		case 'backup':
		case 'backuplocal':
		case 'localbackup':
		case 'backup-only':
		case 'backup_local':
			return 'backupLocal';
		default:
			return null;
	}
}

function directionLabel(direction) {
	switch (direction) {
		case 'push': return '本地 -> 远程';
		case 'pull': return '远程 -> 本地';
		case 'backupLocal': return '仅备份本地存档';
		default: return direction;
	}
}

async function resolveDirection(argDirection) {
	if (argDirection !== undefined) {
		const mappedFromArg = normalizeDirectionInput(argDirection);
		if (!mappedFromArg) {
			throw new Error(`无法识别 --direction 参数 "${argDirection}"，可选值：local2remote、remote2local、backup`);
		}
		console.log(`已通过命令行参数选择操作：${directionLabel(mappedFromArg)}`);
		return mappedFromArg;
	}
	const { direction } = await inquirer.prompt([
		{
			type: 'list',
			name: 'direction',
			message: '选择操作：',
			choices: [
				{ name: '本地 -> 远程（用本地覆盖远程）', value: 'push' },
				{ name: '远程 -> 本地（用远程覆盖本地）', value: 'pull' },
				{ name: '仅备份本地存档', value: 'backupLocal' }
			]
		}
	]);
	return direction;
}

// 检查端口是否可用
function isPortAvailable(port) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.listen(port, () => {
			server.once('close', () => resolve(true));
			server.close();
		});
		server.on('error', () => resolve(false));
	});
}

// 查找可用端口
async function findAvailablePort(startPort = 8080, maxAttempts = 20) {
	for (let i = 0; i < maxAttempts; i++) {
		const port = startPort + i;
		const available = await isPortAvailable(port);
		if (available) {
			return port;
		}
	}
	throw new Error(`无法找到可用端口（尝试了 ${startPort} 到 ${startPort + maxAttempts - 1}）`);
}

async function startWebServer() {
	// 自动查找可用端口
	let port;
	try {
		port = await findAvailablePort(9123, 20);
		if (port !== 9123) {
			console.log(`端口 9123 被占用，自动切换到端口 ${port}`);
		}
	} catch (error) {
		console.error('无法启动服务器:', error.message);
		process.exit(1);
	}

	const server = http.createServer((req, res) => {
		// 包装异步处理，确保错误被捕获
		(async () => {
			try {
				if (req.url === '/' && req.method === 'GET') {
			const htmlPath = path.join(ROOT, 'src', 'index.html');
			fs.readFile(htmlPath, (err, data) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'text/plain' });
					res.end('Error loading index.html');
					return;
				}
				res.writeHead(200, { 'Content-Type': 'text/html' });
				res.end(data);
			});
		} else if (req.url === '/api/games' && req.method === 'GET') {
			try {
				const cfg = loadConfig();
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(cfg.games || []));
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Failed to load config' }));
			}
		} else if (req.url === '/api/games' && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', async () => {
				try {
					const gameData = JSON.parse(body);
					const cfg = loadConfig();
					
					// 验证必填字段
					if (!gameData.name || !gameData.localPath) {
						throw new Error('游戏名称和本地路径为必填项');
					}
					
					// 检查游戏名称是否已存在
					if (cfg.games.find(g => g.name === gameData.name)) {
						throw new Error(`游戏 "${gameData.name}" 已存在`);
					}
					
					const game = {
						name: gameData.name.trim(),
						localPath: path.resolve(gameData.localPath.trim()),
						...(gameData.remoteFullPath ? { remoteFullPath: gameData.remoteFullPath.trim().replace(/\\/g, '/') } : {}),
						...(gameData.nobackup !== undefined ? { nobackup: gameData.nobackup } : {})
					};
					
					// 确保本地目录存在
					fse.mkdirpSync(game.localPath);
					
					cfg.games.push(game);
					saveConfig(cfg);
					
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ message: `游戏 "${game.name}" 已添加`, game }));
				} catch (error) {
					console.error('[Web API] Add game error:', error);
					if (!res.headersSent) {
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: error.message }));
					}
				}
			});
			req.on('error', (err) => {
				console.error('[Web API] Request error:', err);
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Request error' }));
				}
			});
		} else if (req.url.startsWith('/api/games/') && req.method === 'PUT') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', async () => {
				try {
					const parts = req.url.split('/');
					const oldGameName = decodeURIComponent(parts[3]);
					const gameData = JSON.parse(body);
					const cfg = loadConfig();
					
					const gameIndex = cfg.games.findIndex(g => g.name === oldGameName);
					if (gameIndex === -1) {
						throw new Error(`游戏 "${oldGameName}" 不存在`);
					}
					
					// 如果修改了名称，检查新名称是否已存在
					if (gameData.name && gameData.name !== oldGameName) {
						if (cfg.games.find(g => g.name === gameData.name && g.name !== oldGameName)) {
							throw new Error(`游戏名称 "${gameData.name}" 已存在`);
						}
					}
					
					// 更新游戏配置
					const updatedGame = {
						...cfg.games[gameIndex],
						...(gameData.name ? { name: gameData.name.trim() } : {}),
						...(gameData.localPath ? { localPath: path.resolve(gameData.localPath.trim()) } : {}),
						...(gameData.remoteFullPath !== undefined ? (gameData.remoteFullPath ? { remoteFullPath: gameData.remoteFullPath.trim().replace(/\\/g, '/') } : {}) : {}),
						...(gameData.nobackup !== undefined ? { nobackup: gameData.nobackup } : {})
					};
					
					// 确保本地目录存在
					if (updatedGame.localPath) {
						fse.mkdirpSync(updatedGame.localPath);
					}
					
					cfg.games[gameIndex] = updatedGame;
					saveConfig(cfg);
					
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ message: `游戏配置已更新`, game: updatedGame }));
				} catch (error) {
					console.error('[Web API] Update game error:', error);
					if (!res.headersSent) {
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: error.message }));
					}
				}
			});
			req.on('error', (err) => {
				console.error('[Web API] Request error:', err);
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Request error' }));
				}
			});
		} else if (req.url.startsWith('/api/games/') && req.method === 'DELETE') {
			try {
				const parts = req.url.split('/');
				const gameName = decodeURIComponent(parts[3]);
				const cfg = loadConfig();
				
				const gameIndex = cfg.games.findIndex(g => g.name === gameName);
				if (gameIndex === -1) {
					throw new Error(`游戏 "${gameName}" 不存在`);
				}
				
				cfg.games.splice(gameIndex, 1);
				saveConfig(cfg);
				
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ message: `游戏 "${gameName}" 已删除` }));
			} catch (error) {
				console.error('[Web API] Delete game error:', error);
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: error.message }));
				}
			}
		} else if (req.url.startsWith('/api/backups/') && req.method === 'GET') {
			try {
				const parts = req.url.split('/');
				const gameName = decodeURIComponent(parts[3]);
				
				if (!fs.existsSync(BACKUP_DIR)) {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ count: 0, backups: [] }));
					return;
				}
				
				const allBackups = fs.readdirSync(BACKUP_DIR);
				const gameBackups = allBackups.filter(dir => dir.startsWith(`${gameName}_`));
				
				// 如果只请求数量（旧API兼容）
				if (parts.length === 4) {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ count: gameBackups.length }));
					return;
				}
				
				// 如果请求详细列表
				if (parts.length === 5 && parts[4] === 'list') {
					const backupList = [];
					for (const backupName of gameBackups) {
						const backupPath = path.join(BACKUP_DIR, backupName);
						try {
							const stats = fs.statSync(backupPath);
							const localPath = path.join(backupPath, 'local');
							let size = 0;
							let hasLocal = false;
							let hasRemote = false;
							
							if (fs.existsSync(localPath)) {
								hasLocal = true;
								size += getDirSize(localPath);
							}
							
							const remotePath = path.join(backupPath, 'remote');
							if (fs.existsSync(remotePath)) {
								hasRemote = true;
								size += getDirSize(remotePath);
							}
							
							// 解析时间戳（格式：游戏名_YYYYMMDD_HHmmss）
							const timestampMatch = backupName.match(/_(\d{8}_\d{6})$/);
							let backupTime = stats.mtime;
							if (timestampMatch) {
								const ts = timestampMatch[1];
								const year = ts.substring(0, 4);
								const month = ts.substring(4, 6);
								const day = ts.substring(6, 8);
								const hour = ts.substring(9, 11);
								const minute = ts.substring(11, 13);
								const second = ts.substring(13, 15);
								backupTime = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
							}
							
							backupList.push({
								name: backupName,
								time: backupTime.toISOString(),
								size: size,
								hasLocal,
								hasRemote
							});
						} catch (err) {
							console.error(`Error reading backup ${backupName}:`, err);
						}
					}
					
					// 按时间倒序排列
					backupList.sort((a, b) => new Date(b.time) - new Date(a.time));
					
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ count: gameBackups.length, backups: backupList }));
					return;
				}
				
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid request' }));
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Failed to get backups', message: error.message }));
			}
		} else if (req.url.startsWith('/api/backups/') && req.method === 'DELETE') {
			try {
				const parts = req.url.split('/');
				const gameName = decodeURIComponent(parts[3]);
				const backupName = decodeURIComponent(parts[4]);
				
				if (!backupName || !backupName.startsWith(`${gameName}_`)) {
					throw new Error('Invalid backup name');
				}
				
				const backupPath = path.join(BACKUP_DIR, backupName);
				if (!fs.existsSync(backupPath)) {
					throw new Error('Backup not found');
				}
				
				await fse.remove(backupPath);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ message: `Backup ${backupName} deleted successfully` }));
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: error.message }));
			}
		} else if (req.url.startsWith('/api/backups/') && req.url.endsWith('/restore') && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', async () => {
				try {
					const parts = req.url.split('/');
					const gameName = decodeURIComponent(parts[3]);
					const backupName = decodeURIComponent(parts[4]);
					
					if (!backupName || !backupName.startsWith(`${gameName}_`)) {
						throw new Error('Invalid backup name');
					}
					
					const cfg = loadConfig();
					const game = cfg.games.find(g => g.name === gameName);
					if (!game) {
						throw new Error(`Game '${gameName}' not found`);
					}
					
					const backupPath = path.join(BACKUP_DIR, backupName);
					const localBackupPath = path.join(backupPath, 'local');
					
					if (!fs.existsSync(localBackupPath)) {
						throw new Error('Local backup not found');
					}
					
					// 先备份当前本地存档
					await backupLocalOnly(game);
					
					// 恢复备份
					await fse.emptyDir(game.localPath);
					await fse.copy(localBackupPath, game.localPath, { overwrite: true });
					
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ message: `Backup ${backupName} restored successfully` }));
				} catch (error) {
					console.error('[Web API] Restore backup error:', error);
					if (!res.headersSent) {
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: error.message }));
					}
				}
			});
			req.on('error', (err) => {
				console.error('[Web API] Request error:', err);
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Request error' }));
				}
			});
		} else if (req.url === '/api/open-backups-folder' && req.method === 'POST') {
			try {
				const platform = os.platform();
				const command = platform === 'win32' ? 'explorer' : (platform === 'darwin' ? 'open' : 'xdg-open');
				spawn(command, [BACKUP_DIR], { detached: true, stdio: 'ignore' }).unref();
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ message: 'Opened backups folder.' }));
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ message: error.message }));
			}
		} else if (req.url === '/api/open-config' && req.method === 'POST') {
			try {
				const platform = os.platform();
				const command = platform === 'win32' ? 'explorer' : (platform === 'darwin' ? 'open' : 'xdg-open');
				spawn(command, [CONFIG_PATH], { detached: true, stdio: 'ignore' }).unref();
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ message: 'Opened backups folder.' }));
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ message: error.message }));
			}
		} else if (req.url === '/api/open-folder' && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', async () => {
				try {
					const { game: gameName } = JSON.parse(body);
					const cfg = loadConfig();
					const game = cfg.games.find(g => g.name === gameName);
					if (!game) throw new Error(`Game '${gameName}' not found.`);

					const platform = os.platform();
					const command = platform === 'win32' ? 'explorer' : (platform === 'darwin' ? 'open' : 'xdg-open');
					spawn(command, [game.localPath], { detached: true, stdio: 'ignore' }).unref();

					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ message: `Opened folder for ${gameName}` }));
				} catch (error) {
					console.error('[Web API] Open folder error:', error);
					if (!res.headersSent) {
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ message: error.message }));
					}
				}
			});
			req.on('error', (err) => {
				console.error('[Web API] Request error:', err);
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Request error' }));
				}
			});
		} else if (req.url === '/api/open-backup-folder' && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', async () => {
				try {
					const { game: gameName, backup: backupName } = JSON.parse(body);
					if (!backupName || !backupName.startsWith(`${gameName}_`)) {
						throw new Error('Invalid backup name');
					}

					const backupPath = path.join(BACKUP_DIR, backupName);
					if (!fs.existsSync(backupPath)) {
						throw new Error('Backup not found');
					}

					const platform = os.platform();
					const command = platform === 'win32' ? 'explorer' : (platform === 'darwin' ? 'open' : 'xdg-open');
					spawn(command, [backupPath], { detached: true, stdio: 'ignore' }).unref();

					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ message: `Opened backup folder for ${backupName}` }));
				} catch (error) {
					console.error('[Web API] Open backup folder error:', error);
					if (!res.headersSent) {
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ message: error.message }));
					}
				}
			});
			req.on('error', (err) => {
				console.error('[Web API] Request error:', err);
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Request error' }));
				}
			});
		} else if (req.url === '/api/sync' && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => {
				body += chunk.toString();
			});
			req.on('end', async () => {
				try {
					const { game: gameName, direction } = JSON.parse(body);
					const cfg = loadConfig();
					const game = cfg.games.find(g => g.name === gameName);

					if (!game) {
						throw new Error(`Game '${gameName}' not found.`);
					}

					const normalizedDir = normalizeDirectionInput(direction);
					if (!normalizedDir) {
						throw new Error(`Invalid direction: ${direction}`);
					}

					console.log(`[Web API] Received action: ${normalizedDir} for ${game.name}`);

					if (normalizedDir === 'backupLocal') {
						await backupLocalOnly(game);
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ message: `Successfully backed up ${game.name} locally.` }));
					} else {
						const remote = cfg.remote;
						if (!remote || !remote.host || !remote.user) {
							throw new Error('Remote configuration is incomplete.');
						}
						await backupBoth(game, remote, normalizedDir);

						if (normalizedDir === 'push') {
							await syncLocalToRemote_SFTP(game, remote);
						} else if (normalizedDir === 'pull') {
							await syncRemoteToLocal_SFTP(game, remote);
						}
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ message: `Sync '${normalizedDir}' for ${game.name} completed.` }));
						console.log(`Sync '${normalizedDir}' for ${game.name} completed.`);
						console.log(`-----`);
					}
				} catch (error) {
					console.error('[Web API] Sync error:', error);
					if (!res.headersSent) {
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ message: error.message }));
					}
				}
			});
			req.on('error', (err) => {
				console.error('[Web API] Request error:', err);
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Request error' }));
				}
			});
		} else {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('Not Found');
		}
			} catch (error) {
				console.error('[Web Server] Unhandled error:', error);
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Internal server error', message: error.message }));
				}
			}
		})().catch(err => {
			console.error('[Web Server] Unhandled promise rejection:', err);
			if (!res.headersSent) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Internal server error', message: err.message }));
			}
		});
	});

	// 添加错误处理
	server.on('error', (err) => {
		console.error('[Web Server] Server error:', err);
		if (err.code === 'EADDRINUSE') {
			console.error(`端口 ${port} 被占用，尝试切换到下一个端口...`);
			// 如果端口被占用，尝试下一个端口
			findAvailablePort(port + 1, 10).then(newPort => {
				console.log(`正在端口 ${newPort} 上重新启动服务器...`);
				server.listen(newPort);
			}).catch(e => {
				console.error('无法找到可用端口:', e.message);
				process.exit(1);
			});
		}
	});

	// 添加客户端错误处理
	server.on('clientError', (err, socket) => {
		console.error('[Web Server] Client error:', err);
		socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
	});

	// 启动服务器
	server.listen(port, () => {
		const url = `http://localhost:${port}`;
		console.log(`✅ Web 服务器已启动: ${url}`);
		console.log('按 Ctrl+C 停止服务器');
		try {
			const platform = os.platform();
			const command = platform === 'win32' ? 'start' : (platform === 'darwin' ? 'open' : 'xdg-open');
			spawn(command, [url], { detached: true, stdio: 'ignore', shell: true }).unref();
		} catch (e) {
			console.error('无法自动打开浏览器:', e);
		}
	});

	// 如果启动时端口被占用（虽然我们已经检查过，但以防万一）
	server.on('error', (err) => {
		if (err.code === 'EADDRINUSE') {
			console.error(`❌ 端口 ${port} 被占用，尝试查找其他可用端口...`);
			findAvailablePort(port + 1, 10).then(newPort => {
				console.log(`🔄 正在端口 ${newPort} 上重新启动服务器...`);
				server.listen(newPort, () => {
					const url = `http://localhost:${newPort}`;
					console.log(`✅ Web 服务器已启动: ${url}`);
					try {
						const platform = os.platform();
						const command = platform === 'win32' ? 'start' : (platform === 'darwin' ? 'open' : 'xdg-open');
						spawn(command, [url], { detached: true, stdio: 'ignore', shell: true }).unref();
					} catch (e) {
						console.error('无法自动打开浏览器:', e);
					}
				});
			}).catch(e => {
				console.error('❌ 无法找到可用端口:', e.message);
				process.exit(1);
			});
		} else {
			console.error('[Web Server] 服务器错误:', err);
		}
	});

}

async function run() {
	ensureDirs();
	const args = parseArgs(process.argv.slice(2));

	if (args.web) {
		return startWebServer();
	}

	while (true) {
		const cfg = loadConfig();
		const game = await pickOrCreateGame(cfg, args.game);

		if (!game) {
			console.log('\n返回主菜单...');
			delete args.game;
			delete args.direction;
			continue;
		}

		const direction = await resolveDirection(args.direction);

		if (direction === 'backupLocal') {
			await backupLocalOnly(game);
		} else {
			const remote = await ensureRemote(cfg);
			const ensuredGame = await ensureGameRemotePath(game, cfg);

			try {
				await testSftpConnection(ensuredGame, remote);
				console.log('开始备份本地与远程...');
				await backupBoth(ensuredGame, remote, direction);
				const prefer = cfg.preferScpTool || 'auto';
				const canUseScp = (() => {
					const d = detectScpTools();
					return Boolean(d.scpPath || d.pscpPath);
				})();
				if (direction === 'push') {
					if (prefer === 'scp' && canUseScp) await syncLocalToRemote_SCP(ensuredGame, remote);
					else await syncLocalToRemote_SFTP(ensuredGame, remote);
					console.log('同步完成（本地 -> 远程）。');
				} else {
					if (prefer === 'scp' && canUseScp) await syncRemoteToLocal_SCP(ensuredGame, remote);
					else await syncRemoteToLocal_SFTP(ensuredGame, remote);
					console.log('同步完成（远程 -> 本地）。');
				}
			} catch (err) {
				await handleSshError(err, cfg);
				process.exitCode = 1;
			}
		}

		console.log("\n操作完成。");
		const { confirmExit } = await inquirer.prompt([{
			type: 'confirm',
			name: 'confirmExit',
			message: '是否退出程序？ (y/n)',
			default: true,
		}]);

		if (confirmExit) {
			break;
		}

		// Clear args for next loop to be interactive
		delete args.game;
		delete args.direction;
	}

	console.log("程序退出。");
	process.exit(0);
}

run().catch(err => {
	console.error(err);
	process.exit(1);
});
