/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH comments)

// PARA-CODE: shared processだけが実行できるPara Browser MCP自動セットアップ境界。

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { constants as fsConstants, promises as fs, type Stats } from 'fs';
import { homedir } from 'os';
import { basename, dirname, extname, join } from '../../../../base/common/path.js';
import { findExecutable, killTree } from '../../../../base/node/processes.js';
import { paradisWrapWindowsScriptShim } from '../../../common/paradisWindowsScriptShim.js';
import { IParadisMcpCliConfigStatus, IParadisMcpConfigStatus, IParadisMcpSetupResult, PARADIS_PANE_TOKEN_ENV_VAR, ParadisMcpCli } from '../common/paradisAgentBrowser.js';
import { inspectParadisMcpTomlSection, paradisCodexMcpTableBody, paradisMcpServerUrl, paradisUpsertCodexMcpToml } from '../common/paradisMcpSetupEncoding.js';
import { computeParadisCodexTableRewrite, inspectParadisClaudeMcpJson, inspectParadisCodexMcpToml } from './paradisMcpConfigStatus.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
// ~/.claude.json は会話履歴などを含みうるため 1MiB を超えやすい。読むのはステータス判定のときだけで、
// 書き込みは `claude mcp add` に任せている（こちらでJSONを組み立て直さない）ので上限は緩く取る。
const MAX_CLAUDE_CONFIG_BYTES = 32 * 1024 * 1024;
const CODEX_CONFIG_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;
const CODEX_SETUP_ERROR = 'Automatic setup could not update the Codex configuration safely.';
const CLAUDE_SETUP_ERROR = 'Automatic setup could not register the MCP server.';

export type IParadisMcpSetupCommandResult =
	| { readonly kind: 'exit'; readonly code: number; readonly output: string }
	| { readonly kind: 'timeout' | 'failure' | 'unavailable'; readonly output: string };

interface ISpawnReadableLike {
	on(event: 'data', listener: (chunk: unknown) => void): unknown;
	removeListener(event: 'data', listener: (chunk: unknown) => void): unknown;
	destroy(): unknown;
}

interface ISpawnLike {
	readonly pid?: number;
	readonly stdout?: ISpawnReadableLike | null;
	readonly stderr?: ISpawnReadableLike | null;
	on(event: 'error', listener: (error: Error & { readonly code?: unknown }) => void): unknown;
	on(event: 'close', listener: (code: number | null, signal: unknown) => void): unknown;
	removeListener(event: 'error', listener: (error: Error & { readonly code?: unknown }) => void): unknown;
	removeListener(event: 'close', listener: (code: number | null, signal: unknown) => void): unknown;
	kill(signal?: NodeJS.Signals | number): boolean;
}

interface IRunCommandOptions {
	readonly platform?: NodeJS.Platform;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
	readonly terminationGraceMs?: number;
	readonly spawn?: (command: string, args: readonly string[], options: Readonly<Record<string, unknown>>) => ISpawnLike;
	readonly killProcessTree?: (pid: number, forceful: boolean) => Promise<void>;
}

function errorCode(error: unknown): unknown {
	return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
}

/** shellを介さず、出力と時間を上限化してプロセスツリーを実行する。 */
export function runParadisMcpSetupCommand(
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
	options: IRunCommandOptions = {},
): Promise<IParadisMcpSetupCommandResult> {
	const spawnProcess = options.spawn ?? ((executable, argv, spawnOptions) => spawn(executable, argv, spawnOptions));
	const platform = options.platform ?? process.platform;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
	const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
	const killProcessTree = options.killProcessTree ?? killTree;
	return new Promise(resolve => {
		let settled = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let forceTimer: ReturnType<typeof setTimeout> | undefined;
		let terminationStarted = false;
		let terminationFinished = false;
		const chunks: Buffer[] = [];
		let bytes = 0;
		const output = () => Buffer.concat(chunks, bytes).toString('utf8');
		const append = (chunk: unknown) => {
			if (settled || bytes >= maxOutputBytes) {
				return;
			}
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
			const accepted = buffer.subarray(0, Math.max(0, maxOutputBytes - bytes));
			if (accepted.length > 0) {
				chunks.push(accepted);
				bytes += accepted.length;
			}
		};
		const finish = (result: IParadisMcpSetupCommandResult): boolean => {
			if (settled) {
				return false;
			}
			settled = true;
			if (timeoutTimer !== undefined) {
				clearTimeout(timeoutTimer);
				timeoutTimer = undefined;
			}
			resolve(result);
			return true;
		};

		let child: ISpawnLike;
		const cleanupStreams = () => {
			child.stdout?.removeListener('data', append);
			child.stderr?.removeListener('data', append);
			child.stdout?.destroy();
			child.stderr?.destroy();
		};
		const cleanupListeners = () => {
			child.removeListener('error', onError);
			child.removeListener('close', onClose);
		};
		const cleanupAll = () => {
			if (timeoutTimer !== undefined) {
				clearTimeout(timeoutTimer);
				timeoutTimer = undefined;
			}
			if (forceTimer !== undefined) {
				clearTimeout(forceTimer);
				forceTimer = undefined;
			}
			cleanupListeners();
			cleanupStreams();
		};
		const fallbackSignal = (forceful: boolean) => {
			try {
				child.kill(forceful ? 'SIGKILL' : 'SIGTERM');
			} catch {
				// 終了済みまたはsignal非対応なら追加処理は不要。
			}
		};
		const requestTreeTermination = (forceful: boolean) => {
			if (child.pid === undefined) {
				fallbackSignal(forceful);
				return;
			}
			try {
				void killProcessTree(child.pid, forceful).catch(() => {
					if (forceful || (platform !== 'win32' && !terminationFinished)) {
						fallbackSignal(forceful);
					}
				});
			} catch {
				if (forceful || (platform !== 'win32' && !terminationFinished)) {
					fallbackSignal(forceful);
				}
			}
		};
		const completeTermination = () => {
			if (terminationFinished) {
				return;
			}
			terminationFinished = true;
			cleanupAll();
		};
		const beginTermination = () => {
			if (terminationStarted) {
				return;
			}
			terminationStarted = true;
			cleanupStreams();
			requestTreeTermination(false);
			if (terminationFinished) {
				return;
			}
			forceTimer = setTimeout(() => {
				forceTimer = undefined;
				requestTreeTermination(true);
				completeTermination();
			}, terminationGraceMs);
			(forceTimer as unknown as { unref?(): void }).unref?.();
		};
		function onError(error: Error & { readonly code?: unknown }): void {
			if (!finish({ kind: error.code === 'ENOENT' ? 'unavailable' : 'failure', output: output() })) {
				return;
			}
			if (child.pid === undefined) {
				cleanupAll();
			} else {
				beginTermination();
			}
		}
		function onClose(code: number | null): void {
			finish(code === null
				? { kind: 'failure', output: output() }
				: { kind: 'exit', code, output: output() });
			if (terminationStarted) {
				completeTermination();
			} else {
				cleanupAll();
			}
		}
		try {
			// Windows で解決先が .cmd/.bat シムのときは cmd.exe 経由にラップする
			// (shell 指定なしの spawn は CVE-2024-27980 対策後の Node では EINVAL になる)。
			const isWindows = platform === 'win32';
			const shimInvocation = isWindows ? paradisWrapWindowsScriptShim(command, args) : undefined;
			child = spawnProcess(shimInvocation?.file ?? command, shimInvocation?.args ?? args, {
				env,
				shell: false,
				windowsHide: true,
				windowsVerbatimArguments: shimInvocation !== undefined,
			});
		} catch (error) {
			finish({ kind: errorCode(error) === 'ENOENT' ? 'unavailable' : 'failure', output: '' });
			return;
		}
		child.stdout?.on('data', append);
		child.stderr?.on('data', append);
		child.on('error', onError);
		child.on('close', onClose);
		timeoutTimer = setTimeout(() => {
			if (finish({ kind: 'timeout', output: output() })) {
				beginTermination();
			}
		}, timeoutMs);
	});
}

export interface IParadisMcpSetupControllerOptions {
	readonly platform: NodeJS.Platform;
	readonly resolveShellEnv: () => Promise<NodeJS.ProcessEnv>;
	readonly findExecutable: (command: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
	readonly runCommand: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<IParadisMcpSetupCommandResult>;
	readonly codexHome: string;
	/** Claude Code のユーザースコープMCP設定ファイル（既定 `~/.claude.json`）の絶対パス。省略時は既定パス。 */
	readonly claudeConfigJsonPath?: string;
	readonly log: (message: string, error?: unknown) => void;
	readonly configReadFileSystem?: IConfigReadFileSystem;
}

interface IConfigReadFileSystem {
	lstat(path: string): Promise<Stats>;
	open(path: string, flags: number): ReturnType<typeof fs.open>;
	read(
		handle: Awaited<ReturnType<typeof fs.open>>,
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	): Promise<{ readonly bytesRead: number }>;
}

const defaultConfigReadFileSystem: IConfigReadFileSystem = {
	lstat: path => fs.lstat(path),
	open: (path, flags) => fs.open(path, flags),
	read: (handle, buffer, offset, length, position) => handle.read(buffer, offset, length, position),
};

interface IConfigSnapshot {
	readonly exists: boolean;
	readonly bytes: Buffer;
	readonly text: string;
	readonly mode?: number;
	readonly device?: number;
	readonly inode?: number;
	readonly size?: number;
	readonly modifiedAt?: number;
	readonly changedAt?: number;
}

function isFileNotFound(error: unknown): boolean {
	return errorCode(error) === 'ENOENT';
}

type IConfigFileStat = Stats;

function assertBoundedRegularConfig(stat: IConfigFileStat, maxBytes: number): void {
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error('Configuration is not a regular file');
	}
	if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
		throw new Error('Configuration exceeds the safe read limit');
	}
}

function sameConfigFileMetadata(left: IConfigFileStat, right: IConfigFileStat): boolean {
	return right.dev === left.dev
		&& right.ino === left.ino
		&& right.mode === left.mode
		&& right.size === left.size
		&& right.mtimeMs === left.mtimeMs
		&& right.ctimeMs === left.ctimeMs;
}

async function readConfigSnapshot(
	path: string,
	fileSystem: IConfigReadFileSystem = defaultConfigReadFileSystem,
	maxBytes: number = MAX_CODEX_CONFIG_BYTES,
): Promise<IConfigSnapshot> {
	let statBefore: IConfigFileStat | undefined;
	try {
		statBefore = await fileSystem.lstat(path);
	} catch (error) {
		if (isFileNotFound(error)) {
			return { exists: false, bytes: Buffer.alloc(0), text: '' };
		}
		throw error;
	}
	assertBoundedRegularConfig(statBefore, maxBytes);

	let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
	let bytes: Buffer;
	let stat: IConfigFileStat;
	try {
		opened = await fileSystem.open(path, CODEX_CONFIG_OPEN_FLAGS);
		const openedStat = await opened.stat();
		assertBoundedRegularConfig(openedStat, maxBytes);
		if (!sameConfigFileMetadata(statBefore, openedStat)) {
			throw new Error('Codex configuration changed before being read');
		}
		const boundedBuffer = Buffer.allocUnsafe(openedStat.size + 1);
		let totalBytesRead = 0;
		while (totalBytesRead < boundedBuffer.length) {
			const remaining = boundedBuffer.length - totalBytesRead;
			const result = await fileSystem.read(opened, boundedBuffer, totalBytesRead, remaining, totalBytesRead);
			if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > remaining) {
				throw new Error('Codex configuration read returned an invalid byte count');
			}
			if (result.bytesRead === 0) {
				break;
			}
			totalBytesRead += result.bytesRead;
		}
		const openedStatAfter = await opened.stat();
		stat = await fileSystem.lstat(path);
		assertBoundedRegularConfig(openedStatAfter, maxBytes);
		assertBoundedRegularConfig(stat, maxBytes);
		if (totalBytesRead !== openedStat.size
			|| !sameConfigFileMetadata(openedStat, openedStatAfter)
			|| !sameConfigFileMetadata(openedStatAfter, stat)) {
			throw new Error('Codex configuration changed while being read');
		}
		bytes = Buffer.from(boundedBuffer.subarray(0, totalBytesRead));
	} finally {
		await opened?.close().catch(() => undefined);
	}
	const text = bytes.toString('utf8');
	if (!Buffer.from(text, 'utf8').equals(bytes)) {
		throw new Error('Codex configuration is not valid UTF-8');
	}
	return {
		exists: true,
		bytes,
		text,
		mode: stat.mode & 0o777,
		device: stat.dev,
		inode: stat.ino,
		size: stat.size,
		modifiedAt: stat.mtimeMs,
		changedAt: stat.ctimeMs,
	};
}

function sameSnapshot(left: IConfigSnapshot, right: IConfigSnapshot): boolean {
	return left.exists === right.exists
		&& left.bytes.equals(right.bytes)
		&& left.mode === right.mode
		&& left.device === right.device
		&& left.inode === right.inode
		&& left.size === right.size
		&& left.modifiedAt === right.modifiedAt
		&& left.changedAt === right.changedAt;
}

async function writeConfigAtomic(
	path: string,
	original: IConfigSnapshot,
	content: string,
	fileSystem: IConfigReadFileSystem = defaultConfigReadFileSystem,
): Promise<void> {
	const directory = dirname(path);
	await fs.mkdir(directory, { recursive: true });
	const temporary = join(directory, `.${basename(path)}.paradis-${randomUUID()}.tmp`);
	let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		opened = await fs.open(temporary, 'wx', original.mode ?? 0o600);
		if (original.mode !== undefined) {
			await opened.chmod(original.mode);
		}
		await opened.writeFile(content, 'utf8');
		await opened.sync();
		await opened.close();
		opened = undefined;
		const current = await readConfigSnapshot(path, fileSystem);
		if (!sameSnapshot(original, current)) {
			throw new Error('Codex configuration changed during setup');
		}
		await fs.rename(temporary, path);
	} finally {
		if (opened !== undefined) {
			await opened.close().catch(() => undefined);
		}
		await fs.unlink(temporary).catch(error => {
			if (!isFileNotFound(error)) {
				throw error;
			}
		});
	}
}

export class ParadisMcpSetupController {
	private readonly flights = new Map<ParadisMcpCli, Promise<IParadisMcpSetupResult>>();

	constructor(private readonly options: IParadisMcpSetupControllerOptions) { }

	setup(cli: ParadisMcpCli, gatewayPort: number | undefined): Promise<IParadisMcpSetupResult> {
		const existing = this.flights.get(cli);
		if (existing !== undefined) {
			return existing;
		}
		const flight = (cli === 'claude' ? this.setupClaude(gatewayPort) : this.setupCodex(gatewayPort)).finally(() => {
			if (this.flights.get(cli) === flight) {
				this.flights.delete(cli);
			}
		});
		this.flights.set(cli, flight);
		return flight;
	}

	/** 「MCP接続設定」タブ表示用の、Claude Code / Codex 双方のMCP設定ステータスを判定する。 */
	async status(gatewayPort: number | undefined): Promise<IParadisMcpConfigStatus> {
		const [claude, codex] = await Promise.all([
			this.statusClaude(gatewayPort),
			this.statusCodex(gatewayPort),
		]);
		return { claude, codex, ...(gatewayPort !== undefined ? { gatewayPort } : {}) };
	}

	private async statusClaude(gatewayPort: number | undefined): Promise<IParadisMcpCliConfigStatus> {
		const claudeConfigJsonPath = this.options.claudeConfigJsonPath ?? join(homedir(), '.claude.json');
		try {
			const snapshot = await readConfigSnapshot(claudeConfigJsonPath, this.options.configReadFileSystem, MAX_CLAUDE_CONFIG_BYTES);
			if (!snapshot.exists) {
				return { cli: 'claude', state: 'unconfigured' };
			}
			const state = inspectParadisClaudeMcpJson(snapshot.text, gatewayPort);
			return {
				cli: 'claude',
				state,
				...(state === 'configured' ? { configPath: claudeConfigJsonPath } : {}),
			};
		} catch {
			this.options.log('Claude MCP status read failed');
			return { cli: 'claude', state: 'unconfigured', failed: true };
		}
	}

	private async statusCodex(gatewayPort: number | undefined): Promise<IParadisMcpCliConfigStatus> {
		const configPath = join(this.options.codexHome, 'config.toml');
		try {
			const snapshot = await readConfigSnapshot(configPath, this.options.configReadFileSystem);
			if (!snapshot.exists) {
				return { cli: 'codex', state: 'unconfigured' };
			}
			const inspection = inspectParadisCodexMcpToml(snapshot.text, gatewayPort);
			// 自動セットアップ（setupCodex）は para-browser テーブルを末尾に追記するが、既に別の
			// mcp_servers テーブルがある等で inspectParadisMcpTomlSection が 'absent' 以外なら
			// throw して失敗する。その場合は「押すと必ず失敗するボタン」を出さず手動導線へ誘導する。
			const manualOnly = inspection.state === 'unconfigured'
				&& inspectParadisMcpTomlSection(snapshot.text) !== 'absent';
			return {
				cli: 'codex',
				state: inspection.state,
				...(inspection.detectedPort !== undefined ? { detectedPort: inspection.detectedPort } : {}),
				...(inspection.state === 'configured' ? { configPath } : {}),
				...(manualOnly ? { manualOnly: true } : {}),
			};
		} catch {
			this.options.log('Codex MCP status read failed');
			return { cli: 'codex', state: 'unconfigured', failed: true };
		}
	}

	/**
	 * 「ワンクリックで修正」/「自動セットアップ」。claude は setup と等価。codex は要修正エントリを
	 * shim方式へ書き換え、未設定なら para-browser テーブルを追記する。
	 */
	fix(cli: ParadisMcpCli, gatewayPort: number | undefined): Promise<IParadisMcpSetupResult> {
		if (cli === 'claude') {
			return this.setup('claude', gatewayPort);
		}
		return this.fixCodex(gatewayPort);
	}

	private async fixCodex(gatewayPort: number | undefined): Promise<IParadisMcpSetupResult> {
		const configPath = join(this.options.codexHome, 'config.toml');
		try {
			const original = await readConfigSnapshot(configPath, this.options.configReadFileSystem);
			if (!original.exists || gatewayPort === undefined) {
				return this.setupCodex(gatewayPort);
			}
			const inspection = inspectParadisCodexMcpToml(original.text, gatewayPort);
			if (inspection.state === 'configured') {
				return { cli: 'codex', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'already' }] };
			}
			// 古いポートを指しているのが私たち以外の名前（chrome-devtools 等）の場合は、その節を
			// HTTP方式へ書き換える。私たちの名前なら setupCodex 側の節ごと差し替えで直る。
			if (inspection.state === 'needsFix' && inspection.staleServerName !== undefined && inspection.staleServerName !== 'para-browser') {
				const rewritten = computeParadisCodexTableRewrite(
					original.text,
					inspection.staleServerName,
					paradisCodexMcpTableBody(gatewayPort),
				);
				if (rewritten === undefined || rewritten === original.text) {
					throw new Error('Ambiguous Codex MCP rewrite target');
				}
				await writeConfigAtomic(configPath, original, rewritten, this.options.configReadFileSystem);
				return { cli: 'codex', cliAvailable: true, target: configPath, servers: [{ server: inspection.staleServerName, outcome: 'success' }] };
			}
			return this.setupCodex(gatewayPort);
		} catch {
			this.options.log('Codex MCP configuration fix failed');
			return { cli: 'codex', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'error', detail: CODEX_SETUP_ERROR }] };
		}
	}

	/**
	 * Claude Code へ para-browser を HTTP の MCP サーバーとして登録する。
	 *
	 * `~/.claude.json` は会話履歴まで抱えて数十MiBになりうるので、こちらでは読み書きしない
	 * （JSONを丸ごと組み立て直すのは、直したい1エントリに対して代償が大きすぎる）。書き込みは
	 * `claude mcp add` に任せる。
	 *
	 * ヘッダーの値は `${…}` のまま渡す。展開するのは Claude Code 自身で、そうすることで
	 * ペインごとに違うトークンを設定ファイルへ焼き込まずに済む。引数は配列のまま渡しており
	 * シェルを経由しないので、ここで展開されることはない。
	 */
	private async setupClaude(gatewayPort: number | undefined): Promise<IParadisMcpSetupResult> {
		if (gatewayPort === undefined) {
			return { cli: 'claude', cliAvailable: true, servers: [{ server: 'para-browser', outcome: 'error', detail: CLAUDE_SETUP_ERROR }] };
		}
		let env: NodeJS.ProcessEnv;
		let executable: string | undefined;
		try {
			env = await this.options.resolveShellEnv();
			executable = await this.options.findExecutable('claude', env);
		} catch {
			this.options.log('Claude MCP executable resolution failed');
			return { cli: 'claude', cliAvailable: false, servers: [] };
		}
		// Windows の npm 版 Claude Code は claude.cmd シム。runParadisMcpSetupCommand 側が
		// cmd.exe 経由へ安全にラップするため、.cmd/.bat も許可する(.exe/.com は従来どおり直接実行)。
		if (executable === undefined || (this.options.platform === 'win32' && !/\.(?:exe|com|cmd|bat)$/i.test(extname(executable)))) {
			return { cli: 'claude', cliAvailable: false, servers: [] };
		}
		const addArguments = [
			'mcp', 'add', '-s', 'user', '--transport', 'http', 'para-browser', paradisMcpServerUrl(gatewayPort),
			'--header', `Authorization: Bearer \${${PARADIS_PANE_TOKEN_ENV_VAR}}`,
		];
		let result: IParadisMcpSetupCommandResult;
		try {
			result = await this.options.runCommand(executable, addArguments, env);
			// `mcp add` に上書きは無い。既にあるのは旧shim方式か古いポートを指した登録なので、
			// 消してから入れ直す（同じ名前の私たちのエントリだけが対象）。
			if (result.kind === 'exit' && result.code !== 0 && result.output.toLowerCase().includes('already exists')) {
				await this.options.runCommand(executable, ['mcp', 'remove', '-s', 'user', 'para-browser'], env);
				result = await this.options.runCommand(executable, addArguments, env);
			}
		} catch {
			this.options.log('Claude MCP runner failed');
			return { cli: 'claude', cliAvailable: true, servers: [{ server: 'para-browser', outcome: 'error', detail: CLAUDE_SETUP_ERROR }] };
		}
		if (result.kind === 'unavailable') {
			return { cli: 'claude', cliAvailable: false, servers: [] };
		}
		if (result.kind === 'exit' && result.code === 0) {
			return { cli: 'claude', cliAvailable: true, servers: [{ server: 'para-browser', outcome: 'success' }] };
		}
		this.options.log('Claude MCP registration failed');
		return { cli: 'claude', cliAvailable: true, servers: [{ server: 'para-browser', outcome: 'error', detail: CLAUDE_SETUP_ERROR }] };
	}

	/**
	 * Codex へ para-browser を HTTP の MCP サーバーとして登録する。
	 *
	 * 私たちの節は毎回書き直す（`paradisUpsertCodexMcpToml`）。旧shim方式の絶対パスや古いポートを
	 * 指した節が残っていても、中身を読んで直すより丸ごと入れ替える方が確実。
	 */
	private async setupCodex(gatewayPort: number | undefined): Promise<IParadisMcpSetupResult> {
		const configPath = join(this.options.codexHome, 'config.toml');
		if (gatewayPort === undefined) {
			return { cli: 'codex', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'error', detail: CODEX_SETUP_ERROR }] };
		}
		try {
			const original = await readConfigSnapshot(configPath, this.options.configReadFileSystem);
			// 節ごと差し替えるので 'present' でも進む。曖昧な構文のときだけ手を出さない。
			if (inspectParadisMcpTomlSection(original.text) === 'ambiguous') {
				throw new Error('Ambiguous Codex MCP configuration');
			}
			const content = paradisUpsertCodexMcpToml(original.text, gatewayPort);
			if (content === original.text) {
				return { cli: 'codex', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'already' }] };
			}
			await writeConfigAtomic(configPath, original, content, this.options.configReadFileSystem);
			return { cli: 'codex', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'success' }] };
		} catch {
			this.options.log('Codex MCP configuration update failed');
			return { cli: 'codex', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'error', detail: CODEX_SETUP_ERROR }] };
		}
	}
}

export function createParadisMcpSetupController(
	resolveShellEnv: () => Promise<NodeJS.ProcessEnv>,
	codexHome: string,
	log: (message: string, error?: unknown) => void,
): ParadisMcpSetupController {
	return new ParadisMcpSetupController({
		platform: process.platform,
		resolveShellEnv,
		findExecutable: (command, env) => findExecutable(command, undefined, undefined, env),
		runCommand: runParadisMcpSetupCommand,
		codexHome,
		// `claude mcp add -s user` はユーザースコープを `~/.claude.json` に書き込む（CLAUDE_CONFIG_DIR ではない）。
		claudeConfigJsonPath: join(homedir(), '.claude.json'),
		log,
	});
}
