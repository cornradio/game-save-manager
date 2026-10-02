/**
 * Pack into a single Windows EXE (Tray Mode on double-click, no console window).
 *
 * Flow: esbuild -> CJS + html/favicon/traybin -> @yao-pkg/pkg -> set GUI subsystem
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist', 'pack');
const releaseDir = path.join(root, 'release');
const exeName = 'GameSaveManager.exe';

function fail(msg) {
	console.error(msg);
	process.exit(1);
}

function ensureDep(name) {
	try {
		require.resolve(name, { paths: [root] });
	} catch {
		fail(`Missing devDependency ${name}. Run: npm install`);
	}
}

/** Flip PE OptionalHeader.Subsystem from CONSOLE (3) to WINDOWS GUI (2). */
function setWindowsSubsystemGui(exePath) {
	const fd = fs.openSync(exePath, 'r+');
	try {
		const peOffBuf = Buffer.alloc(4);
		fs.readSync(fd, peOffBuf, 0, 4, 0x3C);
		const peOffset = peOffBuf.readUInt32LE(0);

		const sig = Buffer.alloc(4);
		fs.readSync(fd, sig, 0, 4, peOffset);
		if (sig.toString('latin1') !== 'PE\0\0') {
			throw new Error('Not a PE executable');
		}

		const magicBuf = Buffer.alloc(2);
		fs.readSync(fd, magicBuf, 0, 2, peOffset + 24);
		const magic = magicBuf.readUInt16LE(0);
		if (magic !== 0x10b && magic !== 0x20b) {
			throw new Error(`Unknown optional header magic: 0x${magic.toString(16)}`);
		}

		const subsystemOffset = peOffset + 24 + 68;
		const sub = Buffer.alloc(2);
		fs.readSync(fd, sub, 0, 2, subsystemOffset);
		const before = sub.readUInt16LE(0);
		sub.writeUInt16LE(2, 0); // IMAGE_SUBSYSTEM_WINDOWS_GUI
		fs.writeSync(fd, sub, 0, 2, subsystemOffset);
		console.log(`-> PE subsystem ${before} -> 2 (WINDOWS GUI)`);
	} finally {
		fs.closeSync(fd);
	}
}

async function main() {
	ensureDep('esbuild');
	ensureDep('@yao-pkg/pkg');

	const esbuild = require('esbuild');
	const fse = require('fs-extra');

	console.log('-> prepare output dirs');
	await fse.emptyDir(outDir);
	await fse.ensureDir(releaseDir);

	const faviconSrc = path.join(root, 'src', 'favicon.png');
	const htmlSrc = path.join(root, 'src', 'index.html');
	const traybinSrc = path.join(root, 'node_modules', 'systray2', 'traybin');

	if (!fs.existsSync(faviconSrc)) fail(`Missing ${faviconSrc}`);
	if (!fs.existsSync(htmlSrc)) fail(`Missing ${htmlSrc}`);
	if (!fs.existsSync(traybinSrc)) fail('Missing systray2 traybin. Run npm install');

	console.log('-> esbuild src/index.js -> dist/pack/gsm.cjs');
	await esbuild.build({
		entryPoints: [path.join(root, 'src', 'index.js')],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		outfile: path.join(outDir, 'gsm.cjs'),
		target: 'node18',
		minify: false,
		sourcemap: false,
		logLevel: 'info',
		banner: {
			js: 'var __import_meta_url = require("url").pathToFileURL(__filename).href;'
		},
		define: {
			'import.meta.url': '__import_meta_url'
		}
	});

	// Verify systray2 was bundled (must not remain as runtime require)
	const bundled = fs.readFileSync(path.join(outDir, 'gsm.cjs'), 'utf8');
	if (/require\(["']systray2["']\)/.test(bundled)) {
		fail('systray2 was not bundled (still required at runtime). Pack aborted.');
	}

	const entryPath = path.join(outDir, 'entry.cjs');
	await fse.writeFile(
		entryPath,
		`// Auto-generated pack entry — do not edit
'use strict';
process.env.GSM_PACKAGED = '1';
const args = process.argv.slice(2);
const hasMode = args.some((a) =>
  a === '--tray' || a === '--web' || a.startsWith('--game') || a === '--game'
);
if (!hasMode) {
  process.argv.push('--tray', '--open');
}
require('./gsm.cjs');
`
	);

	console.log('-> copy assets + traybin');
	await fse.copy(htmlSrc, path.join(outDir, 'index.html'));
	await fse.copy(faviconSrc, path.join(outDir, 'favicon.png'));
	await fse.copy(traybinSrc, path.join(outDir, 'traybin'));

	const pkgJson = {
		name: 'game-save-manager-pack',
		version: '1.0.0',
		bin: 'entry.cjs',
		pkg: {
			assets: ['index.html', 'favicon.png', 'traybin/**/*'],
			targets: ['node18-win-x64'],
			outputPath: releaseDir
		}
	};
	await fse.writeJson(path.join(outDir, 'package.json'), pkgJson, { spaces: 2 });

	const exeOut = path.join(releaseDir, exeName);
	console.log(`-> @yao-pkg/pkg -> ${exeOut}`);
	const pkgCli = require.resolve('@yao-pkg/pkg/lib-es5/bin.js', { paths: [root] });
	const result = spawnSync(
		process.execPath,
		[pkgCli, 'entry.cjs', '-t', 'node18-win-x64', '-o', exeOut, '-c', 'package.json'],
		{ cwd: outDir, stdio: 'inherit', env: process.env }
	);

	if (result.status !== 0) {
		fail('pkg failed');
	}

	if (!fs.existsSync(exeOut)) {
		fail(`Output not found: ${exeOut}`);
	}

	setWindowsSubsystemGui(exeOut);

	const sizeMb = (fs.statSync(exeOut).size / (1024 * 1024)).toFixed(1);
	console.log('');
	console.log(`OK: ${exeOut} (${sizeMb} MB)`);
	console.log('  Double-click -> Tray Mode + Web UI (no console window)');
	console.log('  data/ and backups/ are under the chosen work folder (default: next to EXE)');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
