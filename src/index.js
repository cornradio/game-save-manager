import fs from 'fs';
import fse from 'fs-extra';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';
import dayjs from 'dayjs';
import which from 'which';
import { spawn } from 'child_process';
import SFTPClient from 'ssh2-sftp-client';

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
	if (cfg.games.length === 0) {
		console.log('尚未配置任何游戏，将为你创建一个。');
		return await createGame(cfg);
	}
	const choices = cfg.games.map((g, idx) => ({ name: `${g.name}  - ${g.localPath}`, value: idx }));
	choices.push({ name: '新建游戏', value: -1 });
	const { idx } = await inquirer.prompt([
		{ type: 'list', name: 'idx', message: '选择一个游戏：', choices }
	]);
	if (idx === -1) {
		return await createGame(cfg);
	}
	return cfg.games[idx];
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
		try { await sftp.end(); } catch {}
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
		try { await sftp.mkdir(cur); } catch {}
	}
}

async function sftpRemoveRecursive(sftp, remoteDir) {
	const normalized = remoteDir.replace(/\\/g, '/').replace(/\/+$/, '');
	const list = await sftp.list(normalized);
	for (const item of list) {
		const rp = `${normalized}/${item.name}`;
		if (item.type === 'd') {
			await sftpRemoveRecursive(sftp, rp);
			try { await sftp.rmdir(rp); } catch {}
		} else {
			try { await sftp.delete(rp); } catch {}
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
		} catch {}
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
	try { scpPath = which.sync('scp'); } catch {}
	try { pscpPath = which.sync('pscp'); } catch {}
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
			try { await fse.remove(tempDir); } catch {}
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

async function backupBoth(game, remote) {
	const root = path.join(BACKUP_DIR, `${game.name}_${timestamp()}`);
	const localDest = path.join(root, 'local');
	const remoteDest = path.join(root, 'remote');
	await backupLocal(game, localDest);
	await backupRemote(game, remote, remoteDest);
}

async function backupLocalOnly(game) {
	const root = path.join(BACKUP_DIR, `${game.name}_${timestamp()}`);
	const localDest = path.join(root, 'local');
	await backupLocal(game, localDest);
	console.log(`本地存档备份已完成（仅备份模式）：${localDest}`);
}

async function testSftpConnection(game, remote) {
	console.log(`正在测试 SFTP 连接：${remote.user}@${remote.host}:${remote.port || 22}`);
	try {
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
	} catch (err) {
		console.error('SFTP 测试失败，请检查主机/账号/密码：', err.message || err);
		throw err;
	}
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

async function run() {
	ensureDirs();
	const args = parseArgs(process.argv.slice(2));
	const cfg = loadConfig();
	const game = await pickOrCreateGame(cfg, args.game);
	const direction = await resolveDirection(args.direction);
	if (direction === 'backupLocal') {
		await backupLocalOnly(game);
		return;
	}
	const remote = await ensureRemote(cfg);
	const ensuredGame = await ensureGameRemotePath(game, cfg);
	await testSftpConnection(ensuredGame, remote);
	console.log('开始备份本地与远程...');
	await backupBoth(ensuredGame, remote);
	const prefer = cfg.preferScpTool || 'auto';
	const canUseScp = (() => {
		const d = detectScpTools();
		return Boolean(d.scpPath || d.pscpPath);
	})();
	try {
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
		console.error('同步失败：', err.message || err);
		process.exitCode = 1;
	}
}

run().catch(err => {
	console.error(err);
	process.exit(1);
});


