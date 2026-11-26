/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH comments)

// PARA-CODE: shared processだけが実行できるPara Browser MCP自動セットアップ境界。

import { spawn } from 'child_process';
import { constants as fsConstants, promises as fs, type Stats } from 'fs';
import { homedir } from 'os';
import { dirname, extname, isAbsolute, join } from '../../../../base/common/path.js';
import { FileAccess } from '../../../../base/common/network.js';
import { findExecutable, killTree } from '../../../../base/node/processes.js';
import { paradisWrapWindowsScriptShim } from '../../../common/paradisWindowsScriptShim.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import { paradisWriteRollingBackup } from '../../../node/paradisRollingFileBackup.js';
import { IParadisMcpCliConfigStatus, IParadisMcpConfigStatus, IParadisMcpSetupResult, PARADIS_PANE_TOKEN_ENV_VAR, ParadisMcpCli } from '../common/paradisAgentBrowser.js';
import { IParadisAntigravityMcpServerEntry, IParadisMcpStdioBridgeLocation, inspectParadisMcpTomlSection, paradisAntigravityMcpServerEntry, paradisClaudeMcpServerEntry, paradisCodexMcpTableBody, paradisMcpServerUrl, paradisUpsertAntigravityMcpJson, paradisUpsertCodexMcpToml } from '../common/paradisMcpSetupEncoding.js';
import { PARADIS_ASK_HUMAN_TOOL } from '../../humanAsk/common/paradisAskHumanTool.js';
import { computeParadisCodexTableRewrite, inspectParadisAntigravityMcpJson, inspectParadisClaudeMcpJson, inspectParadisCodexMcpToml, paradisAddCodexMissingTableLines, paradisAddCodexToolApproval, paradisAntigravityMcpEntryToRelocate, paradisClaudeMcpEntryNeedsToolTimeout, paradisReadClaudeMcpEntry } from './paradisMcpConfigStatus.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
// ~/.claude.json は会話履歴などを含みうるため 1MiB を超えやすい。読むのはステータス判定のときだけで、
// 書き込みは `claude mcp add` に任せている（こちらでJSONを組み立て直さない）ので上限は緩く取る。
const MAX_CLAUDE_CONFIG_BYTES = 32 * 1024 * 1024;
const CODEX_CONFIG_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;
const CODEX_SETUP_ERROR = 'Automatic setup could not update the Codex configuration safely.';
/** 読んでから書くまでに config.toml が変わったとき、読み直して試す回数（最初の 1 回を含む）。 */
const CODEX_CONFIG_CHANGED_ATTEMPTS = 2;
const CLAUDE_SETUP_ERROR = 'Automatic setup could not register the MCP server.';
const ANTIGRAVITY_SETUP_ERROR = 'Automatic setup could not update the Antigravity CLI configuration safely.';

export type IParadisMcpSetupCommandResult =
	| { readonly kind: 'exit'; readonly code: number; readonly output: string }
	| { readonly kind: 'timeout' | 'failure' | 'unavailable'; readonly output: string };

/** 上限を足す入れ直しを試した印の数の上限（設定ファイルとポートの組ごとに 1 つ）。 */
const MAX_UPGRADE_MARKERS = 64;

function commandSucceeded(result: IParadisMcpSetupCommandResult): boolean {
	return result.kind === 'exit' && result.code === 0;
}

function commandAlreadyExists(result: IParadisMcpSetupCommandResult): boolean {
	return result.kind === 'exit' && result.code !== 0 && result.output.toLowerCase().includes('already exists');
}

/** `CLAUDE_CONFIG_DIR` が絶対パスでなく、どの `.claude.json` か決められない。 */
class ParadisClaudeConfigPathError extends Error {
	constructor() {
		super('CLAUDE_CONFIG_DIR is not an absolute path');
	}
}

/**
 * 控えを読めずに入れ直しをやめたときに見せる文。理由は決まった言い方（エラーコードか、こちらで投げた
 * 決まった文）だけを載せ、読んだ中身や例外の生の文は載せない。
 */
function claudeBackupReadFailureDetail(configPath: string | undefined, error: unknown): string {
	const code = errorCode(error);
	const knownMessages = [
		'Configuration is not a regular file',
		'Configuration exceeds the safe read limit',
		'Codex configuration is not valid UTF-8',
		'CLAUDE_CONFIG_DIR is not an absolute path',
	];
	const message = error instanceof Error ? error.message : undefined;
	const reason = typeof code === 'string' && /^E[A-Z]+$/.test(code)
		? code
		: message !== undefined && (knownMessages.includes(message) || message.endsWith('changed while being read') || message.endsWith('changed before being read'))
			? message.replace(/^Codex configuration/, 'The file')
			: 'unknown error';
	return `${CLAUDE_SETUP_ERROR} The existing para-browser entry${configPath !== undefined ? ` in ${configPath}` : ''} could not be read to keep a copy before replacing it (${reason}), so it was left as it is.`;
}

/** Claude Code のエントリの `headers.Authorization`（旧形式の `mcp add` で戻すときに使う）。 */
function claudeEntryAuthorization(entry: Record<string, unknown>): string | undefined {
	const headers = entry.headers;
	if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
		return undefined;
	}
	const authorization = (headers as Record<string, unknown>).Authorization;
	return typeof authorization === 'string' ? authorization : undefined;
}

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

/**
 * Codex の設定を読み書きできなかった理由の種類。Sentry へは理由の種類だけを送る（パスや中身は送らない）。
 * 下の {@link ParadisCodexConfigError} が持つ種類のほかに、Node の errno から作る `read-<code>`・`write-<code>` がある。
 */
type ParadisCodexConfigFailureKind = 'symlink' | 'not-regular-file' | 'too-large' | 'invalid-read' | 'not-utf8' | 'changed' | 'ambiguous';

/** 理由の種類を持たせた、設定の読み書きの失敗。 */
class ParadisCodexConfigError extends Error {
	constructor(readonly kind: ParadisCodexConfigFailureKind, message: string) {
		super(message);
	}
}

/** 失敗の理由の種類（Sentry の `safe_failure_kind` に載せる）。errno は形を確かめたものだけを使う。 */
function codexConfigFailureKind(stage: 'read' | 'write', error: unknown): string {
	if (error instanceof ParadisCodexConfigError) {
		return error.kind;
	}
	const code = errorCode(error);
	return `${stage}-${typeof code === 'string' && /^E[A-Z0-9]{1,30}$/.test(code) ? code : 'other'}`;
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
	// killTree's diagnostics for an already exited root are not needed here
	const killProcessTree = options.killProcessTree ?? ((pid: number, forceful: boolean) => killTree(pid, forceful, () => { }));
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
	/**
	 * 同じ設定を入れておく他の Codex ホーム（アカウントごとの ~/.codex-2 等）。切り替えた先の
	 * Codex からも para-browser が見えるようにするため。状態表示は {@link codexHome} だけで判断する。
	 */
	readonly additionalCodexHomes?: () => readonly string[];
	/**
	 * Claude Code のユーザースコープMCP設定ファイルの絶対パス。省略時はシェルの環境の `CLAUDE_CONFIG_DIR`
	 * があればその下の `.claude.json`、無ければ `~/.claude.json`（`claude mcp add-json -s user` が書く先と同じ）。
	 */
	readonly claudeConfigJsonPath?: string;
	/**
	 * ツール呼び出しの上限を足す入れ直し（{@link ParadisMcpSetupController.upgradeToolTimeouts}）を、どの設定ファイルと
	 * ポートで試したかを残すファイル。試したものは次の起動から試さない。省略時は毎回試す（テスト用）。
	 */
	readonly upgradeMarkerPath?: string;
	/** `safeExtra` は Sentry へ送ってよい値だけ（理由の種類など。パスや設定の中身は入れない）。 */
	readonly log: (message: string, error?: unknown, safeExtra?: Readonly<Record<string, string | number>>) => void;
	readonly configReadFileSystem?: IConfigReadFileSystem;
	/**
	 * Antigravity CLI へ渡す stdio の橋渡し（Para Code 本体とシムの場所）。無ければ Antigravity CLI は扱わない
	 * （状態にも載せない）。
	 */
	readonly resolveMcpBridge?: () => IParadisMcpStdioBridgeLocation | undefined;
	/** Antigravity CLI の全体の設定のフォルダ。省略時は `~/.gemini/config`。 */
	readonly antigravityConfigDir?: string;
	/** フォルダがあるか（Antigravity CLI の設定のフォルダを見る）。省略時は `fs.stat`。 */
	readonly isDirectory?: (path: string) => Promise<boolean>;
	/** パスが残っているか（前に書いた橋渡しの場所を見る）。省略時は `fs.stat`。 */
	readonly pathExists?: (path: string) => Promise<boolean>;
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
		throw new ParadisCodexConfigError(stat.isSymbolicLink() ? 'symlink' : 'not-regular-file', 'Configuration is not a regular file');
	}
	if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
		throw new ParadisCodexConfigError('too-large', 'Configuration exceeds the safe read limit');
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
			throw new ParadisCodexConfigError('changed', 'Codex configuration changed before being read');
		}
		const boundedBuffer = Buffer.allocUnsafe(openedStat.size + 1);
		let totalBytesRead = 0;
		while (totalBytesRead < boundedBuffer.length) {
			const remaining = boundedBuffer.length - totalBytesRead;
			const result = await fileSystem.read(opened, boundedBuffer, totalBytesRead, remaining, totalBytesRead);
			if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > remaining) {
				throw new ParadisCodexConfigError('invalid-read', 'Codex configuration read returned an invalid byte count');
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
			throw new ParadisCodexConfigError('changed', 'Codex configuration changed while being read');
		}
		bytes = Buffer.from(boundedBuffer.subarray(0, totalBytesRead));
	} finally {
		await opened?.close().catch(() => undefined);
	}
	const text = bytes.toString('utf8');
	if (!Buffer.from(text, 'utf8').equals(bytes)) {
		throw new ParadisCodexConfigError('not-utf8', 'Codex configuration is not valid UTF-8');
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

/**
 * 設定を原子的に書き換える。書く直前に元のファイルが読んだときのままか確かめ、変わっていたら
 * 置き換えずに失敗させる（利用者や CLI の変更を上書きしない）。置き換えられないときもその場へは
 * 書かずに失敗させる。
 */
async function writeConfigAtomic(
	path: string,
	original: IConfigSnapshot,
	content: string,
	fileSystem: IConfigReadFileSystem = defaultConfigReadFileSystem,
): Promise<void> {
	// 利用者の設定なので、書き換える前の中身を1つだけ隣へ控える。控えは保険なので、写せなくても止めない。
	if (original.exists) {
		await paradisWriteRollingBackup(path).catch(() => false);
	}
	await paradisWriteFileAtomic(path, content, {
		newFileMode: original.mode ?? 0o600,
		createParentMode: 0o777,
		fallbackToInPlace: false,
		beforeReplace: async () => {
			const current = await readConfigSnapshot(path, fileSystem);
			if (!sameSnapshot(original, current)) {
				throw new ParadisCodexConfigError('changed', 'Codex configuration changed during setup');
			}
		},
	});
}

export class ParadisMcpSetupController {
	private readonly flights = new Map<ParadisMcpCli, Promise<IParadisMcpSetupResult>>();
	/** {@link flights} のうち、起動時の入れ直し（{@link upgradeToolTimeouts}）のもの。 */
	private readonly upgradeFlights = new WeakSet<Promise<IParadisMcpSetupResult>>();
	/** 知らせ済みの、切り替え先のホームの失敗（設定ファイルと理由の種類の組）。 */
	private readonly reportedAdditionalHomeFailures = new Set<string>();

	constructor(private readonly options: IParadisMcpSetupControllerOptions) { }

	setup(cli: ParadisMcpCli, gatewayPort: number | undefined): Promise<IParadisMcpSetupResult> {
		const existing = this.flights.get(cli);
		if (existing !== undefined && this.upgradeFlights.has(existing)) {
			// 起動時の入れ直し（旧形式の `mcp add` には戻さない）に合流した。それが失敗だったら、ボタンとして
			// （旧形式にも戻してよい形で）もう 1 回実行する。
			return existing.then(result => result.servers.some(server => server.outcome === 'success') ? result : this.setup(cli, gatewayPort));
		}
		if (existing !== undefined) {
			return existing;
		}
		const run = (): Promise<IParadisMcpSetupResult> => {
			switch (cli) {
				case 'claude': return this.setupClaude(gatewayPort, { allowLegacyAdd: true });
				case 'codex': return this.withCodexPropagation(this.setupCodex(gatewayPort), gatewayPort);
				case 'antigravity': return this.setupAntigravity('button');
			}
		};
		const flight = run().finally(() => {
			if (this.flights.get(cli) === flight) {
				this.flights.delete(cli);
			}
		});
		this.flights.set(cli, flight);
		return flight;
	}

	/** 「MCP接続設定」タブ表示用の、Claude Code / Codex /（使っていれば）Antigravity CLI のMCP設定ステータスを判定する。 */
	async status(gatewayPort: number | undefined): Promise<IParadisMcpConfigStatus> {
		const [claude, codex, antigravity] = await Promise.all([
			this.statusClaude(gatewayPort),
			this.statusCodex(gatewayPort),
			this.statusAntigravity(),
		]);
		return { claude, codex, ...(antigravity !== undefined ? { antigravity } : {}), ...(gatewayPort !== undefined ? { gatewayPort } : {}) };
	}

	/** Antigravity CLI の全体の設定のフォルダ（`~/.gemini/config`）。 */
	private antigravityConfigDir(): string {
		return this.options.antigravityConfigDir ?? join(homedir(), '.gemini', 'config');
	}

	private async isDirectory(path: string): Promise<boolean> {
		if (this.options.isDirectory !== undefined) {
			return this.options.isDirectory(path);
		}
		try {
			return (await fs.stat(path)).isDirectory();
		} catch {
			return false;
		}
	}

	/**
	 * Antigravity CLI の状態。agy が設定のフォルダを作っていない（agy を使っていない）ときは undefined にして
	 * カードを出さない（使っていない人に「未設定」の印を増やさない。hook を置く規則と同じ）。
	 */
	private async statusAntigravity(): Promise<IParadisMcpCliConfigStatus | undefined> {
		const bridge = this.options.resolveMcpBridge?.();
		const configDir = this.antigravityConfigDir();
		if (bridge === undefined || !await this.isDirectory(configDir)) {
			return undefined;
		}
		const configPath = join(configDir, 'mcp_config.json');
		try {
			const snapshot = await readConfigSnapshot(configPath, this.options.configReadFileSystem);
			if (!snapshot.exists) {
				return { cli: 'antigravity', state: 'unconfigured' };
			}
			const inspection = inspectParadisAntigravityMcpJson(snapshot.text, paradisAntigravityMcpServerEntry(bridge, this.options.platform));
			return {
				cli: 'antigravity',
				state: inspection.state,
				...(inspection.state === 'configured' ? { configPath } : {}),
				...(inspection.manualOnly ? { manualOnly: true } : {}),
			};
		} catch {
			this.options.log('Antigravity CLI MCP status read failed');
			return { cli: 'antigravity', state: 'unconfigured', failed: true };
		}
	}

	private async statusClaude(gatewayPort: number | undefined): Promise<IParadisMcpCliConfigStatus> {
		let claudeConfigJsonPath = '';
		try {
			const resolvedPath = await this.claudeConfigJsonPath();
			if (resolvedPath === undefined) {
				// CLAUDE_CONFIG_DIR が絶対パスでない。どのファイルか決められないので、判定できなかった扱いにする。
				return { cli: 'claude', state: 'unconfigured', failed: true };
			}
			claudeConfigJsonPath = resolvedPath;
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
			// 自動セットアップ（setupCodex）は para-browser テーブルを末尾に追記するが、`[mcp_servers]` そのものや
			// ドットのキーで書かれている等で inspectParadisMcpTomlSection が 'absent' 以外なら
			// throw して失敗する。その場合は「押すと必ず失敗するボタン」を出さず手動導線へ誘導する。
			// ほかの名前の `[mcp_servers.<名前>]` の節だけなら 'absent' なので、自動セットアップできる。
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
	 * HTTP方式の節へ書き換え、未設定なら para-browser テーブルを追記する。
	 */
	fix(cli: ParadisMcpCli, gatewayPort: number | undefined): Promise<IParadisMcpSetupResult> {
		switch (cli) {
			case 'claude': return this.setup('claude', gatewayPort);
			// 直すのは para-browser の節を橋渡しへ置き換えることなので、セットアップと同じ
			case 'antigravity': return this.setup('antigravity', gatewayPort);
			case 'codex': return this.withCodexPropagation(this.fixCodex(gatewayPort), gatewayPort);
		}
	}

	/**
	 * Codex のホームが増えた（アカウントの追加・ログイン、設定で足した）ときに呼ぶ。既定のホームに
	 * para-browser の設定が入っている（利用者が一度セットアップした）ときだけ、同じ節を他のアカウント用
	 * ホームへ入れる。既定のホームが未設定なら何もしない（セットアップしていない人の設定は書かない）。
	 */
	async propagateToCodexHomes(gatewayPort: number | undefined): Promise<void> {
		if (gatewayPort === undefined || this.flights.has('codex')) {
			return;
		}
		try {
			const original = await readConfigSnapshot(join(this.options.codexHome, 'config.toml'), this.options.configReadFileSystem);
			if (!original.exists || inspectParadisCodexMcpToml(original.text, gatewayPort).state !== 'configured') {
				return;
			}
		} catch {
			return;
		}
		await this.propagateCodexSetup(gatewayPort);
	}

	/**
	 * `claude mcp add-json -s user` が書く設定ファイル。明示されていなければシェルの環境の `CLAUDE_CONFIG_DIR`
	 * に従う（状態表示・入れ直し・登録が同じファイルを見るように）。
	 */
	private async claudeConfigJsonPath(env?: NodeJS.ProcessEnv): Promise<string | undefined> {
		if (this.options.claudeConfigJsonPath !== undefined) {
			return this.options.claudeConfigJsonPath;
		}
		let configDir: string | undefined;
		try {
			configDir = (env ?? await this.options.resolveShellEnv()).CLAUDE_CONFIG_DIR;
		} catch {
			configDir = undefined;
		}
		if (configDir === undefined || configDir.length === 0) {
			return join(homedir(), '.claude.json');
		}
		// 相対パス（`~` を含む）は claude を起動した場所しだいで指す先が変わる。こちらでは読まない
		// （`~` も展開しない）: 状態は「分からない」にし、入れ直しもしない。
		return isAbsolute(configDir) ? join(configDir, '.claude.json') : undefined;
	}

	/**
	 * 利用者がセットアップ済みの私たちの登録（今のポートを指したもの）に、ツール呼び出しの上限（Codex は
	 * 並行の呼び出しの許可も）が無ければ入れ直す。上限を足す前に登録した人の分を直すため。未設定の人の設定は書かない。同じ設定ファイルと
	 * ポートの組は、成否にかかわらず 1 回しか試さない（印は {@link IParadisMcpSetupControllerOptions.upgradeMarkerPath}）。
	 */
	async upgradeToolTimeouts(gatewayPort: number | undefined): Promise<void> {
		// Antigravity CLI の橋渡しはポートを書かないので、ポートに関係なく場所だけ直す
		// （ここで投げても Claude・Codex の入れ直しは続ける）
		try {
			await this.relocateAntigravityBridge();
		} catch {
			this.options.log('Antigravity CLI MCP bridge relocation failed');
		}
		if (gatewayPort === undefined) {
			return;
		}
		const tried = await this.readUpgradeMarker();
		const attempt = async (key: string, run: () => Promise<void>) => {
			if (tried.includes(key)) {
				return;
			}
			// 試す前に印を残す（途中で落ちても、次の起動で同じことを繰り返さない）。
			tried.push(key);
			await this.writeUpgradeMarker(tried);
			await run();
		};
		try {
			const claudeConfigJsonPath = await this.claudeConfigJsonPath();
			const snapshot = claudeConfigJsonPath === undefined ? undefined : await readConfigSnapshot(claudeConfigJsonPath, this.options.configReadFileSystem, MAX_CLAUDE_CONFIG_BYTES);
			if (snapshot?.exists && paradisClaudeMcpEntryNeedsToolTimeout(snapshot.text, gatewayPort) && !this.flights.has('claude')) {
				await attempt(`claude:${claudeConfigJsonPath}:${gatewayPort}`, async () => {
					// 利用者のボタン操作と交差しないよう、同じ flights に載せる（載っていれば今回は見送る）。
					if (this.flights.has('claude')) {
						return;
					}
					// timeout を付けられない古い CLI では旧形式に戻さず、今の登録をそのまま残す。
					const flight = this.setupClaude(gatewayPort, { allowLegacyAdd: false }).finally(() => {
						if (this.flights.get('claude') === flight) {
							this.flights.delete('claude');
						}
					});
					this.flights.set('claude', flight);
					this.upgradeFlights.add(flight);
					const result = await flight;
					if (!result.servers.some(server => server.outcome === 'success')) {
						this.options.log('Claude MCP tool timeout upgrade failed');
					}
				});
			}
		} catch {
			this.options.log('Claude MCP tool timeout upgrade failed');
		}
		const homes = [this.options.codexHome, ...(this.options.additionalCodexHomes?.() ?? []).filter(home => home !== this.options.codexHome)];
		for (const codexHome of homes) {
			try {
				const configPath = join(codexHome, 'config.toml');
				const original = await readConfigSnapshot(configPath, this.options.configReadFileSystem);
				// 節を丸ごと書き直さず、無い行（`tool_timeout_sec`・`supports_parallel_tool_calls`）だけを足す
				// （利用者が足した行を消さない）。`supports_parallel_tool_calls` は後の版で足したので印を分け、
				// `tool_timeout_sec` の入れ直しを試した人にも 1 回だけ入れる。
				const added = original.exists ? paradisAddCodexMissingTableLines(original.text, gatewayPort) : undefined;
				if (added !== undefined) {
					const markerSuffix = added.keys.includes('supports_parallel_tool_calls') ? ':supports_parallel_tool_calls' : '';
					await attempt(`codex:${configPath}:${gatewayPort}${markerSuffix}`, () => writeConfigAtomic(configPath, original, added.text, this.options.configReadFileSystem));
				}
			} catch {
				this.options.log('Codex MCP tool timeout upgrade failed');
			}
			try {
				// セットアップ済みの人に、人に聞く道具の許可を 1 回だけ足す（後で利用者が消したら足し直さない）
				const configPath = join(codexHome, 'config.toml');
				const snapshot = await readConfigSnapshot(configPath, this.options.configReadFileSystem);
				const approved = snapshot.exists ? paradisAddCodexToolApproval(snapshot.text, gatewayPort, PARADIS_ASK_HUMAN_TOOL) : undefined;
				if (approved !== undefined) {
					await attempt(`codex:${configPath}:approve:${PARADIS_ASK_HUMAN_TOOL}`, () => writeConfigAtomic(configPath, snapshot, approved, this.options.configReadFileSystem));
				}
			} catch {
				this.options.log('Codex MCP tool approval upgrade failed');
			}
		}
	}

	private async readUpgradeMarker(): Promise<string[]> {
		if (this.options.upgradeMarkerPath === undefined) {
			return [];
		}
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(this.options.upgradeMarkerPath, 'utf8'));
			return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(-MAX_UPGRADE_MARKERS) : [];
		} catch {
			return [];
		}
	}

	private async writeUpgradeMarker(tried: readonly string[]): Promise<void> {
		if (this.options.upgradeMarkerPath === undefined) {
			return;
		}
		try {
			await fs.writeFile(this.options.upgradeMarkerPath, JSON.stringify(tried.slice(-MAX_UPGRADE_MARKERS)), { mode: 0o600 });
		} catch {
			this.options.log('MCP tool timeout upgrade marker write failed');
		}
	}

	/** 既定のホームの結果をそのまま返しつつ、最後に1回だけ他のアカウント用ホームへ反映する。 */
	private async withCodexPropagation(primary: Promise<IParadisMcpSetupResult>, gatewayPort: number | undefined): Promise<IParadisMcpSetupResult> {
		try {
			return await primary;
		} finally {
			await this.propagateCodexSetup(gatewayPort);
		}
	}

	/** 既定のホームへ入れたのと同じ節を、他のアカウント用ホームへも入れる（失敗しても結果は変えない）。 */
	private async propagateCodexSetup(gatewayPort: number | undefined): Promise<void> {
		if (gatewayPort === undefined) {
			return;
		}
		for (const codexHome of this.options.additionalCodexHomes?.() ?? []) {
			if (codexHome === this.options.codexHome) {
				continue;
			}
			// 失敗は setupCodexAt が理由の種類を付けて 1 回だけ知らせる
			await this.setupCodexAt(codexHome, gatewayPort, 'additional');
		}
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
	 * Para Code が前に Antigravity CLI へ書いた橋渡しが、もう無い場所（入れ直した・移した Para Code）を指していれば
	 * 今の場所へ書き直す（起動時に 1 回）。利用者が `disabled` で止めたものは止めたまま。手で書いた para-browser には触らない。
	 */
	private async relocateAntigravityBridge(): Promise<void> {
		if (this.flights.has('antigravity')) {
			return;
		}
		const flight = this.setupAntigravity('relocate').finally(() => {
			if (this.flights.get('antigravity') === flight) {
				this.flights.delete('antigravity');
			}
		});
		this.flights.set('antigravity', flight);
		this.upgradeFlights.add(flight);
		await flight;
	}

	/**
	 * 前に書いた橋渡しの指す実行ファイルかシムが、もう無いか。両方残っている別の場所（ワークツリーの開発版と配布版を
	 * 交互に起動したときなど）は書き直さない（起動のたびに書き換えが往復する。状態は「要修正」になり、ボタンで直せる）。
	 */
	private async antigravityBridgeIsGone(text: string, entry: IParadisAntigravityMcpServerEntry): Promise<boolean> {
		const paths = paradisAntigravityMcpEntryToRelocate(text, entry);
		if (paths === undefined) {
			return false;
		}
		const exists = this.options.pathExists ?? (async (path: string) => fs.stat(path).then(() => true, () => false));
		for (const path of paths) {
			if (!await exists(path)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Antigravity CLI の `~/.gemini/config/mcp_config.json` へ para-browser を stdio の橋渡しとして書く。
	 *
	 * `agy mcp add` は使わず、Codex と同じくファイルを直接書く（読んでから書くまでに変わっていないか確かめ、
	 * 書く前の中身を隣へ控える）。agy が設定のフォルダを作っていなければ書かない。
	 *
	 * @param mode `button` は利用者が押したとき（para-browser の節を丸ごと置き換え、`disabled` を外す）。
	 *   `relocate` は起動時（Para Code が書いた橋渡しの指す場所が無くなったときだけ、`disabled` を残して直す）。
	 */
	private async setupAntigravity(mode: 'button' | 'relocate'): Promise<IParadisMcpSetupResult> {
		const configDir = this.antigravityConfigDir();
		const configPath = join(configDir, 'mcp_config.json');
		const bridge = this.options.resolveMcpBridge?.();
		if (bridge === undefined || !await this.isDirectory(dirname(configPath))) {
			return { cli: 'antigravity', cliAvailable: false, target: configPath, servers: [] };
		}
		const entry = paradisAntigravityMcpServerEntry(bridge, this.options.platform);
		for (let attempt = 1; ; attempt++) {
			let stage: 'read' | 'write' = 'read';
			try {
				const original = await readConfigSnapshot(configPath, this.options.configReadFileSystem);
				if (mode === 'relocate' && !(original.exists && await this.antigravityBridgeIsGone(original.text, entry))) {
					return { cli: 'antigravity', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'already' }] };
				}
				const content = paradisUpsertAntigravityMcpJson(original.exists ? original.text : undefined, entry, mode === 'relocate');
				if (content === undefined) {
					throw new ParadisCodexConfigError('ambiguous', 'Unreadable Antigravity CLI MCP configuration');
				}
				if (original.exists && content === original.text) {
					return { cli: 'antigravity', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'already' }] };
				}
				stage = 'write';
				await writeConfigAtomic(configPath, original, content, this.options.configReadFileSystem);
				return { cli: 'antigravity', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'success' }] };
			} catch (error) {
				const kind = codexConfigFailureKind(stage, error);
				if (kind === 'changed' && attempt < CODEX_CONFIG_CHANGED_ATTEMPTS) {
					continue;
				}
				this.options.log(mode === 'button' ? 'Antigravity CLI MCP configuration update failed' : 'Antigravity CLI MCP bridge relocation failed', undefined, { safe_failure_kind: kind, attempt });
				return { cli: 'antigravity', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'error', detail: ANTIGRAVITY_SETUP_ERROR }] };
			}
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
	private async setupClaude(gatewayPort: number | undefined, options: { readonly allowLegacyAdd: boolean }): Promise<IParadisMcpSetupResult> {
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
		const claude = executable;
		const shellEnv = env;
		const configPath = await this.claudeConfigJsonPath(env);
		const run = (args: readonly string[]) => this.options.runCommand(claude, args, shellEnv);
		// `mcp add` にはツール呼び出しの上限（timeout）を渡す口が無いので、エントリを JSON のまま渡す
		// `mcp add-json` で登録する。add-json を知らない古い CLI だけ、利用者が押したときに限り `mcp add` に戻る
		// （上限は既定の 60 秒のまま）。
		const addJsonArguments = (entry: unknown) => ['mcp', 'add-json', '-s', 'user', 'para-browser', JSON.stringify(entry)];
		const legacyAddArguments = (url: string, authorization: string) => [
			'mcp', 'add', '-s', 'user', '--transport', 'http', 'para-browser', url, '--header', `Authorization: ${authorization}`,
		];
		const readEntry = async () => {
			if (configPath === undefined) {
				throw new ParadisClaudeConfigPathError();
			}
			const snapshot = await readConfigSnapshot(configPath, this.options.configReadFileSystem, MAX_CLAUDE_CONFIG_BYTES);
			return snapshot.exists ? paradisReadClaudeMcpEntry(snapshot.text) : undefined;
		};
		/** 消した後に入れられなかったとき、控えておいた元のエントリで戻し、戻ったかを読み直して確かめる。 */
		const restore = async (original: Record<string, unknown> | undefined) => {
			if (original !== undefined) {
				const restored = await run(addJsonArguments(original));
				const authorization = claudeEntryAuthorization(original);
				if (!commandSucceeded(restored) && options.allowLegacyAdd && original.type === 'http' && typeof original.url === 'string' && authorization !== undefined) {
					await run(legacyAddArguments(original.url, authorization));
				}
			}
			let present: boolean;
			try {
				present = (await readEntry()) !== undefined;
			} catch {
				present = false;
			}
			if (!present) {
				this.options.log('Claude MCP entry was lost while re-registering');
			}
		};
		// 控えが読めずに入れ直しをやめたときの理由（利用者に見せる）。
		let backupReadFailure: string | undefined;
		// `mcp add` / `add-json` に上書きは無い。既にあるのは旧shim方式・古いポート・上限の無い登録なので、
		// 元のエントリを控えてから消して入れ直す（同じ名前の私たちのエントリだけが対象）。
		const addReplacing = async (addArguments: readonly string[]): Promise<IParadisMcpSetupCommandResult> => {
			const added = await run(addArguments);
			if (!commandAlreadyExists(added)) {
				return added;
			}
			// 控えが読めない（読むのに失敗した）ときは消さない。「エントリが無い」（undefined）とは区別する。
			let original: Record<string, unknown> | undefined;
			try {
				original = await readEntry();
			} catch (error) {
				this.options.log('Claude MCP entry backup read failed');
				backupReadFailure = claudeBackupReadFailureDetail(configPath, error);
				return { kind: 'failure', output: '' };
			}
			const removed = await run(['mcp', 'remove', '-s', 'user', 'para-browser']);
			if (!commandSucceeded(removed)) {
				this.options.log('Claude MCP remove failed');
				if (removed.kind === 'timeout' || removed.kind === 'failure') {
					// 終わりを見届けられなかった。消えていたら控えで戻す。
					let present: boolean;
					try {
						present = (await readEntry()) !== undefined;
					} catch {
						present = false;
					}
					if (!present) {
						await restore(original);
					}
				}
				return removed.kind === 'unavailable' ? removed : { kind: 'failure', output: '' };
			}
			const readded = await run(addArguments);
			if (!commandSucceeded(readded)) {
				await restore(original);
			}
			return readded;
		};
		let result: IParadisMcpSetupCommandResult;
		try {
			result = await addReplacing(addJsonArguments(paradisClaudeMcpServerEntry(gatewayPort)));
			if (options.allowLegacyAdd && result.kind === 'exit' && result.code !== 0) {
				result = await addReplacing(legacyAddArguments(paradisMcpServerUrl(gatewayPort), `Bearer \${${PARADIS_PANE_TOKEN_ENV_VAR}}`));
			}
		} catch {
			this.options.log('Claude MCP runner failed');
			return { cli: 'claude', cliAvailable: true, servers: [{ server: 'para-browser', outcome: 'error', detail: CLAUDE_SETUP_ERROR }] };
		}
		if (result.kind === 'unavailable') {
			return { cli: 'claude', cliAvailable: false, servers: [] };
		}
		if (commandSucceeded(result)) {
			return { cli: 'claude', cliAvailable: true, servers: [{ server: 'para-browser', outcome: 'success' }] };
		}
		this.options.log('Claude MCP registration failed');
		return { cli: 'claude', cliAvailable: true, servers: [{ server: 'para-browser', outcome: 'error', detail: backupReadFailure ?? CLAUDE_SETUP_ERROR }] };
	}

	/**
	 * Codex へ para-browser を HTTP の MCP サーバーとして登録する。
	 *
	 * 私たちの節は毎回書き直す（`paradisUpsertCodexMcpToml`）。旧shim方式の絶対パスや古いポートを
	 * 指した節が残っていても、中身を読んで直すより丸ごと入れ替える方が確実。
	 */
	private setupCodex(gatewayPort: number | undefined): Promise<IParadisMcpSetupResult> {
		return this.setupCodexAt(this.options.codexHome, gatewayPort, 'primary');
	}

	/**
	 * `home` が `additional` のときは、アカウントの追加・ログインのたびに裏で呼ばれる（利用者の操作ではない）。
	 * そこで同じホームの同じ理由の失敗を何度も知らせないよう、このプロセスでは 1 回だけ知らせる。
	 */
	private async setupCodexAt(codexHome: string, gatewayPort: number | undefined, home: 'primary' | 'additional'): Promise<IParadisMcpSetupResult> {
		const configPath = join(codexHome, 'config.toml');
		if (gatewayPort === undefined) {
			return { cli: 'codex', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'error', detail: CODEX_SETUP_ERROR }] };
		}
		for (let attempt = 1; ; attempt++) {
			let stage: 'read' | 'write' = 'read';
			try {
				const original = await readConfigSnapshot(configPath, this.options.configReadFileSystem);
				// 節ごと差し替えるので 'present' でも進む。曖昧な構文のときだけ手を出さない。
				if (inspectParadisMcpTomlSection(original.text) === 'ambiguous') {
					throw new ParadisCodexConfigError('ambiguous', 'Ambiguous Codex MCP configuration');
				}
				const upserted = paradisUpsertCodexMcpToml(original.text, gatewayPort);
				// 人に聞く道具（ask_human）だけは Codex の許可のメニューを出さない（既にその道具の表があれば触らない）
				const content = paradisAddCodexToolApproval(upserted, gatewayPort, PARADIS_ASK_HUMAN_TOOL) ?? upserted;
				if (content === original.text) {
					return { cli: 'codex', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'already' }] };
				}
				stage = 'write';
				await writeConfigAtomic(configPath, original, content, this.options.configReadFileSystem);
				return { cli: 'codex', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'success' }] };
			} catch (error) {
				const kind = codexConfigFailureKind(stage, error);
				// 読んでから書くまでの間に変わったときは、読み直してもう 1 回だけ試す。ホームが増えた知らせでは hook の
				// 信頼の記録（Codex 自身が config.toml を書く）も同時に走る（推測: 切り替え先のホームで失敗していた理由の 1 つ）
				if (kind === 'changed' && attempt < CODEX_CONFIG_CHANGED_ATTEMPTS) {
					continue;
				}
				// 切り替え先のホームの config.toml がリンクのときは、利用者が設定を共有している。リンクの先へは
				// 書かない（既定のホームの側でセットアップする）。失敗ではないので知らせない
				if (home === 'additional' && kind === 'symlink') {
					return { cli: 'codex', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'already' }] };
				}
				const reportKey = `${configPath}|${kind}`;
				if (home === 'primary' || !this.reportedAdditionalHomeFailures.has(reportKey)) {
					if (home === 'additional') {
						this.reportedAdditionalHomeFailures.add(reportKey);
					}
					this.options.log(home === 'primary' ? 'Codex MCP configuration update failed' : 'Codex MCP configuration update failed for an additional Codex home', undefined, { safe_failure_kind: kind, safe_home_kind: home, attempt });
				}
				return { cli: 'codex', cliAvailable: true, target: configPath, servers: [{ server: 'para-browser', outcome: 'error', detail: CODEX_SETUP_ERROR }] };
			}
		}
	}
}

/**
 * Antigravity CLI へ書く橋渡しの場所。Para Code 本体を node として動かすので、Electron の中（shared process）でだけ返す。
 * 本体を `ELECTRON_RUN_AS_NODE` で動かすのは、内蔵の chrome-devtools-mcp の起動（paradisDevtoolsMcpProxy.ts）と同じ。
 * シムはパッケージ版でも同じ場所に出す（build/next/index.ts の PARA-PATCH）。
 */
function paradisLocalMcpBridgeLocation(): IParadisMcpStdioBridgeLocation | undefined {
	if (!process.versions.electron) {
		return undefined;
	}
	return {
		executable: process.execPath,
		shimPath: FileAccess.asFileUri('vs/paradis/contrib/agentBrowser/node/paradisBrowserMcpShim.js').fsPath,
	};
}

export function createParadisMcpSetupController(
	resolveShellEnv: () => Promise<NodeJS.ProcessEnv>,
	codexHome: string,
	log: IParadisMcpSetupControllerOptions['log'],
	additionalCodexHomes?: () => readonly string[],
	upgradeMarkerPath?: string,
): ParadisMcpSetupController {
	return new ParadisMcpSetupController({
		platform: process.platform,
		resolveShellEnv,
		findExecutable: (command, env) => findExecutable(command, undefined, undefined, env),
		runCommand: runParadisMcpSetupCommand,
		codexHome,
		additionalCodexHomes,
		// claudeConfigJsonPath は渡さない: シェルの環境の CLAUDE_CONFIG_DIR に従って決める（claude 自身が書く先と同じ）。
		upgradeMarkerPath,
		resolveMcpBridge: paradisLocalMcpBridgeLocation,
		log,
	});
}
