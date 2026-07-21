// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
//
// Windows pane launcher for interactive Codex sessions. Windows' Node (libuv) cannot
// connect to AF_UNIX sockets, so unlike the POSIX `codex` launcher next to this file
// the pane app-server listens on a loopback WebSocket port protected by a capability
// token. The pane token already present in the terminal environment doubles as that
// capability token: only its SHA-256 digest is passed to the app-server command line
// and the plaintext never touches disk. The actual port is written to the pane's
// endpoint file so the Para Code shared process (mobile relay) can connect too.
//
// Invoked by codex.cmd / codex.ps1 with the Para Code executable running as Node
// (ELECTRON_RUN_AS_NODE=1). Non-interactive subcommands are delegated unchanged to
// the user's real Codex installation.

'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ENDPOINT_ENV_VAR = 'PARA_CODE_CODEX_APP_SERVER_ENDPOINT';
const PANE_TOKEN_ENV_VAR = 'PARA_CODE_TERMINAL_PANE_ID';
const LAUNCHER_DIR_ENV_VAR = 'PARA_CODE_CODEX_LAUNCHER_DIR';

const OPTIONS_WITH_VALUE = new Set([
	'-c', '--config', '--enable', '--disable', '--remote-auth-token-env', '-i', '--image', '-m', '--model',
	'--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval',
]);
const NON_INTERACTIVE_COMMANDS = new Set([
	'exec', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'cloud', 'debug',
	'apply', 'sandbox', 'features', 'remote-control',
]);

const SERVER_START_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 2_000;

function fail(message, code) {
	process.stderr.write(`Para Code: ${message}${os.EOL}`);
	process.exit(code);
}

function samePath(a, b) {
	const normalize = value => process.platform === 'win32'
		? path.resolve(value).toLowerCase().replace(/[\\/]+$/, '')
		: path.resolve(value).replace(/\/+$/, '');
	return normalize(a) === normalize(b);
}

/** Mirrors the POSIX launcher's classification of delegated (non pane-managed) commands. */
function isManagedInvocation(args) {
	let skipNext = false;
	let firstPositional = true;
	for (const argument of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (argument === '--remote' || argument.startsWith('--remote=')) {
			return false;
		}
		if (argument === '--') {
			break;
		}
		if (OPTIONS_WITH_VALUE.has(argument)) {
			skipNext = true;
			continue;
		}
		if (argument === '--help' || argument === '-h' || argument === '--version' || argument === '-V') {
			return false;
		}
		if (argument.startsWith('-')) {
			continue;
		}
		if (firstPositional && NON_INTERACTIVE_COMMANDS.has(argument)) {
			return false;
		}
		firstPositional = false;
	}
	return true;
}

function cleanPathEntries() {
	const launcherDir = process.env[LAUNCHER_DIR_ENV_VAR] || __dirname;
	const entries = (process.env.PATH || '').split(path.delimiter).filter(entry => entry.length > 0);
	return entries.filter(entry => !samePath(entry, launcherDir));
}

function fileExists(candidate) {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/**
 * Bounded search for the native codex.exe inside an npm-style installation
 * (`<dir>/node_modules/@openai/**`). The vendor layout has changed across Codex
 * versions, so match by file name instead of a hardcoded path.
 */
function findNativeCodexUnder(rootDir) {
	const queue = [{ dir: rootDir, depth: 0 }];
	let visited = 0;
	while (queue.length > 0 && visited < 4_000) {
		const { dir, depth } = queue.shift();
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			visited++;
			const candidate = path.join(dir, entry.name);
			if (entry.isFile() && entry.name.toLowerCase() === 'codex.exe') {
				return candidate;
			}
			if (entry.isDirectory() && depth < 7) {
				queue.push({ dir: candidate, depth: depth + 1 });
			}
		}
	}
	return undefined;
}

/**
 * Resolves the user's real Codex after removing this launcher's directory from PATH.
 * Preferred forms, per PATH directory:
 *  1. a native `codex.exe` (spawned directly — no cmd re-parsing of arguments)
 *  2. an npm shim (`codex.cmd` / `codex.ps1` / `codex`): run its `bin/codex.js` with
 *     our own Node runtime, or spawn the vendored native exe found under it
 *  3. a directly spawnable extensionless `codex` (non-Windows dev/test environments)
 */
function resolveRealCodex(pathEntries) {
	for (const dir of pathEntries) {
		const nativeExe = path.join(dir, 'codex.exe');
		if (fileExists(nativeExe)) {
			return { command: nativeExe, prefixArgs: [], useOwnNode: false };
		}
		const shimCandidates = ['codex.cmd', 'codex.ps1', 'codex'].map(name => path.join(dir, name));
		if (!shimCandidates.some(fileExists)) {
			continue;
		}
		const npmEntry = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
		if (fileExists(npmEntry)) {
			return { command: process.execPath, prefixArgs: [npmEntry], useOwnNode: true };
		}
		const vendored = findNativeCodexUnder(path.join(dir, 'node_modules', '@openai'));
		if (vendored !== undefined) {
			return { command: vendored, prefixArgs: [], useOwnNode: false };
		}
		const plain = path.join(dir, 'codex');
		if (process.platform !== 'win32' && fileExists(plain)) {
			return { command: plain, prefixArgs: [], useOwnNode: false };
		}
	}
	return undefined;
}

function childEnvironment(pathEntries, useOwnNode) {
	const environment = { ...process.env, PATH: pathEntries.join(path.delimiter) };
	if (useOwnNode) {
		environment.ELECTRON_RUN_AS_NODE = '1';
	} else {
		delete environment.ELECTRON_RUN_AS_NODE;
	}
	return environment;
}

function spawnCodex(real, args, options) {
	return childProcess.spawn(real.command, [...real.prefixArgs, ...args], options);
}

function readEndpointRecord(endpointPath) {
	try {
		const parsed = JSON.parse(fs.readFileSync(endpointPath, 'utf8'));
		if (parsed === null || typeof parsed !== 'object') {
			return undefined;
		}
		const port = parsed.port;
		const pid = parsed.pid;
		if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535 || !Number.isSafeInteger(pid) || pid <= 0) {
			return undefined;
		}
		const ownerPid = Number.isSafeInteger(parsed.ownerPid) && parsed.ownerPid > 0 ? parsed.ownerPid : undefined;
		return { port, pid, ownerPid };
	} catch {
		return undefined;
	}
}

function writeEndpointRecord(endpointPath, record) {
	const temporaryPath = `${endpointPath}.${process.pid}.tmp`;
	fs.writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`);
	fs.renameSync(temporaryPath, endpointPath);
}

function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killServerTree(pid) {
	try {
		if (process.platform === 'win32') {
			childProcess.spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
		} else {
			process.kill(pid, 'SIGTERM');
		}
	} catch {
		// already gone
	}
}

/** Removes endpoint records whose app-server process is no longer alive. */
function sweepDeadEndpoints(runtimeDir) {
	let entries;
	try {
		entries = fs.readdirSync(runtimeDir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (!name.endsWith('.endpoint.json')) {
			continue;
		}
		const endpointPath = path.join(runtimeDir, name);
		const record = readEndpointRecord(endpointPath);
		if (record === undefined || !processIsAlive(record.pid)) {
			try {
				fs.rmSync(endpointPath, { force: true });
				fs.rmSync(`${endpointPath}.log`, { force: true });
			} catch {
				// best effort
			}
		}
	}
}

/**
 * Proves a listening port is this pane's app-server by completing an authenticated
 * WebSocket upgrade handshake: only a server started with the SHA-256 digest of this
 * pane's token answers 101 to this Authorization header.
 */
function probeEndpointAuth(port, paneToken) {
	return new Promise(resolve => {
		const request = http.request({
			host: '127.0.0.1',
			port,
			method: 'GET',
			path: '/',
			headers: {
				'Connection': 'Upgrade',
				'Upgrade': 'websocket',
				'Sec-WebSocket-Version': '13',
				'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
				'Authorization': `Bearer ${paneToken}`,
			},
			timeout: PROBE_TIMEOUT_MS,
		});
		const finish = result => {
			request.destroy();
			resolve(result);
		};
		request.on('upgrade', (_response, socket) => {
			socket.destroy();
			finish(true);
		});
		request.on('response', response => {
			response.destroy();
			finish(false);
		});
		request.on('timeout', () => finish(false));
		request.on('error', () => finish(false));
		request.end();
	});
}

function startPaneServer(real, pathEntries, endpointPath, paneToken) {
	return new Promise(resolve => {
		const tokenDigest = crypto.createHash('sha256').update(paneToken, 'utf8').digest('hex');
		const logPath = `${endpointPath}.log`;
		const logStream = fs.createWriteStream(logPath, { flags: 'w' });
		const server = spawnCodex(real, [
			'app-server', '--listen', 'ws://127.0.0.1:0', '--ws-auth', 'capability-token', '--ws-token-sha256', tokenDigest,
		], {
			detached: true,
			windowsHide: true,
			stdio: ['ignore', 'ignore', 'pipe'],
			env: childEnvironment(pathEntries, real.useOwnNode),
		});
		let settled = false;
		let stderrTail = '';
		const settle = result => {
			if (!settled) {
				settled = true;
				resolve(result);
			}
		};
		const timeout = setTimeout(() => {
			killServerTree(server.pid);
			settle({ error: `timed out waiting for pane Codex app-server. See ${logPath}` });
		}, SERVER_START_TIMEOUT_MS);
		server.on('error', error => {
			clearTimeout(timeout);
			settle({ error: `pane Codex app-server failed to start: ${error.message}` });
		});
		server.on('exit', () => {
			clearTimeout(timeout);
			settle({ error: `pane Codex app-server failed to start. See ${logPath}` });
		});
		server.stderr.on('data', chunk => {
			logStream.write(chunk);
			if (settled) {
				return;
			}
			stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8_192);
			// codex 0.144時点の実出力は `listening on: ws://127.0.0.1:<port>`。表記変更に
			// 多少耐えるようhost部分は固定しない（listenは常に127.0.0.1へ指示している）。
			const match = /listening on:\s*ws:\/\/\S*:(\d{1,5})/.exec(stderrTail);
			if (match !== null) {
				clearTimeout(timeout);
				// exit/errorリスナーは残す: settleは冪等なので起動成功後の発火は無視される。
				settle({ server, port: Number(match[1]), logStream });
			}
		});
	});
}

async function runManaged(real, pathEntries, args) {
	const endpointPath = process.env[ENDPOINT_ENV_VAR] || '';
	const endpointName = path.basename(endpointPath);
	if (!path.isAbsolute(endpointPath) || !/^[A-Za-z0-9._-]{1,64}\.endpoint\.json$/.test(endpointName)
		|| path.basename(path.dirname(endpointPath)) !== 'pcx') {
		fail(`${ENDPOINT_ENV_VAR} is missing or invalid.`, 2);
	}
	const paneToken = process.env[PANE_TOKEN_ENV_VAR] || '';
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(paneToken)) {
		fail(`${PANE_TOKEN_ENV_VAR} is missing or invalid.`, 2);
	}
	const runtimeDir = path.dirname(endpointPath);
	fs.mkdirSync(runtimeDir, { recursive: true });
	sweepDeadEndpoints(runtimeDir);

	let port;
	let ownedServer;
	const existing = readEndpointRecord(endpointPath);
	if (existing !== undefined && processIsAlive(existing.pid) && await probeEndpointAuth(existing.port, paneToken)) {
		port = existing.port;
		if (existing.ownerPid === undefined || !processIsAlive(existing.ownerPid)) {
			// The launcher that started this server is gone (for example a closed
			// terminal tab): adopt the orphan so this session cleans it up on exit.
			ownedServer = { pid: existing.pid, port: existing.port, adopted: true };
			writeEndpointRecord(endpointPath, { port: existing.port, pid: existing.pid, ownerPid: process.pid });
		}
	} else {
		const started = await startPaneServer(real, pathEntries, endpointPath, paneToken);
		if (started.error !== undefined) {
			fail(started.error, 1);
		}
		port = started.port;
		ownedServer = { pid: started.server.pid, port, child: started.server, logStream: started.logStream };
		try {
			writeEndpointRecord(endpointPath, { port, pid: started.server.pid, ownerPid: process.pid });
		} catch (error) {
			killServerTree(started.server.pid);
			fail(`could not record the pane Codex app-server endpoint: ${error.message}`, 1);
		}
		started.server.unref();
	}

	const cleanup = () => {
		if (ownedServer === undefined) {
			return;
		}
		const owned = ownedServer;
		ownedServer = undefined;
		const record = readEndpointRecord(endpointPath);
		if (record !== undefined && record.ownerPid !== process.pid) {
			return;
		}
		// PID再利用で無関係なプロセスを殺さないよう、kill前に「その正体」を再確認する:
		// 自分がspawnした子はhandleの終了状態が正、adoptした孤児は記録との一致とpid生存で判定する。
		const stillOurs = owned.child !== undefined
			? owned.child.exitCode === null && owned.child.signalCode === null
			: record !== undefined && record.pid === owned.pid && record.port === owned.port && processIsAlive(owned.pid);
		if (stillOurs) {
			killServerTree(owned.pid);
		}
		if (owned.logStream !== undefined) {
			owned.logStream.end();
		}
		try {
			fs.rmSync(endpointPath, { force: true });
			fs.rmSync(`${endpointPath}.log`, { force: true });
		} catch {
			// best effort
		}
	};

	const tui = spawnCodex(real, ['--remote', `ws://127.0.0.1:${port}`, '--remote-auth-token-env', PANE_TOKEN_ENV_VAR, ...args], {
		stdio: 'inherit',
		env: childEnvironment(pathEntries, real.useOwnNode),
	});
	// Ctrl+C reaches the interactive Codex through the shared console; the launcher
	// must stay alive to clean up after the TUI decides to exit.
	process.on('SIGINT', () => { });
	const terminate = exitCode => {
		try {
			tui.kill();
		} catch {
			// already gone
		}
		cleanup();
		process.exit(exitCode);
	};
	process.on('SIGTERM', () => terminate(143));
	// Node maps a closing console window (CTRL_CLOSE_EVENT) to SIGHUP on Windows.
	process.on('SIGHUP', () => terminate(129));
	tui.on('exit', (code, signal) => {
		cleanup();
		process.exit(typeof code === 'number' ? code : signal === 'SIGINT' ? 130 : 1);
	});
	tui.on('error', error => {
		cleanup();
		fail(`could not start Codex: ${error.message}`, 1);
	});
}

function runDelegated(real, pathEntries, args) {
	const child = spawnCodex(real, args, {
		stdio: 'inherit',
		env: childEnvironment(pathEntries, real.useOwnNode),
	});
	process.on('SIGINT', () => { });
	process.on('SIGTERM', () => { try { child.kill(); } catch { /* already gone */ } });
	child.on('exit', (code, signal) => process.exit(typeof code === 'number' ? code : signal === 'SIGINT' ? 130 : 1));
	child.on('error', error => fail(`could not start Codex: ${error.message}`, 1));
}

function main() {
	const args = process.argv.slice(2);
	const pathEntries = cleanPathEntries();
	const real = resolveRealCodex(pathEntries);
	if (real === undefined) {
		fail('Codex executable was not found after the pane launcher.', 127);
	}
	if (isManagedInvocation(args)) {
		runManaged(real, pathEntries, args).catch(error => fail(String(error && error.message ? error.message : error), 1));
	} else {
		runDelegated(real, pathEntries, args);
	}
}

main();
