import fs from 'fs';
import fse from 'fs-extra';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';
import dayjs from 'dayjs';
import which from 'which';
import { spawn, spawnSync } from 'child_process';
import SFTPClient from 'ssh2-sftp-client';
import http from 'http';
import net from 'net';
import readline from 'readline';
import { fileURLToPath } from 'url';
import systray2Import from 'systray2';

// 全局错误处理，防止进程崩溃
process.on('uncaughtException', (err) => {
	console.error('未捕获的异常:', err);
	// 不退出进程，让服务器继续运行
});

process.on('unhandledRejection', (reason, promise) => {
	console.error('未处理的Promise拒绝:', reason);
	// 不退出进程，让服务器继续运行
});

/** pkg / 打包后的单文件 EXE */
const isPkg = typeof process.pkg !== 'undefined';
const isPackaged = isPkg || process.env.GSM_PACKAGED === '1';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** EXE / 项目安装目录（gsm-paths.json 固定写在这里） */
const INSTALL_ROOT = isPkg ? path.dirname(process.execPath) : process.cwd();
const PATHS_FILE = path.join(INSTALL_ROOT, 'gsm-paths.json');
/** 只读资源：html / favicon（打包后在 snapshot / 与 bundle 同目录） */
const ASSET_ROOT = isPackaged ? MODULE_DIR : path.join(INSTALL_ROOT, 'src');
const FAVICON_PATH = path.join(ASSET_ROOT, 'favicon.png');
const HTML_PATH = path.join(ASSET_ROOT, 'index.html');

/** 工作目录：其下为 data/、backups/（可改） */
let WORK_ROOT = INSTALL_ROOT;
let DATA_DIR = path.join(WORK_ROOT, 'data');
let CONFIG_PATH = path.join(DATA_DIR, 'config.json');
let BACKUP_DIR = path.join(WORK_ROOT, 'backups');
let COVERS_DIR = path.join(DATA_DIR, 'covers');
let TRAY_ICON_PATH = path.join(WORK_ROOT, 'assets', 'tray.ico');

function applyWorkRoot(root) {
	WORK_ROOT = path.resolve(root);
	DATA_DIR = path.join(WORK_ROOT, 'data');
	CONFIG_PATH = path.join(DATA_DIR, 'config.json');
	BACKUP_DIR = path.join(WORK_ROOT, 'backups');
	COVERS_DIR = path.join(DATA_DIR, 'covers');
	TRAY_ICON_PATH = path.join(WORK_ROOT, 'assets', 'tray.ico');
}

function readSavedWorkRoot() {
	try {
		if (!fs.existsSync(PATHS_FILE)) return null;
		const j = JSON.parse(fs.readFileSync(PATHS_FILE, 'utf8'));
		if (j && typeof j.root === 'string' && j.root.trim()) {
			return path.resolve(j.root.trim());
		}
	} catch (e) {
		console.warn('读取 gsm-paths.json 失败:', e.message || e);
	}
	return null;
}

function saveWorkRoot(root) {
	const resolved = path.resolve(root);
	fse.writeJsonSync(PATHS_FILE, { root: resolved }, { spaces: 2 });
	return resolved;
}

function getPathsInfo() {
	return {
		installRoot: INSTALL_ROOT,
		root: WORK_ROOT,
		dataDir: DATA_DIR,
		backupDir: BACKUP_DIR,
		configPath: CONFIG_PATH,
		pathsFile: PATHS_FILE
	};
}

/** Windows folder picker (works without a console window) */
function pickFolderDialog(description = 'Select data folder', initialDir = WORK_ROOT) {
	if (os.platform() !== 'win32') {
		return null;
	}
	const desc = String(description).replace(/'/g, "''");
	const init = String(initialDir || '').replace(/'/g, "''");
	const ps = [
		'Add-Type -AssemblyName System.Windows.Forms',
		'$d = New-Object System.Windows.Forms.FolderBrowserDialog',
		`$d.Description = '${desc}'`,
		'$d.ShowNewFolderButton = $true',
		init ? `try { $d.SelectedPath = '${init}' } catch {}` : '',
		'$r = $d.ShowDialog()',
		"if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }"
	].filter(Boolean).join('; ');
	const result = spawnSync(
		'powershell.exe',
		['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps],
		{ encoding: 'utf8', windowsHide: true }
	);
	const out = (result.stdout || '').trim();
	return out || null;
}

function setWorkRoot(root, { persist = true } = {}) {
	const resolved = path.resolve(root);
	applyWorkRoot(resolved);
	if (persist) saveWorkRoot(resolved);
	ensureDirs();
	return getPathsInfo();
}

// Load saved work root early (CLI --root applied later in run())
applyWorkRoot(readSavedWorkRoot() || INSTALL_ROOT);

/** @type {{ port: number, url: string, server: import('http').Server } | null} */
let webServerInfo = null;

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
	if (!fs.existsSync(COVERS_DIR)) fse.mkdirpSync(COVERS_DIR);
	migrateLegacyBackups();
}

/**
 * 支持快捷键的菜单：直接按数字/字母即可，也可用 ↑↓ + 回车。
 * @param {string} message
 * @param {Array<{ name: string, value: any, hotkey?: string, separator?: boolean }>} choices
 */
async function promptHotkeyMenu(message, choices) {
	const actionable = choices.filter(c => !c.separator);
	if (actionable.length === 0) {
		throw new Error('菜单没有可选项');
	}

	let selected = 0;
	const render = () => {
		process.stdout.write('\x1Bc');
		console.log(`\n${message}`);
		console.log('提示：直接按括号内的键即可（如 W），也可用 ↑↓ + 回车\n');
		for (const c of choices) {
			if (c.separator) {
				console.log(`  ${c.name}`);
				continue;
			}
			const idx = actionable.indexOf(c);
			const marker = idx === selected ? '>' : ' ';
			console.log(` ${marker} ${c.name}`);
		}
	};

	return new Promise((resolve) => {
		readline.emitKeypressEvents(process.stdin);
		const wasRaw = process.stdin.isRaw;
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
		}
		process.stdin.resume();
		render();

		const cleanup = () => {
			process.stdin.removeListener('keypress', onKeypress);
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(Boolean(wasRaw));
			}
		};

		const finish = (value) => {
			cleanup();
			process.stdout.write('\n');
			resolve(value);
		};

		const onKeypress = (str, key) => {
			if (!key) return;
			if (key.ctrl && key.name === 'c') {
				cleanup();
				process.exit(0);
			}
			if (key.name === 'up') {
				selected = (selected - 1 + actionable.length) % actionable.length;
				render();
				return;
			}
			if (key.name === 'down') {
				selected = (selected + 1) % actionable.length;
				render();
				return;
			}
			if (key.name === 'return' || key.name === 'enter') {
				finish(actionable[selected].value);
				return;
			}
			if (key.name === 'escape') {
				const back = actionable.find(c => c.hotkey === 'r' || c.value === 'back' || c.value === 'exit');
				if (back) {
					finish(back.value);
				}
				return;
			}

			const pressed = String(str || key.name || '').toLowerCase();
			if (!pressed) return;

			const hit = actionable.find(c => c.hotkey && String(c.hotkey).toLowerCase() === pressed);
			if (hit) {
				finish(hit.value);
			}
		};

		process.stdin.on('keypress', onKeypress);
	});
}

function loadConfig() {
	ensureDirs();
	if (!fs.existsSync(CONFIG_PATH)) {
		const defaultCfg = { 
			games: [], 
			preferScpTool: 'auto',
			sshMachines: [],
			defaultSshMachine: null
		};
		fse.writeJsonSync(CONFIG_PATH, defaultCfg, { spaces: 2 });
		return defaultCfg;
	}
	const cfg = fse.readJsonSync(CONFIG_PATH);
	if (!cfg.sshMachines) {
		cfg.sshMachines = [];
		cfg.defaultSshMachine = null;
	}
	return cfg;
}

function saveConfig(cfg) {
	fse.writeJsonSync(CONFIG_PATH, cfg, { spaces: 2 });
}

function getDefaultSshMachine(cfg) {
	if (!cfg) return null;
	if (!cfg.defaultSshMachine) return null;
	const machine = cfg.sshMachines?.find(m => m.id === cfg.defaultSshMachine);
	return machine || null;
}

function timestamp() {
	return dayjs().format('YYYYMMDD_HHmmss');
}

function isBackupTimestamp(name) {
	return /^\d{8}_\d{6}$/.test(String(name || ''));
}

function gameBackupRoot(gameName) {
	return path.join(BACKUP_DIR, String(gameName));
}

function gameImagesDir(gameName) {
	return path.join(gameBackupRoot(gameName), 'myImage');
}

function gameImagesMetaPath(gameName) {
	return path.join(gameImagesDir(gameName), 'meta.json');
}

function backupInstancePath(gameName, backupId) {
	const id = String(backupId || '');
	// 新结构：backups/<game>/<YYYYMMDD_HHmmss>
	if (isBackupTimestamp(id)) {
		return path.join(gameBackupRoot(gameName), id);
	}
	// 兼容旧 API 名：GameName_YYYYMMDD_HHmmss
	const prefix = `${gameName}_`;
	if (id.startsWith(prefix)) {
		const ts = id.slice(prefix.length);
		if (isBackupTimestamp(ts)) {
			return path.join(gameBackupRoot(gameName), ts);
		}
	}
	return null;
}

function parseBackupTime(ts, fallbackDate = new Date()) {
	if (!isBackupTimestamp(ts)) return fallbackDate;
	const year = ts.substring(0, 4);
	const month = ts.substring(4, 6);
	const day = ts.substring(6, 8);
	const hour = ts.substring(9, 11);
	const minute = ts.substring(11, 13);
	const second = ts.substring(13, 15);
	return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
}

function listBackupIds(gameName) {
	const root = gameBackupRoot(gameName);
	if (!fs.existsSync(root)) return [];
	return fs.readdirSync(root).filter((name) => {
		if (name === 'myImage') return false;
		const full = path.join(root, name);
		try {
			return isBackupTimestamp(name) && fs.statSync(full).isDirectory();
		} catch {
			return false;
		}
	});
}

/** 将旧结构 backups/Game_时间戳 迁移到 backups/Game/时间戳 */
function migrateLegacyBackups() {
	if (!fs.existsSync(BACKUP_DIR)) return;
	const entries = fs.readdirSync(BACKUP_DIR);
	for (const name of entries) {
		const full = path.join(BACKUP_DIR, name);
		let stat;
		try { stat = fs.statSync(full); } catch { continue; }
		if (!stat.isDirectory()) continue;
		if (name === 'myImage') continue;

		const match = name.match(/^(.*)_(\d{8}_\d{6})$/);
		if (!match) continue;

		const gameName = match[1];
		const ts = match[2];
		const destRoot = gameBackupRoot(gameName);
		const dest = path.join(destRoot, ts);
		try {
			fse.mkdirpSync(destRoot);
			if (fs.existsSync(dest)) {
				console.warn(`[migrate] 目标已存在，跳过: ${dest}`);
				continue;
			}
			fs.renameSync(full, dest);
			console.log(`[migrate] ${name} -> ${gameName}/${ts}`);
		} catch (err) {
			console.error(`[migrate] 失败 ${name}:`, err.message || err);
		}
	}
}

function ensureGameBackupDirs(gameName) {
	fse.mkdirpSync(gameBackupRoot(gameName));
	fse.mkdirpSync(gameImagesDir(gameName));
}

function readImagesMeta(gameName) {
	ensureGameBackupDirs(gameName);
	const metaPath = gameImagesMetaPath(gameName);
	if (!fs.existsSync(metaPath)) {
		return { images: [] };
	}
	try {
		const meta = fse.readJsonSync(metaPath);
		if (!Array.isArray(meta.images)) meta.images = [];
		return meta;
	} catch {
		return { images: [] };
	}
}

function writeImagesMeta(gameName, meta) {
	ensureGameBackupDirs(gameName);
	fse.writeJsonSync(gameImagesMetaPath(gameName), meta, { spaces: 2 });
}

function imagePublicUrl(gameName, imageId) {
	return `/api/games/${encodeURIComponent(gameName)}/images/${encodeURIComponent(imageId)}/file`;
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

async function openWebPage() {
	console.log(`正在检查 Web 服务器状态...`);
	if (!webServerInfo) {
		const portAvailable = await isPortAvailable(9123);
		if (portAvailable) {
			console.log('Web 服务器未启动，正在启动...');
			await startWebServer({ openBrowser: false });
		} else {
			webServerInfo = { port: 9123, url: 'http://localhost:9123', server: null };
		}
	}

	const url = webServerInfo?.url || 'http://localhost:9123';
	console.log(`正在打开 Web 页面：${url}`);
	try {
		const platform = os.platform();
		const command = platform === 'win32' ? 'start' : (platform === 'darwin' ? 'open' : 'xdg-open');
		spawn(command, [url], { detached: true, stdio: 'ignore', shell: true }).unref();
		console.log('浏览器已打开。');
	} catch (e) {
		console.error('无法自动打开浏览器:', e.message);
		console.log(`请手动访问：${url}`);
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

	const choices = cfg.games.map((g, idx) => {
		const key = String(idx + 1);
		return {
			name: `[${key}] ${g.name}`,
			value: idx,
			hotkey: key.length === 1 ? key : undefined
		};
	});

	choices.push({ separator: true, name: '--- 其他选项 ---' });
	choices.push({ name: '[N] 新建游戏', value: 'create', hotkey: 'n' });
	choices.push({ name: '[F] 打开备份文件夹', value: 'openBackupDir', hotkey: 'f' });
	choices.push({ name: '[E] 编辑配置文件', value: 'editConfig', hotkey: 'e' });
	choices.push({ name: '[W] 打开 Web 页面', value: 'openWeb', hotkey: 'w' });
	choices.push({ name: '[T] 进入托盘模式（后台）', value: 'tray', hotkey: 't' });
	choices.push({ name: '[Q] 退出程序', value: 'exit', hotkey: 'q' });

	const selection = await promptHotkeyMenu('选择一个游戏或操作：', choices);

	if (selection === 'editConfig') {
		await openConfigFile();
		return null;
	}
	if (selection === 'openBackupDir') {
		await openBackupDir();
		return null;
	}
	if (selection === 'openWeb') {
		await openWebPage();
		return null;
	}
	if (selection === 'tray') {
		await startTrayMode({ openBrowser: true });
		return 'tray-running';
	}
	if (selection === 'exit') {
		console.log('程序退出。');
		process.exit(0);
	}
	if (selection === 'create') {
		return await createGame(cfg);
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

async function writeBackupLog(root, game, type, filename = 'backup.log', syncDirection = null) {
	const logPath = path.join(root, filename);
	const logInfo = [
		`Timestamp: ${new Date().toISOString()}`,
		`Game: ${game.name}`,
		`Type: ${type}`,
		`Local Path: ${game.localPath}`,
		`Remote Path: ${game.remoteFullPath || 'N/A'}`,
		`Status: Success`
	];
	if (syncDirection) {
		logInfo.push(`Direction: ${syncDirection}`);
	}
	logInfo.push('----------------------------------------', '');
	await fse.appendFile(logPath, logInfo.join('\n'));
	
	if (syncDirection) {
		const metaPath = path.join(root, 'displayName.json');
		let meta = {};
		if (fs.existsSync(metaPath)) {
			try {
				meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
			} catch (err) {}
		}
		meta.syncDirection = syncDirection;
		await fs.promises.writeFile(metaPath, JSON.stringify(meta), 'utf8');
	}
}

async function backupBoth(game, remote, direction) {
	if (game.nobackup) {
		console.log(`\n[配置] 游戏 "${game.name}" 已设置 nobackup=true，跳过备份步骤，直接进行同步。`);
		return;
	}

	const root = path.join(gameBackupRoot(game.name), timestamp());
	const localDest = path.join(root, 'local');
	const remoteDest = path.join(root, 'remote');
	ensureGameBackupDirs(game.name);
	await backupLocal(game, localDest);
	await backupRemote(game, remote, remoteDest);

	let logName = 'backup.log';
	let type = 'Full Backup';
	let logDirection = null;
	if (direction === 'push') {
		logName = 'local-to-remote.log';
		type = 'Pre-push Backup (Local -> Remote)';
		logDirection = 'local-to-remote';
	} else if (direction === 'pull') {
		logName = 'remote-to-local.log';
		type = 'Pre-pull Backup (Remote -> Local)';
		logDirection = 'remote-to-local';
	}
	await writeBackupLog(root, game, type, logName, logDirection);
}

async function backupLocalOnly(game) {
	ensureGameBackupDirs(game.name);
	const root = path.join(gameBackupRoot(game.name), timestamp());
	const localDest = path.join(root, 'local');
	await backupLocal(game, localDest);
	await writeBackupLog(root, game, 'Local Only Backup', 'local-backup.log', null);
	console.log(`本地存档备份已完成（仅备份模式）：${localDest}`);
}

function isSwitchMode(game) {
	return game && (game.syncMode === 'switch' || game.syncMode === 'switch-pc');
}

function isLocalMode(game) {
	return game && (game.syncMode === 'local' || game.syncMode === 'backup' || game.syncMode === 'local-only');
}

function getSwitchPath(game) {
	const p = game?.switchPath || game?.switchFullPath;
	if (!p || typeof p !== 'string' || !p.trim()) {
		throw new Error(`游戏 ${game?.name || ''} 未配置 Switch 存档路径（switchPath）`);
	}
	return path.resolve(p.trim());
}

/** PC↔Switch 同步时按规则重命名：PC 有 .sav，Switch 无 .sav */
function renameForSwitchSync(fileName, direction) {
	const lower = fileName.toLowerCase();
	if (direction === 'pc-to-switch') {
		if (lower.endsWith('.sav')) return fileName.slice(0, -4);
		return fileName;
	}
	// switch-to-pc
	if (!lower.endsWith('.sav')) return `${fileName}.sav`;
	return fileName;
}

async function copyDirWithSavRename(srcDir, destDir, direction) {
	await fse.mkdirp(destDir);
	const items = await fse.readdir(srcDir);
	for (const name of items) {
		const srcPath = path.join(srcDir, name);
		const stat = await fse.stat(srcPath);
		if (stat.isDirectory()) {
			await copyDirWithSavRename(srcPath, path.join(destDir, name), direction);
			continue;
		}
		const destName = renameForSwitchSync(name, direction);
		await fse.copy(srcPath, path.join(destDir, destName), { overwrite: true });
	}
}

async function backupSwitchSide(game, dest) {
	const switchPath = getSwitchPath(game);
	await fse.mkdirp(dest);
	if (!fs.existsSync(switchPath)) {
		console.log(`Switch 目录不存在，已创建空备份记录：${switchPath}`);
		return;
	}
	await fse.copy(switchPath, dest, { overwrite: true, errorOnExist: false });
	console.log(`Switch 备份完成：${dest}`);
}

async function backupPcAndSwitch(game, direction) {
	if (game.nobackup) {
		console.log(`\n[配置] 游戏 "${game.name}" 已设置 nobackup=true，跳过备份步骤，直接进行同步。`);
		return;
	}

	ensureGameBackupDirs(game.name);
	const root = path.join(gameBackupRoot(game.name), timestamp());
	const localDest = path.join(root, 'local');
	const switchDest = path.join(root, 'remote');
	await backupLocal(game, localDest);
	await backupSwitchSide(game, switchDest);

	let logName = 'backup.log';
	let type = 'Full Backup (PC + Switch)';
	let logDirection = null;
	if (direction === 'push' || direction === 'pc-to-switch') {
		logName = 'local-to-remote.log';
		type = 'Pre-sync Backup (PC -> Switch)';
		logDirection = 'pc-to-switch';
	} else if (direction === 'pull' || direction === 'switch-to-pc') {
		logName = 'remote-to-local.log';
		type = 'Pre-sync Backup (Switch -> PC)';
		logDirection = 'switch-to-pc';
	}
	await writeBackupLog(root, game, type, logName, logDirection);
}

async function syncPcToSwitch(game) {
	const switchPath = getSwitchPath(game);
	if (!fs.existsSync(game.localPath)) {
		throw new Error(`PC 存档路径不存在：${game.localPath}`);
	}
	await fse.mkdirp(switchPath);

	const tempDir = path.join(os.tmpdir(), `gsm_pc2switch_${Date.now()}`);
	try {
		await fse.emptyDir(tempDir);
		await copyDirWithSavRename(game.localPath, tempDir, 'pc-to-switch');
		await fse.emptyDir(switchPath);
		await fse.copy(tempDir, switchPath, { overwrite: true });
	} finally {
		try { await fse.remove(tempDir); } catch { }
	}
	console.log(`同步完成（PC -> Switch）：${game.localPath} -> ${switchPath}`);
}

async function syncSwitchToPc(game) {
	const switchPath = getSwitchPath(game);
	if (!fs.existsSync(switchPath)) {
		throw new Error(`Switch 存档路径不存在：${switchPath}`);
	}
	await fse.mkdirp(game.localPath);

	const tempDir = path.join(os.tmpdir(), `gsm_switch2pc_${Date.now()}`);
	try {
		await fse.emptyDir(tempDir);
		await copyDirWithSavRename(switchPath, tempDir, 'switch-to-pc');
		await fse.emptyDir(game.localPath);
		await fse.copy(tempDir, game.localPath, { overwrite: true });
	} finally {
		try { await fse.remove(tempDir); } catch { }
	}
	console.log(`同步完成（Switch -> PC）：${switchPath} -> ${game.localPath}`);
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
		case 'pc2switch':
		case 'pc-to-switch':
			return 'push';
		case 'remote2local':
		case 'pull':
		case 'download':
		case 'r2l':
		case 'switch2pc':
		case 'switch-to-pc':
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

function directionLabel(direction, game = null) {
	const switchMode = isSwitchMode(game);
	switch (direction) {
		case 'push': return switchMode ? 'PC -> Switch' : '本地 -> 远程';
		case 'pull': return switchMode ? 'Switch -> PC' : '远程 -> 本地';
		case 'backupLocal': return '仅备份本地存档';
		default: return direction;
	}
}

function buildGameFromPayload(gameData, existing = null) {
	if (!gameData.name || !gameData.localPath) {
		throw new Error('游戏名称和本地/PC 存档路径为必填项');
	}

	const syncMode = (gameData.syncMode || existing?.syncMode || 'local').trim();
	if (!['remote', 'switch', 'local'].includes(syncMode)) {
		throw new Error('syncMode 只能是 local、remote 或 switch');
	}

	const game = {
		...(existing || {}),
		name: gameData.name.trim(),
		localPath: path.resolve(gameData.localPath.trim()),
		syncMode,
		...(gameData.nobackup !== undefined ? { nobackup: gameData.nobackup } : (existing?.nobackup !== undefined ? { nobackup: existing.nobackup } : {}))
	};

	if (syncMode === 'switch') {
		const switchPath = (gameData.switchPath ?? gameData.switchFullPath ?? existing?.switchPath ?? existing?.switchFullPath ?? '').toString().trim();
		if (!switchPath) {
			throw new Error('Switch 模式需要填写 Switch 存档路径');
		}
		game.switchPath = path.resolve(switchPath);
		delete game.remoteFullPath;
	} else if (syncMode === 'remote') {
		const remoteFullPath = (gameData.remoteFullPath !== undefined
			? gameData.remoteFullPath
			: (existing?.remoteFullPath || '')
		);
		if (remoteFullPath && String(remoteFullPath).trim()) {
			game.remoteFullPath = String(remoteFullPath).trim().replace(/\\/g, '/');
		} else {
			delete game.remoteFullPath;
		}
		delete game.switchPath;
		delete game.switchFullPath;
	} else {
		// local-only：不需要远程/Switch 路径
		delete game.remoteFullPath;
		delete game.switchPath;
		delete game.switchFullPath;
		game.nobackup = false;
	}

	if (gameData.coverImage !== undefined) {
		if (gameData.coverImage) {
			game.coverImage = String(gameData.coverImage);
		} else {
			delete game.coverImage;
		}
	} else if (existing?.coverImage) {
		game.coverImage = existing.coverImage;
	}

	return game;
}

function safeCoverBasename(name) {
	return String(name || 'cover')
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
		.replace(/\s+/g, '_')
		.slice(0, 80) || 'cover';
}

function coverPublicUrl(relPath) {
	if (!relPath) return null;
	const base = path.basename(String(relPath).replace(/\\/g, '/'));
	return `/api/covers/${encodeURIComponent(base)}`;
}

function resolveCoverFile(relOrName) {
	const base = path.basename(String(relOrName || '').replace(/\\/g, '/'));
	if (!base || base === '.' || base === '..') return null;
	const full = path.join(COVERS_DIR, base);
	if (!full.startsWith(COVERS_DIR)) return null;
	return full;
}

async function saveCoverFromDataUrl(gameName, dataUrl, oldCoverRel = null) {
	const match = String(dataUrl || '').match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/i);
	if (!match) {
		throw new Error('仅支持 PNG / JPG / WEBP / GIF 图片');
	}
	let ext = match[1].toLowerCase();
	if (ext === 'jpeg') ext = 'jpg';
	const buf = Buffer.from(match[2], 'base64');
	if (buf.length > 8 * 1024 * 1024) {
		throw new Error('封面图片过大（最大 8MB）');
	}
	const filename = `${safeCoverBasename(gameName)}_${Date.now()}.${ext}`;
	const fullPath = path.join(COVERS_DIR, filename);
	await fse.writeFile(fullPath, buf);

	if (oldCoverRel) {
		const oldPath = resolveCoverFile(oldCoverRel);
		if (oldPath && fs.existsSync(oldPath) && oldPath !== fullPath) {
			try { await fse.remove(oldPath); } catch { }
		}
	}

	return `covers/${filename}`;
}

async function removeCoverFile(relOrName) {
	const full = resolveCoverFile(relOrName);
	if (full && fs.existsSync(full)) {
		try { await fse.remove(full); } catch { }
	}
}

function mimeFromCoverExt(filename) {
	const ext = path.extname(filename).toLowerCase();
	switch (ext) {
		case '.png': return 'image/png';
		case '.jpg':
		case '.jpeg': return 'image/jpeg';
		case '.webp': return 'image/webp';
		case '.gif': return 'image/gif';
		default: return 'application/octet-stream';
	}
}

/** 将 PNG 打包为 Windows 可用的 ICO（内嵌 PNG） */
function pngBufferToIco(pngBuf) {
	if (!pngBuf || pngBuf.length < 24 || pngBuf[0] !== 0x89 || pngBuf[1] !== 0x50) {
		throw new Error('无效的 PNG 数据');
	}
	const width = pngBuf.readUInt32BE(16);
	const height = pngBuf.readUInt32BE(20);
	const offset = 22; // 6 + 16
	const ico = Buffer.alloc(offset + pngBuf.length);
	ico.writeUInt16LE(0, 0);
	ico.writeUInt16LE(1, 2);
	ico.writeUInt16LE(1, 4);
	ico[6] = width >= 256 ? 0 : width;
	ico[7] = height >= 256 ? 0 : height;
	ico[8] = 0;
	ico[9] = 0;
	ico.writeUInt16LE(1, 10);
	ico.writeUInt16LE(32, 12);
	ico.writeUInt32LE(pngBuf.length, 14);
	ico.writeUInt32LE(offset, 18);
	pngBuf.copy(ico, offset);
	return ico;
}

function ensureTrayIconFromFavicon() {
	if (!fs.existsSync(FAVICON_PATH)) {
		return fs.existsSync(TRAY_ICON_PATH) ? TRAY_ICON_PATH : null;
	}

	try {
		const favStat = fs.statSync(FAVICON_PATH);
		const needRebuild = !fs.existsSync(TRAY_ICON_PATH)
			|| fs.statSync(TRAY_ICON_PATH).mtimeMs < favStat.mtimeMs;
		if (needRebuild) {
			fse.mkdirpSync(path.dirname(TRAY_ICON_PATH));
			const pngBuf = fs.readFileSync(FAVICON_PATH);
			fs.writeFileSync(TRAY_ICON_PATH, pngBufferToIco(pngBuf));
			console.log(`已从 favicon.png 生成托盘图标：${TRAY_ICON_PATH}`);
		}
		return TRAY_ICON_PATH;
	} catch (err) {
		console.warn('生成托盘图标失败，将尝试直接使用 PNG：', err.message || err);
		return FAVICON_PATH;
	}
}

function loadTrayIconBase64() {
	const iconPath = ensureTrayIconFromFavicon();
	if (!iconPath || !fs.existsSync(iconPath)) return '';
	return fs.readFileSync(iconPath).toString('base64');
}

async function resolveDirection(argDirection, game = null) {
	if (argDirection !== undefined) {
		const mappedFromArg = normalizeDirectionInput(argDirection);
		if (!mappedFromArg) {
			throw new Error(`无法识别 --direction 参数 "${argDirection}"，可选值：local2remote、remote2local、backup`);
		}
		if (isLocalMode(game) && mappedFromArg !== 'backupLocal') {
			throw new Error(`游戏 "${game.name}" 为仅本地模式，只能使用 --direction backup`);
		}
		console.log(`已通过命令行参数选择操作：${directionLabel(mappedFromArg, game)}`);
		return mappedFromArg;
	}

	const switchMode = isSwitchMode(game);
	const localMode = isLocalMode(game);
	const choices = localMode ? [
		{ name: '[1] 备份本地存档', value: 'backupLocal', hotkey: '1' },
		{ name: '[R] 返回上级菜单', value: 'back', hotkey: 'r' }
	] : switchMode ? [
		{ name: '[1] PC -> Switch（去掉 .sav 后缀）', value: 'push', hotkey: '1' },
		{ name: '[2] Switch -> PC（加上 .sav 后缀）', value: 'pull', hotkey: '2' },
		{ name: '[3] 仅备份本地(PC)存档', value: 'backupLocal', hotkey: '3' },
		{ name: '[R] 返回上级菜单', value: 'back', hotkey: 'r' }
	] : [
		{ name: '[1] 本地 -> 远程（用本地覆盖远程）', value: 'push', hotkey: '1' },
		{ name: '[2] 远程 -> 本地（用远程覆盖本地）', value: 'pull', hotkey: '2' },
		{ name: '[3] 仅备份本地存档', value: 'backupLocal', hotkey: '3' },
		{ name: '[R] 返回上级菜单', value: 'back', hotkey: 'r' }
	];

	const direction = await promptHotkeyMenu('选择操作：', choices);
	if (direction === 'back') {
		return null;
	}
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

async function startWebServer({ openBrowser = true } = {}) {
	if (webServerInfo?.server) {
		return webServerInfo;
	}

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
			fs.readFile(HTML_PATH, (err, data) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'text/plain' });
					res.end('Error loading index.html');
					return;
				}
				res.writeHead(200, { 'Content-Type': 'text/html' });
				res.end(data);
			});
		} else if ((req.url === '/favicon.png' || req.url === '/favicon.ico') && req.method === 'GET') {
			try {
				if (!fs.existsSync(FAVICON_PATH)) {
					res.writeHead(404, { 'Content-Type': 'text/plain' });
					res.end('Not Found');
					return;
				}
				res.writeHead(200, {
					'Content-Type': 'image/png',
					'Cache-Control': 'public, max-age=86400'
				});
				fs.createReadStream(FAVICON_PATH).pipe(res);
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'text/plain' });
				res.end(error.message);
			}
		} else if (req.url === '/api/paths' && req.method === 'GET') {
			try {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(getPathsInfo()));
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: error.message }));
			}
		} else if (req.url === '/api/paths' && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', () => {
				try {
					const { root } = JSON.parse(body || '{}');
					if (!root || typeof root !== 'string') {
						throw new Error('root is required');
					}
					const info = setWorkRoot(root.trim());
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ message: 'Data folder updated', ...info }));
				} catch (error) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: error.message }));
				}
			});
		} else if (req.url === '/api/paths/pick' && req.method === 'POST') {
			try {
				const picked = pickFolderDialog(
					'Select GSM data folder (data/ and backups/ will be created here)',
					WORK_ROOT
				);
				if (!picked) {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ cancelled: true, ...getPathsInfo() }));
					return;
				}
				const info = setWorkRoot(picked);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ message: 'Data folder updated', cancelled: false, ...info }));
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: error.message }));
			}
		} else if (req.url === '/api/games' && req.method === 'GET') {
			try {
				const cfg = loadConfig();
				const list = (cfg.games || []).map(g => ({
					...g,
					coverUrl: coverPublicUrl(g.coverImage)
				}));
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(list));
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Failed to load config' }));
			}
		} else if (req.url.startsWith('/api/covers/') && req.method === 'GET') {
			try {
				const raw = decodeURIComponent(req.url.split('/').pop().split('?')[0]);
				const full = resolveCoverFile(raw);
				if (!full || !fs.existsSync(full)) {
					res.writeHead(404, { 'Content-Type': 'text/plain' });
					res.end('Not Found');
					return;
				}
				res.writeHead(200, {
					'Content-Type': mimeFromCoverExt(full),
					'Cache-Control': 'public, max-age=86400'
				});
				fs.createReadStream(full).pipe(res);
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'text/plain' });
				res.end(error.message);
			}
		} else if (req.url === '/api/games/reorder' && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', () => {
				try {
					const { order } = JSON.parse(body);
					if (!Array.isArray(order) || order.length === 0) {
						throw new Error('order 必须是非空数组');
					}
					const cfg = loadConfig();
					const byName = new Map((cfg.games || []).map(g => [g.name, g]));
					const next = [];
					const seen = new Set();
					for (const name of order) {
						if (byName.has(name) && !seen.has(name)) {
							next.push(byName.get(name));
							seen.add(name);
						}
					}
					// 未出现在 order 里的游戏追加到末尾，避免丢失
					for (const g of cfg.games || []) {
						if (!seen.has(g.name)) next.push(g);
					}
					cfg.games = next;
					saveConfig(cfg);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({
						message: '排序已保存',
						games: next.map(g => ({ ...g, coverUrl: coverPublicUrl(g.coverImage) }))
					}));
				} catch (error) {
					console.error('[Web API] Reorder games error:', error);
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: error.message }));
				}
			});
		} else if (req.url === '/api/games' && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', async () => {
				try {
					const gameData = JSON.parse(body);
					const cfg = loadConfig();
					
					if (cfg.games.find(g => g.name === (gameData.name || '').trim())) {
						throw new Error(`游戏 "${gameData.name}" 已存在`);
					}
					
					const game = buildGameFromPayload(gameData);
					fse.mkdirpSync(game.localPath);
					if (isSwitchMode(game) && game.switchPath) {
						fse.mkdirpSync(game.switchPath);
					}
					ensureGameBackupDirs(game.name);

					if (gameData.coverDataUrl) {
						game.coverImage = await saveCoverFromDataUrl(game.name, gameData.coverDataUrl, null);
					} else if (gameData.clearCover) {
						delete game.coverImage;
					}
					
					cfg.games.push(game);
					saveConfig(cfg);
					
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({
						message: `游戏 "${game.name}" 已添加`,
						game: { ...game, coverUrl: coverPublicUrl(game.coverImage) }
					}));
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
		} else if (req.url.startsWith('/api/games/') && req.url.includes('/images') && req.method === 'GET') {
			try {
				const parts = req.url.split('/').filter(Boolean);
				// api games NAME images [ID file]
				const gameName = decodeURIComponent(parts[2]);
				if (parts.length === 4 && parts[3] === 'images') {
					const meta = readImagesMeta(gameName);
					const images = meta.images.map((img) => ({
						...img,
						url: imagePublicUrl(gameName, img.id)
					}));
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ images }));
					return;
				}
				if (parts.length === 6 && parts[3] === 'images' && parts[5] === 'file') {
					const imageId = decodeURIComponent(parts[4]);
					const meta = readImagesMeta(gameName);
					const img = meta.images.find(i => i.id === imageId);
					if (!img) {
						res.writeHead(404, { 'Content-Type': 'text/plain' });
						res.end('Not Found');
						return;
					}
					const full = path.join(gameImagesDir(gameName), img.file);
					if (!fs.existsSync(full)) {
						res.writeHead(404, { 'Content-Type': 'text/plain' });
						res.end('Not Found');
						return;
					}
					res.writeHead(200, {
						'Content-Type': mimeFromCoverExt(img.file),
						'Cache-Control': 'public, max-age=86400'
					});
					fs.createReadStream(full).pipe(res);
					return;
				}
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid images request' }));
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: error.message }));
			}
		} else if (req.url.startsWith('/api/games/') && req.url.includes('/images') && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', async () => {
				try {
					const parts = req.url.split('/').filter(Boolean);
					const gameName = decodeURIComponent(parts[2]);
					const { dataUrl, note } = JSON.parse(body);
					const match = String(dataUrl || '').match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/i);
					if (!match) throw new Error('仅支持 PNG / JPG / WEBP / GIF');
					let ext = match[1].toLowerCase();
					if (ext === 'jpeg') ext = 'jpg';
					const buf = Buffer.from(match[2], 'base64');
					if (buf.length > 12 * 1024 * 1024) throw new Error('图片过大（最大 12MB）');

					ensureGameBackupDirs(gameName);
					const id = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
					const file = `${id}.${ext}`;
					await fse.writeFile(path.join(gameImagesDir(gameName), file), buf);
					const meta = readImagesMeta(gameName);
					const entry = {
						id,
						file,
						note: typeof note === 'string' ? note : '',
						createdAt: new Date().toISOString()
					};
					meta.images.unshift(entry);
					writeImagesMeta(gameName, meta);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({
						message: '截图已添加',
						image: { ...entry, url: imagePublicUrl(gameName, id) }
					}));
				} catch (error) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: error.message }));
				}
			});
		} else if (req.url.startsWith('/api/games/') && req.url.includes('/images/') && req.method === 'PUT') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', () => {
				try {
					const parts = req.url.split('/').filter(Boolean);
					const gameName = decodeURIComponent(parts[2]);
					const imageId = decodeURIComponent(parts[4]);
					const { note } = JSON.parse(body);
					const meta = readImagesMeta(gameName);
					const img = meta.images.find(i => i.id === imageId);
					if (!img) throw new Error('截图不存在');
					img.note = typeof note === 'string' ? note : '';
					writeImagesMeta(gameName, meta);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ message: '备注已更新', image: { ...img, url: imagePublicUrl(gameName, img.id) } }));
				} catch (error) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: error.message }));
				}
			});
		} else if (req.url.startsWith('/api/games/') && req.url.includes('/images/') && req.method === 'DELETE') {
			try {
				const parts = req.url.split('/').filter(Boolean);
				const gameName = decodeURIComponent(parts[2]);
				const imageId = decodeURIComponent(parts[4]);
				const meta = readImagesMeta(gameName);
				const idx = meta.images.findIndex(i => i.id === imageId);
				if (idx === -1) throw new Error('截图不存在');
				const [removed] = meta.images.splice(idx, 1);
				const full = path.join(gameImagesDir(gameName), removed.file);
				if (fs.existsSync(full)) await fse.remove(full);
				writeImagesMeta(gameName, meta);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ message: '截图已删除' }));
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: error.message }));
			}
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
					
					const newGameName = gameData.name ? gameData.name.trim() : oldGameName;
					if (newGameName !== oldGameName) {
						if (cfg.games.find(g => g.name === newGameName && g.name !== oldGameName)) {
							throw new Error(`游戏名称 "${newGameName}" 已存在`);
						}

						// 新结构：整个游戏备份目录改名
						const oldRoot = gameBackupRoot(oldGameName);
						const newRoot = gameBackupRoot(newGameName);
						if (fs.existsSync(oldRoot)) {
							if (fs.existsSync(newRoot)) {
								throw new Error(`目标备份目录已存在：${newRoot}`);
							}
							try {
								fs.renameSync(oldRoot, newRoot);
								console.log(`已重命名游戏备份目录: ${oldGameName} -> ${newGameName}`);
							} catch (renameError) {
								console.error(`重命名游戏备份目录失败:`, renameError);
							}
						}
					}
					
					const updatedGame = buildGameFromPayload({ ...gameData, name: newGameName }, cfg.games[gameIndex]);
					
					if (updatedGame.localPath) {
						fse.mkdirpSync(updatedGame.localPath);
					}
					if (isSwitchMode(updatedGame) && updatedGame.switchPath) {
						fse.mkdirpSync(updatedGame.switchPath);
					}

					if (gameData.coverDataUrl) {
						updatedGame.coverImage = await saveCoverFromDataUrl(
							updatedGame.name,
							gameData.coverDataUrl,
							cfg.games[gameIndex].coverImage
						);
					} else if (gameData.clearCover) {
						await removeCoverFile(cfg.games[gameIndex].coverImage);
						delete updatedGame.coverImage;
					}
					
					cfg.games[gameIndex] = updatedGame;
					saveConfig(cfg);
					
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({
						message: `游戏配置已更新`,
						game: { ...updatedGame, coverUrl: coverPublicUrl(updatedGame.coverImage) }
					}));
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

				const removed = cfg.games[gameIndex];
				await removeCoverFile(removed.coverImage);
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
				const backupIds = listBackupIds(gameName);

				// 如果只请求数量（旧API兼容）
				if (parts.length === 4) {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ count: backupIds.length }));
					return;
				}

				// 如果请求详细列表
				if (parts.length === 5 && parts[4] === 'list') {
					const backupList = [];
					for (const backupId of backupIds) {
						const backupPath = backupInstancePath(gameName, backupId);
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

							const backupTime = parseBackupTime(backupId, stats.mtime);

							let displayName = null;
							let syncDirection = null;
							const metaPath = path.join(backupPath, 'displayName.json');
							if (fs.existsSync(metaPath)) {
								try {
									const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
									displayName = meta.displayName || null;
									syncDirection = meta.syncDirection || null;
								} catch (err) {
									console.error(`Error reading displayName for ${backupId}:`, err);
								}
							}

							backupList.push({
								name: backupId,
								time: backupTime.toISOString(),
								size: size,
								hasLocal,
								hasRemote,
								displayName,
								syncDirection
							});
						} catch (err) {
							console.error(`Error reading backup ${backupId}:`, err);
						}
					}

					backupList.sort((a, b) => new Date(b.time) - new Date(a.time));

					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ count: backupIds.length, backups: backupList }));
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
				const backupPath = backupInstancePath(gameName, backupName);
				if (!backupPath || !fs.existsSync(backupPath)) {
					throw new Error('Backup not found');
				}
				await fse.remove(backupPath);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ message: `Backup ${backupName} deleted successfully` }));
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: error.message }));
			}
		} else if (req.url.startsWith('/api/backups/') && req.url.endsWith('/rename') && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', async () => {
				try {
					const parts = req.url.split('/');
					const gameName = decodeURIComponent(parts[3]);
					const backupName = decodeURIComponent(parts[4]);
					const { displayName } = JSON.parse(body);
					if (!displayName || typeof displayName !== 'string') {
						throw new Error('Invalid display name');
					}
					const backupPath = backupInstancePath(gameName, backupName);
					if (!backupPath || !fs.existsSync(backupPath)) {
						throw new Error('Backup not found');
					}
					const metaPath = path.join(backupPath, 'displayName.json');
					let meta = {};
					if (fs.existsSync(metaPath)) {
						try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { }
					}
					meta.displayName = displayName;
					await fs.promises.writeFile(metaPath, JSON.stringify(meta), 'utf8');
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ message: 'Backup renamed successfully' }));
				} catch (error) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: error.message }));
				}
			});
		} else if (req.url.startsWith('/api/backups/') && req.url.endsWith('/restore') && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', async () => {
				try {
					const parts = req.url.split('/');
					const gameName = decodeURIComponent(parts[3]);
					const backupName = decodeURIComponent(parts[4]);
					const cfg = loadConfig();
					const game = cfg.games.find(g => g.name === gameName);
					if (!game) {
						throw new Error(`Game '${gameName}' not found`);
					}
					const backupPath = backupInstancePath(gameName, backupName);
					const localBackupPath = backupPath ? path.join(backupPath, 'local') : null;
					if (!localBackupPath || !fs.existsSync(localBackupPath)) {
						throw new Error('Local backup not found');
					}
					await backupLocalOnly(game);
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
		} else if (req.url === '/api/remote' && req.method === 'GET') {
			try {
				const cfg = loadConfig();
				const remote = cfg.remote || {};
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					host: remote.host || '',
					port: remote.port || 22,
					user: remote.user || '',
					hasPassword: Boolean(remote.password),
					passwordHint: remote.password ? `已设置（${remote.password.length} 字符）` : '未设置'
				}));
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: error.message }));
			}
		} else if (req.url === '/api/remote' && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', () => {
				try {
					const { host, port, user, password } = JSON.parse(body);
					if (!host || !user) {
						throw new Error('主机地址和用户名为必填项');
					}
					const cfg = loadConfig();
					cfg.remote = {
						...(cfg.remote || {}),
						host: String(host).trim(),
						port: Number(port) || 22,
						user: String(user).trim()
					};
					// 密码留空表示保持原密码不变
					if (password !== undefined && password !== '') {
						cfg.remote.password = String(password);
					}
					saveConfig(cfg);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ message: 'SSH 配置已保存', remote: { host: cfg.remote.host, port: cfg.remote.port, user: cfg.remote.user } }));
				} catch (error) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: error.message }));
				}
			});
		} else if (req.url === '/api/open-folder' && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', async () => {
				try {
					const { game: gameName, side } = JSON.parse(body);
					const cfg = loadConfig();
					const game = cfg.games.find(g => g.name === gameName);
					if (!game) throw new Error(`Game '${gameName}' not found.`);

					let targetPath = game.localPath;
					if (side === 'switch') {
						targetPath = getSwitchPath(game);
					} else if (side === 'images') {
						ensureGameBackupDirs(gameName);
						targetPath = gameImagesDir(gameName);
					} else if (side === 'remote' && game.remoteFullPath) {
						// remote is SSH path, can't open locally — open local instead
						targetPath = game.localPath;
					}
					if (!fs.existsSync(targetPath)) {
						fse.mkdirpSync(targetPath);
					}

					const platform = os.platform();
					const command = platform === 'win32' ? 'explorer' : (platform === 'darwin' ? 'open' : 'xdg-open');
					spawn(command, [targetPath], { detached: true, stdio: 'ignore' }).unref();

					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ message: `Opened folder for ${gameName}`, path: targetPath }));
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

					console.log(`[Web API] Received action: ${normalizedDir} for ${game.name} (mode=${game.syncMode || 'remote'})`);

					if (normalizedDir === 'backupLocal') {
						await backupLocalOnly(game);
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ message: `Successfully backed up ${game.name} locally.` }));
					} else if (isLocalMode(game)) {
						throw new Error(`游戏 "${game.name}" 为仅本地模式，只能备份，不能同步`);
					} else if (isSwitchMode(game)) {
						await backupPcAndSwitch(game, normalizedDir);
						if (normalizedDir === 'push') {
							await syncPcToSwitch(game);
						} else if (normalizedDir === 'pull') {
							await syncSwitchToPc(game);
						}
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({
							message: `Switch 同步「${directionLabel(normalizedDir, game)}」完成：${game.name}`
						}));
						console.log(`Switch sync '${normalizedDir}' for ${game.name} completed.`);
					} else {
						const remote = cfg.remote;
						if (!remote || !remote.host || !remote.user) {
							throw new Error('SSH未配置，请在网页右上角「SSH 设置」中填写');
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
		} else if (req.url === '/api/open-backup-folder' && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', async () => {
				try {
					const { game: gameName, backup: backupName } = JSON.parse(body);
					const backupPath = backupInstancePath(gameName, backupName);
					if (!backupPath || !fs.existsSync(backupPath)) {
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
		} else if (req.url === '/api/ssh/info' && req.method === 'GET') {
			try {
				const cfg = loadConfig();
				const machine = getDefaultSshMachine(cfg);
				if (!machine) {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ configured: false, machines: cfg.sshMachines || [], defaultId: null }));
					return;
				}
				
				const port = machine.port || 22;
				let passwordHint = '未设置密码';
				if (machine.password) {
					passwordHint = `密码长度: ${machine.password.length} 字符`;
				}
				
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					configured: true,
					host: machine.host,
					port: port,
					user: machine.user,
					passwordHint: passwordHint,
					machines: cfg.sshMachines || [],
					defaultId: cfg.defaultSshMachine
				}));
			} catch (error) {
				console.error('[Web API] SSH info error:', error);
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: error.message }));
			}
		} else if (req.url === '/api/ssh/list' && req.method === 'GET') {
			try {
				const cfg = loadConfig();
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					machines: cfg.sshMachines || [],
					defaultId: cfg.defaultSshMachine
				}));
			} catch (error) {
				console.error('[Web API] SSH list error:', error);
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: error.message }));
			}
		} else if (req.url.startsWith('/api/ssh/add') && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', () => {
				try {
					const { name, host, port, user, password } = JSON.parse(body);
					if (!name || !host || !user) {
						throw new Error('名称、主机和用户不能为空');
					}
					
					const cfg = loadConfig();
					const id = Date.now().toString(36) + Math.random().toString(36).substr(2);
					const newMachine = {
						id,
						name: name.trim(),
						host: host.trim(),
						port: port || 22,
						user: user.trim(),
						password: password || ''
					};
					
					if (!cfg.sshMachines) cfg.sshMachines = [];
					cfg.sshMachines.push(newMachine);
					
					if (cfg.sshMachines.length === 1) {
						cfg.defaultSshMachine = id;
					}
					
					saveConfig(cfg);
					
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ 
						success: true, 
						machine: newMachine,
						machines: cfg.sshMachines,
						defaultId: cfg.defaultSshMachine
					}));
				} catch (error) {
					console.error('[Web API] SSH add error:', error);
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: error.message }));
				}
			});
			req.on('error', (err) => {
				console.error('[Web API] Request error:', err);
			});
		} else if (req.url.startsWith('/api/ssh/delete') && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', () => {
				try {
					const { id } = JSON.parse(body);
					const cfg = loadConfig();
					
					cfg.sshMachines = cfg.sshMachines.filter(m => m.id !== id);
					
					if (cfg.defaultSshMachine === id) {
						cfg.defaultSshMachine = cfg.sshMachines.length > 0 ? cfg.sshMachines[0].id : null;
					}
					
					saveConfig(cfg);
					
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ 
						success: true,
						machines: cfg.sshMachines,
						defaultId: cfg.defaultSshMachine
					}));
				} catch (error) {
					console.error('[Web API] SSH delete error:', error);
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: error.message }));
				}
			});
			req.on('error', (err) => {
				console.error('[Web API] Request error:', err);
			});
		} else if (req.url.startsWith('/api/ssh/set-default') && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', () => {
				try {
					const { id } = JSON.parse(body);
					const cfg = loadConfig();
					
					const machine = cfg.sshMachines.find(m => m.id === id);
					if (!machine) {
						throw new Error('SSH机器不存在');
					}
					
					cfg.defaultSshMachine = id;
					saveConfig(cfg);
					
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ 
						success: true,
						defaultId: cfg.defaultSshMachine
					}));
				} catch (error) {
					console.error('[Web API] SSH set-default error:', error);
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: error.message }));
				}
			});
			req.on('error', (err) => {
				console.error('[Web API] Request error:', err);
			});
		} else if (req.url.startsWith('/api/ssh/connect-by-id') && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => { body += chunk.toString(); });
			req.on('end', () => {
				try {
					const { id } = JSON.parse(body);
					const cfg = loadConfig();
					
					const machine = cfg.sshMachines.find(m => m.id === id);
					if (!machine) {
						throw new Error('SSH机器不存在');
					}
					
					const port = machine.port || 22;
					const sshUser = machine.user;
					const sshHost = machine.host;
					
					console.log(`[Web API] Opening SSH connection to: ${sshUser}@${sshHost}:${port}`);
					
					const platform = os.platform();
					let command, args;
					
					if (platform === 'win32') {
						command = 'cmd';
						if (port === 22) {
							args = ['/c', 'start', 'cmd', '/k', `ssh ${sshUser}@${sshHost}`];
						} else {
							args = ['/c', 'start', 'cmd', '/k', `ssh -p ${port} ${sshUser}@${sshHost}`];
						}
					} else if (platform === 'darwin') {
						if (port === 22) {
							command = 'osascript';
							args = ['-e', `tell application "Terminal" to do script "ssh ${sshUser}@${sshHost}"`];
						} else {
							command = 'osascript';
							args = ['-e', `tell application "Terminal" to do script "ssh -p ${port} ${sshUser}@${sshHost}"`];
						}
					} else {
						if (port === 22) {
							command = 'x-terminal-emulator';
							args = ['-e', 'ssh', sshUser + '@' + sshHost];
						} else {
							command = 'x-terminal-emulator';
							args = ['-e', 'ssh', '-p', String(port), sshUser + '@' + sshHost];
						}
					}
					
					spawn(command, args, { detached: true, stdio: 'ignore', shell: true }).unref();
					
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ success: true, message: `SSH connection opened to ${sshUser}@${sshHost}` }));
				} catch (error) {
					console.error('[Web API] SSH connect by id error:', error);
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: error.message }));
				}
			});
			req.on('error', (err) => {
				console.error('[Web API] Request error:', err);
			});
		} else if (req.url === '/api/ssh/connect' && req.method === 'POST') {
			try {
				const cfg = loadConfig();
				const remote = cfg.remote;
				if (!remote || !remote.host || !remote.user) {
					throw new Error('SSH未配置，请在配置文件中设置');
				}
				
				const port = remote.port || 22;
				const sshUser = remote.user;
				const sshHost = remote.host;
				
				console.log(`[Web API] Opening SSH: ${sshUser}@${sshHost}:${port}`);
				
				const platform = os.platform();
				if (platform === 'win32') {
					spawn('cmd', ['/c', 'start', 'cmd', '/k', `ssh ${sshUser}@${sshHost}`], { detached: true, stdio: 'ignore', shell: true }).unref();
				} else if (platform === 'darwin') {
					spawn('osascript', ['-e', `tell application "Terminal" to do script "ssh ${sshUser}@${sshHost}"`], { detached: true, stdio: 'ignore' }).unref();
				} else {
					spawn('x-terminal-emulator', ['-e', 'ssh', sshUser + '@' + sshHost], { detached: true, stdio: 'ignore' }).unref();
				}
				
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ message: 'SSH连接已打开' }));
			} catch (error) {
				console.error('[Web API] SSH error:', error);
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: error.message }));
			}
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
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, () => {
			const url = `http://localhost:${port}`;
			webServerInfo = { port, url, server };
			console.log(`✅ Web 服务器已启动: ${url}`);
			if (openBrowser) {
				try {
					const platform = os.platform();
					const command = platform === 'win32' ? 'start' : (platform === 'darwin' ? 'open' : 'xdg-open');
					spawn(command, [url], { detached: true, stdio: 'ignore', shell: true }).unref();
				} catch (e) {
					console.error('无法自动打开浏览器:', e);
				}
			}
			resolve();
		});
	});

	return webServerInfo;
}

async function startTrayMode({ openBrowser = false } = {}) {
	if (os.platform() !== 'win32') {
		console.log('当前系统非 Windows，托盘模式将仅启动 Web 服务。');
	}

	const info = await startWebServer({ openBrowser });
	console.log(`托盘模式运行中：${info.url}`);
	console.log('可从系统托盘图标控制；关闭托盘菜单中的「退出」结束程序。');

	let SysTray;
	try {
		SysTray = systray2Import?.default || systray2Import?.SysTray || systray2Import;
		if (typeof SysTray !== 'function') {
			throw new Error(`无法识别 SysTray 构造函数（typeof=${typeof SysTray}）`);
		}
	} catch (err) {
		console.error('无法加载托盘模块 systray2。', err.message || err);
		console.log('Web 服务仍在运行，按 Ctrl+C 退出。');
		await new Promise(() => {});
		return;
	}

	if (!fs.existsSync(FAVICON_PATH) && !fs.existsSync(TRAY_ICON_PATH)) {
		console.warn(`未找到图标文件（src/favicon.png），托盘可能无图标。`);
	}

	const iconBase64 = loadTrayIconBase64();

	const itemOpenWeb = { title: '打开 Web 界面', tooltip: info.url, checked: false, enabled: true };
	const itemOpenBackup = { title: '打开备份文件夹', tooltip: BACKUP_DIR, checked: false, enabled: true };
	const itemOpenConfig = { title: '打开配置文件', tooltip: CONFIG_PATH, checked: false, enabled: true };
	const itemChooseData = { title: 'Choose data folder...', tooltip: WORK_ROOT, checked: false, enabled: true };
	const itemExit = { title: '退出', tooltip: '退出 Game Save Manager', checked: false, enabled: true };

	const systray = new SysTray({
		menu: {
			icon: iconBase64,
			title: 'GSM',
			tooltip: `Game Save Manager\n${info.url}\n${WORK_ROOT}`,
			items: [
				itemOpenWeb,
				itemOpenBackup,
				itemOpenConfig,
				itemChooseData,
				SysTray.separator,
				itemExit
			]
		},
		debug: false,
		copyDir: true
	});

	systray.onClick((action) => {
		const title = action?.item?.title;
		if (title === '打开 Web 界面') {
			openWebPage().catch((e) => console.error(e));
			return;
		}
		if (title === '打开备份文件夹') {
			openBackupDir().catch((e) => console.error(e));
			return;
		}
		if (title === '打开配置文件') {
			openConfigFile().catch((e) => console.error(e));
			return;
		}
		if (title === 'Choose data folder...') {
			const picked = pickFolderDialog('Select GSM data folder (data/ and backups/ will be created here)', WORK_ROOT);
			if (picked) {
				setWorkRoot(picked);
				itemChooseData.tooltip = WORK_ROOT;
				itemOpenBackup.tooltip = BACKUP_DIR;
				itemOpenConfig.tooltip = CONFIG_PATH;
				try { systray.sendAction({ type: 'update-item', item: itemChooseData }); } catch { }
				try { systray.sendAction({ type: 'update-item', item: itemOpenBackup }); } catch { }
				try { systray.sendAction({ type: 'update-item', item: itemOpenConfig }); } catch { }
				console.log(`数据目录已切换为：${WORK_ROOT}`);
			}
			return;
		}
		if (title === '退出') {
			try { systray.kill(false); } catch { }
			process.exit(0);
		}
	});

	await new Promise(() => {});
}

async function run() {
	const args = parseArgs(process.argv.slice(2));

	if (args.root) {
		setWorkRoot(String(args.root));
	} else {
		ensureDirs();
	}

	// 打包后的 EXE：默认直接进入托盘模式
	if (isPackaged && args.tray === undefined && args.web === undefined && args.game === undefined) {
		args.tray = true;
		args.open = true;
	}

	if (args.tray) {
		return startTrayMode({ openBrowser: Boolean(args.open || args.browser || isPackaged) });
	}

	if (args.web) {
		return startWebServer({ openBrowser: true });
	}

	while (true) {
		const cfg = loadConfig();
		const game = await pickOrCreateGame(cfg, args.game);

		if (game === 'tray-running') {
			return;
		}

		if (!game) {
			console.log('\n返回主菜单...');
			delete args.game;
			delete args.direction;
			continue;
		}

		const direction = await resolveDirection(args.direction, game);
		
		if (direction === null) {
			console.log('\n返回上级菜单...');
			delete args.game;
			delete args.direction;
			continue;
		}
		
		if (direction === 'backupLocal') {
			await backupLocalOnly(game);
		} else if (isLocalMode(game)) {
			console.error(`游戏 "${game.name}" 为仅本地模式，只能备份，不能同步。`);
			process.exitCode = 1;
		} else if (isSwitchMode(game)) {
			try {
				console.log(`Switch 同步模式：${directionLabel(direction, game)}`);
				await backupPcAndSwitch(game, direction);
				if (direction === 'push') {
					await syncPcToSwitch(game);
				} else {
					await syncSwitchToPc(game);
				}
			} catch (err) {
				console.error('Switch 同步失败：', err.message || err);
				process.exitCode = 1;
			}
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
