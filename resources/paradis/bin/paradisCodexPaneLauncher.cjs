// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
//
// Windows launcher for interactive Codex sessions, the counterpart of the POSIX `codex`
// launcher next to this file. It keeps interactive sessions off Codex's shared background
// server (`--no-daemon`, or the auto-start override for Codex 0.155 and older) and delegates
// every other subcommand to the user's real Codex unchanged.
//
// It used to start a pane-scoped `codex app-server` and attach the TUI with `--remote`. That
// mode was removed: Codex rejects permission overrides with `--remote resume|fork`, and the
// pane app-server restarted every MCP server for each terminal.
//
// Invoked by codex.cmd / codex.ps1 with a Node runtime (a console-subsystem node.exe, or the
// Para Code executable with ELECTRON_RUN_AS_NODE=1).

'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LAUNCHER_DIR_ENV_VAR = 'PARA_CODE_CODEX_LAUNCHER_DIR';
// Set by codex.cmd / codex.ps1 to `resolve` when no console-subsystem node.exe is available:
// the launcher then only prints the user's Codex executable, and the script runs it itself so
// the interactive session keeps the terminal's console.
const MODE_ENV_VAR = 'PARA_CODE_CODEX_LAUNCHER_MODE';

const OPTIONS_WITH_VALUE = new Set([
	'-c', '--config', '--enable', '--disable', '--remote-auth-token-env', '-i', '--image', '-m', '--model',
	'--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval',
]);
// `--no-daemon` is a TUI option, so only an invocation that opens the TUI gets it: no
// subcommand at all (a bare prompt), `resume`, or `fork`. Every other subcommand is delegated
// unchanged. This is Codex 0.146's full set (aliases and the internal subcommands `codex --help`
// hides included) minus the TUI commands, plus `agents` and the 0.158 additions. A subcommand
// missing here gets `--no-daemon` and may refuse it; the POSIX launcher and the mobile relay's
// command parser carry the same list.
const TUI_COMMANDS = new Set(['resume', 'fork']);
const NON_INTERACTIVE_COMMANDS = new Set([
	'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'mcp-server', 'app-server', 'remote-control',
	'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'archive', 'delete', 'unarchive',
	'cloud', 'exec-server', 'execpolicy', 'responses-api-proxy', 'stdio-to-uds', 'features', 'help', 'agents', 'queue', 'migrate-rollouts', 'tcp-tunnel',
]);

const DAEMON_PROBE_TIMEOUT_MS = 5_000;

function fail(message, code) {
	process.stderr.write(`Para Code: ${message}${os.EOL}`);
	process.exit(code);
}

/**
 * Arguments that keep an interactive session off Codex's shared background server.
 *
 * Codex attaches an interactive session to that server whenever one is running for this
 * CODEX_HOME (0.157 and later also start it on first use), and hooks and MCP servers then run
 * with the environment of whichever terminal started it — the wrong pane, or none. Codex 0.156
 * and later accept `--no-daemon`, the only option that also refuses a running server
 * (`-c features.daemon_auto_start=false` only stops a new one from starting). Older Codex
 * rejects the flag and refuses to start; any `-c` override already keeps those versions off a
 * running server, so they get the auto-start override. Codex itself is asked which applies.
 */
function daemonOptOutArguments(real, pathEntries) {
	try {
		childProcess.execFileSync(real.command, [...real.prefixArgs, '--no-daemon', '--version'], {
			env: childEnvironment(pathEntries, real.useOwnNode),
			timeout: DAEMON_PROBE_TIMEOUT_MS,
			stdio: 'ignore',
			windowsHide: true,
		});
		return ['--no-daemon'];
	} catch {
		return ['-c', 'features.daemon_auto_start=false'];
	}
}

/** Runs the user's Codex for an interactive session, kept off the shared background server. */
function runUnmanaged(real, pathEntries, args) {
	runDelegated(real, pathEntries, [...daemonOptOutArguments(real, pathEntries), ...args]);
}

function samePath(a, b) {
	const normalize = value => process.platform === 'win32'
		? path.resolve(value).toLowerCase().replace(/[\\/]+$/, '')
		: path.resolve(value).replace(/\/+$/, '');
	return normalize(a) === normalize(b);
}

/**
 * Mirrors the POSIX launcher's classification of an invocation.
 *
 * `delegated` runs the user's Codex unchanged; `tui` (a prompt, `resume`, `fork`, or a
 * positional argument the list does not know) is kept off the shared background server.
 */
function classifyInvocation(args) {
	let skipNext = false;
	let firstPositional;
	for (const argument of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (argument === '--remote' || argument.startsWith('--remote=')
			|| argument === '--help' || argument === '-h' || argument === '--version' || argument === '-V'
			// The user already chose: `--remote` attaches elsewhere, and `--no-daemon` is
			// rejected when given twice. Run it exactly as typed.
			|| argument === '--no-daemon') {
			return { kind: 'delegated' };
		}
		if (argument === '--') {
			// Codex treats everything after `--` as the prompt, never as a subcommand.
			break;
		}
		if (OPTIONS_WITH_VALUE.has(argument)) {
			skipNext = true;
			continue;
		}
		if (argument.startsWith('-')) {
			continue;
		}
		if (firstPositional === undefined) {
			firstPositional = argument;
		}
	}
	if (firstPositional === undefined || TUI_COMMANDS.has(firstPositional)) {
		return { kind: 'tui' };
	}
	return NON_INTERACTIVE_COMMANDS.has(firstPositional) ? { kind: 'delegated' } : { kind: 'tui' };
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
 *  2. an npm shim (`codex.cmd` / `codex.ps1` / `codex`): spawn the vendored native
 *     exe found under it, or run its `bin/codex.js` with our own Node runtime.
 *     The vendored exe comes first: codex.js selects its native package from
 *     `process.arch`, and our runtime (the Para Code executable) can have a
 *     different architecture than the npm-installed one (for example an arm64
 *     Para Code with an x64 Node on Windows ARM), which makes codex.js throw
 *     "Missing optional dependency" even though the installed exe runs fine.
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
		const vendored = findNativeCodexUnder(path.join(dir, 'node_modules', '@openai'));
		if (vendored !== undefined) {
			return { command: vendored, prefixArgs: [], useOwnNode: false };
		}
		const npmEntry = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
		if (fileExists(npmEntry)) {
			return { command: process.execPath, prefixArgs: [npmEntry], useOwnNode: true };
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
	if (process.env[MODE_ENV_VAR] === 'resolve') {
		// Only a directly runnable executable is useful to the script; anything that needs a Node
		// runtime would have to run under this GUI-subsystem executable again.
		if (real.prefixArgs.length > 0) {
			process.exit(1);
		}
		process.stdout.write(`${real.command}${os.EOL}`);
		return;
	}
	if (classifyInvocation(args).kind === 'delegated') {
		runDelegated(real, pathEntries, args);
		return;
	}
	runUnmanaged(real, pathEntries, args);
}

main();
