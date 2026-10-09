/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CDPゲートウェイの「呼び出し元ペイン識別」実装（Superset方式の移植＋クロスプラットフォーム拡張）。
// CDPクライアント（chrome-devtools-mcp / browser-use等）は接続にトークンを付けられない
// （puppeteerは `new URL('/json/version', browserURL)` でパス・クエリ・ヘッダーを落とす）ため、
// loopback TCP接続のピアPIDを特定し、以下の3段構えでペイントークンへ解決する:
//
//   1. URLクエリ `?pane=<token>` が明示されていれば最優先（ゲートウェイ側で処理。curlテスト用＋確実な経路）
//   2. ピアPIDとその祖先プロセスの環境変数から `PARA_CODE_TERMINAL_PANE_ID` を読む
//      （macOS: `ps eww`、Linux: `/proc/<pid>/environ`。Windowsは他プロセスのenv読み取りが
//       ネイティブコード無しでは困難なためスキップ）
//   3. ピアPIDの祖先チェーンを、workbenchから同期された「既知のシェルPID⇔トークン」表と突合する
//      （全OS共通のフォールバック。WindowsではこれがCDP経路の主経路。
//       chrome-devtools-mcpはCLI（claude/codex）の子、CLIはシェルの子なのでチェーンは2〜3ホップ）
//
// ピアPIDの特定（プラットフォーム別）:
//   - macOS:   `lsof -nP -iTCP:<port> -sTCP:ESTABLISHED`。親をたどるプロセス表は `ps -A -o pid=,ppid=` を 1 回だけ
//              取り、lsof と同時に走らせる（以前は親 1 段ごとに `ps` を起こしていた）
//   - Linux:   `ss -Htnp` を優先し、失敗時は `lsof` にフォールバック
//   - Windows: PowerShell `Get-NetTCPConnection` を優先し、失敗時は `netstat -ano` パース
//
// 各コマンド実行は失敗してもゲートウェイ全体を壊さないよう、すべて undefined フォールバックで包む。
// 呼び出し元の分類（paradisClassifyPeer）は、コマンドが失敗・時間切れしたとき（機械の負荷が高いと起動に数秒
// かかる）に、待ちを延ばして数回やり直す。確かめた結果が「子孫でない」ならやり直さない（通す範囲は広げない）。
// 実機検証はmacOSのみ（Linux / Windows経路はコードレビュー品質、未検証）。

import { exec } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import { PARADIS_PANE_TOKEN_ENV_VAR } from '../common/paradisAgentBrowser.js';

const execAsync = promisify(exec);

const MAX_PARENT_WALK = 15;
const EXEC_TIMEOUT_MS = 3000;
/** 呼び出し元の分類のやり直しで、外部コマンド 1 本に待つ長さ（1 回目は {@link EXEC_TIMEOUT_MS}）。 */
const CLASSIFY_RETRY_TIMEOUT_MS = 8000;
/** 呼び出し元の分類に掛けてよい時間の合計（MCP の道具の呼び出しは数十秒まで待てる）。 */
const CLASSIFY_BUDGET_MS = 15_000;
const CLASSIFY_RETRY_DELAY_MS = 250;
const CLASSIFY_MAX_ATTEMPTS = 3;

/** 接続の相手やプロセスを読むコマンドが失敗・時間切れした（やり直せば読めるかもしれない）。 */
export class ParadisPeerProbeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ParadisPeerProbeError';
	}
}

const TOKEN_PATTERN = new RegExp(`${PARADIS_PANE_TOKEN_ENV_VAR}=([0-9a-fA-F-]+)`);

/** shared process側レジストリ（workbenchから同期される シェルPID → ペイントークン 表）への参照。 */
export interface IParadisPaneShellLookup {
	getTokenForShellPid(pid: number): string | undefined;
}

/** プロセス1つ分の情報（親 PID と、分かるなら起動時刻）。 */
export interface IParadisProcessInfo {
	readonly ppid: number | undefined;
	/**
	 * 起動時刻（大小だけを比べる。単位は OS ごとに違ってよい）。Windows の `ParentProcessId` は親が
	 * 死んでも更新されないので、PID が使い回されると無関係なプロセスが「親」に見える。親の起動時刻が
	 * 子より後なら使い回しとみなしてたどるのをやめる。分からなければ undefined（比べない）。
	 */
	readonly startTime?: number;
}

/**
 * 接続の相手を探す・プロセスを読む処理。実物は OS のコマンドを起こす。テストでは差し替える。
 */
export interface IParadisPeerProcessProbe {
	/**
	 * `127.0.0.1:<clientPort> -> 127.0.0.1:<serverPort>` の接続を持つプロセス（自分以外）。
	 * 4つ組の完全一致だけを採る。手元のポートだけで探すと、同じポート番号の IPv6（`[::1]`）の接続や、
	 * 別のサーバーへの接続を持つ無関係なプロセスが当たる（送信元ポートを細工すればなりすませる）。
	 * コマンドが失敗・時間切れしたら {@link ParadisPeerProbeError} を投げる（空の配列は「見つからなかった」）。
	 */
	findPeerPids(clientPort: number, serverPort: number, ownPid: number): Promise<readonly number[]>;
	/** プロセスが無ければ undefined。読めなかったら {@link ParadisPeerProbeError} を投げてよい。 */
	readProcess(pid: number): Promise<IParadisProcessInfo | undefined>;
	/** プロセスの環境変数からペイントークンを読む（CDP ゲートウェイの解決だけが使う）。 */
	readTokenFromEnv(pid: number): Promise<string | undefined>;
}

/**
 * loopback接続のリモート（クライアント側エフェメラル）ポートからペイントークンを解決する。
 * 解決できない場合は undefined（呼び出し元はバインド無しとして扱う）。
 * 接続を持つプロセスが複数あるとき（fork で受け継いだ等）は、全部が同じトークンに着くときだけ採る。
 */
export async function paradisResolvePaneTokenForPeerPort(
	remotePort: number,
	ownPid: number,
	shellLookup: IParadisPaneShellLookup,
	serverPort?: number,
	probe?: IParadisPeerProcessProbe,
): Promise<string | undefined> {
	if (serverPort === undefined) {
		return undefined;
	}
	probe ??= paradisPeerProbeFor(remotePort, serverPort);
	try {
		const peerPids = await probe.findPeerPids(remotePort, serverPort, ownPid);
		let resolved: string | undefined;
		for (const peerPid of peerPids) {
			const token = await resolveTokenFromAncestors(peerPid, shellLookup, probe);
			if (token === undefined || (resolved !== undefined && resolved !== token)) {
				return undefined;
			}
			resolved = token;
		}
		return resolved;
	} catch (error) {
		if (error instanceof ParadisPeerProbeError) {
			return undefined;
		}
		throw error;
	}
}

async function resolveTokenFromAncestors(peerPid: number, shellLookup: IParadisPaneShellLookup, probe: IParadisPeerProcessProbe): Promise<string | undefined> {
	// ピアPIDとその祖先を辿りながら、(a) 既知シェルPID表との突合、(b) env読み取り の両方を試す
	let result: string | undefined;
	await walkAncestors(peerPid, probe, async pid => {
		const byShell = shellLookup.getTokenForShellPid(pid);
		if (byShell) {
			result = byShell;
			return true;
		}
		const byEnv = await probe.readTokenFromEnv(pid);
		if (byEnv) {
			result = byEnv;
			return true;
		}
		return false;
	});
	return result;
}

/**
 * `pid` から親へたどり、`visit` が真を返したら止める。たどれなくなったら（親が分からない・1 以下・
 * 自分自身・起動時刻が子より新しい＝PID の使い回し）止める。@returns `visit` が真を返したか。
 */
async function walkAncestors(pid: number, probe: IParadisPeerProcessProbe, visit: (pid: number) => Promise<boolean> | boolean): Promise<boolean> {
	let current = pid;
	let info = await probe.readProcess(current);
	for (let depth = 0; depth < MAX_PARENT_WALK; depth++) {
		if (!Number.isFinite(current) || current <= 1) {
			return false;
		}
		if (await visit(current)) {
			return true;
		}
		const parent = info?.ppid;
		if (parent === undefined || parent === current || parent <= 1) {
			return false;
		}
		const parentInfo = await probe.readProcess(parent);
		if (info?.startTime !== undefined && parentInfo?.startTime !== undefined && parentInfo.startTime > info.startTime) {
			return false;
		}
		current = parent;
		info = parentInfo;
	}
	return false;
}

// --- ピアPID特定 -------------------------------------------------------------

/** 接続元プロセスの分類。 */
export type ParadisPeerKind =
	/** 指定したプロセス（ペインのシェル）の子孫。 */
	| 'descendant'
	/** Para Code が張った SSH の戻り経路（`ssh -R`）のプロセスそのもの。 */
	| 'tunnel'
	/** どちらでもない、または確かめられなかった。 */
	| 'unknown';

/** 何と照合するか。手元のペインはシェルの PID、SSH の接続先のペインは戻り経路の `ssh` の PID。 */
export interface IParadisPeerExpectation {
	/** 手元のペインのシェル。接続を持つプロセスがこの子孫なら `descendant`。 */
	readonly ancestorPid?: number;
	/**
	 * Para Code が張った `ssh -R` の PID。接続を持つプロセスが**これそのもの**なら `tunnel`。
	 * 祖先に shared process がいるかでは決めない（shared process は git や codex app-server なども起こし、
	 * それらはリポジトリの設定やフックで利用者・エージェントのコードを走らせられるため）。
	 */
	readonly tunnelPid?: number;
}

/** {@link paradisClassifyPeer} のやり直しの決め事（テストで時計と待ちを差し替える）。 */
export interface IParadisClassifyPeerOptions {
	/** 全体に掛けてよい時間。既定 {@link CLASSIFY_BUDGET_MS}。 */
	readonly budgetMs?: number;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	/** 何回目の試し（0 から）に使う probe か。既定は実物の OS コマンド（やり直すほど待ちを延ばす）。 */
	readonly probeFor?: (attempt: number, timeoutMs: number) => IParadisPeerProcessProbe;
}

/**
 * loopback 接続の相手のプロセスを分類する。
 *
 * MCP ツールと hook で「トークンを名乗っているのが本当にそのペインの中のプロセスか」を見るのに使う。
 * 環境変数（`PARA_CODE_TERMINAL_PANE_ID`）は別のプロセスが自分に設定すれば偽装できるので見ない。
 * 接続を持つプロセスが複数あるときは、全部が同じ分類に着くときだけその分類を返す。
 * 相手の特定や親の読み取りに失敗したら `unknown`（確かめられないものは通さない）。ただし、コマンドの失敗・
 * 時間切れと、接続の持ち主が見つからなかったときは、待ちを延ばして {@link CLASSIFY_MAX_ATTEMPTS} 回まで
 * やり直す（負荷が高いと lsof / ps の起動が数秒かかり、正しい呼び出し元を断っていた）。親をたどり切って
 * 子孫でないと分かったときはやり直さない。
 * @param probe 渡すと、やり直しでも同じ probe を使う（テスト用）。
 */
export async function paradisClassifyPeer(
	clientPort: number,
	serverPort: number,
	ownPid: number,
	expectation: IParadisPeerExpectation,
	probe?: IParadisPeerProcessProbe,
	options?: IParadisClassifyPeerOptions,
): Promise<ParadisPeerKind> {
	if (!isPort(clientPort) || !isPort(serverPort)) {
		return 'unknown';
	}
	const now = options?.now ?? Date.now;
	const sleep = options?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const deadline = now() + (options?.budgetMs ?? CLASSIFY_BUDGET_MS);
	for (let attempt = 0; ; attempt++) {
		const timeoutMs = Math.max(500, Math.min(attempt === 0 ? EXEC_TIMEOUT_MS : CLASSIFY_RETRY_TIMEOUT_MS, deadline - now()));
		const attemptProbe = probe ?? options?.probeFor?.(attempt, timeoutMs) ?? paradisPeerProbeFor(clientPort, serverPort, timeoutMs, { processTable: true });
		let outcome: { readonly kind: ParadisPeerKind; readonly retry: boolean };
		try {
			outcome = await classifyPeerOnce(clientPort, serverPort, ownPid, expectation, attemptProbe);
		} catch (error) {
			if (!(error instanceof ParadisPeerProbeError)) {
				throw error;
			}
			outcome = { kind: 'unknown', retry: true };
		}
		if (!outcome.retry || attempt + 1 >= CLASSIFY_MAX_ATTEMPTS || now() + CLASSIFY_RETRY_DELAY_MS >= deadline) {
			return outcome.kind;
		}
		await sleep(CLASSIFY_RETRY_DELAY_MS);
	}
}

/** 1 回分の照合。`retry` はやり直せば結果が変わりうるか（持ち主が見つからなかった）。 */
async function classifyPeerOnce(clientPort: number, serverPort: number, ownPid: number, expectation: IParadisPeerExpectation, probe: IParadisPeerProcessProbe): Promise<{ readonly kind: ParadisPeerKind; readonly retry: boolean }> {
	const peerPids = await probe.findPeerPids(clientPort, serverPort, ownPid);
	if (peerPids.length === 0) {
		// サーバーが接続を握っている最中なので、持ち主は居るはず。見えなかったのは読み取りの取りこぼし
		return { kind: 'unknown', retry: true };
	}
	let verdict: ParadisPeerKind | undefined;
	for (const peerPid of peerPids) {
		let kind: ParadisPeerKind = 'unknown';
		if (expectation.tunnelPid !== undefined && peerPid === expectation.tunnelPid) {
			kind = 'tunnel';
		} else if (expectation.ancestorPid !== undefined) {
			const ancestorPid = expectation.ancestorPid;
			if (await walkAncestors(peerPid, probe, pid => pid === ancestorPid)) {
				kind = 'descendant';
			}
		}
		if (kind === 'unknown' || (verdict !== undefined && verdict !== kind)) {
			return { kind: 'unknown', retry: false };
		}
		verdict = kind;
	}
	return { kind: verdict ?? 'unknown', retry: false };
}

/**
 * loopback 接続の相手のプロセスが `pids` のどれかか（戻り経路の `ssh -R` から来たかを見るのに使う）。
 * 相手を特定できなければ undefined（どう倒すかは呼び出し側が決める）。
 */
export async function paradisPeerIsOneOf(
	clientPort: number,
	serverPort: number,
	ownPid: number,
	pids: readonly number[],
	probe: IParadisPeerProcessProbe = paradisPeerProbeFor(clientPort, serverPort),
): Promise<boolean | undefined> {
	if (pids.length === 0) {
		return false;
	}
	if (!isPort(clientPort) || !isPort(serverPort)) {
		return undefined;
	}
	const wanted = new Set(pids);
	let peerPids: readonly number[];
	try {
		peerPids = await probe.findPeerPids(clientPort, serverPort, ownPid);
	} catch (error) {
		if (error instanceof ParadisPeerProbeError) {
			return undefined;
		}
		throw error;
	}
	return peerPids.length === 0 ? undefined : peerPids.some(pid => wanted.has(pid));
}

function isPort(value: number): boolean {
	return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function uniquePids(pids: Iterable<number>, ownPid: number): number[] {
	return [...new Set([...pids].filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid !== ownPid))];
}

/**
 * `lsof -nP -iTCP -sTCP:ESTABLISHED` の出力から、`127.0.0.1:<clientPort>->127.0.0.1:<serverPort>` の
 * 接続を持つ PID を拾う。NAME 列（9列目以降）は `127.0.0.1:49768->127.0.0.1:47286 (ESTABLISHED)` の形。
 */
export function paradisParseLsofPeerPids(stdout: string, clientPort: number, serverPort: number, ownPid: number): number[] {
	const expected = `127.0.0.1:${clientPort}->127.0.0.1:${serverPort}`;
	const pids: number[] = [];
	for (const line of stdout.trim().split('\n').slice(1)) { // ヘッダー行をスキップ
		const cols = line.trim().split(/\s+/);
		if (cols.length < 9) {
			continue;
		}
		if (cols[8] === expected) {
			pids.push(Number.parseInt(cols[1] ?? '', 10));
		}
	}
	return uniquePids(pids, ownPid);
}

/**
 * `ss -Htnp state established` の出力から拾う。状態を絞ると状態の列は出ず、
 * `Recv-Q Send-Q Local:Port Peer:Port Process` の順になる。
 */
export function paradisParseSsPeerPids(stdout: string, clientPort: number, serverPort: number, ownPid: number): number[] {
	const pids: number[] = [];
	for (const line of stdout.trim().split('\n')) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 5 || cols[2] !== `127.0.0.1:${clientPort}` || cols[3] !== `127.0.0.1:${serverPort}`) {
			continue;
		}
		for (const match of cols.slice(4).join(' ').matchAll(/pid=(\d+)/g)) {
			pids.push(Number.parseInt(match[1] ?? '', 10));
		}
	}
	return uniquePids(pids, ownPid);
}

/** `netstat -ano -p TCP` の出力（`TCP 127.0.0.1:<local> 127.0.0.1:<remote> ESTABLISHED <pid>`）から拾う。 */
export function paradisParseNetstatPeerPids(stdout: string, clientPort: number, serverPort: number, ownPid: number): number[] {
	const pids: number[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 5 || cols[0] !== 'TCP' || !/^ESTABLISHED$/i.test(cols[3] ?? '')) {
			continue;
		}
		if (cols[1] === `127.0.0.1:${clientPort}` && cols[2] === `127.0.0.1:${serverPort}`) {
			pids.push(Number.parseInt(cols[4] ?? '', 10));
		}
	}
	return uniquePids(pids, ownPid);
}

/** 接続の持ち主を探す（macOS / Linux）。コマンドが失敗・時間切れしたら {@link ParadisPeerProbeError}。 */
async function findPeerPids(clientPort: number, serverPort: number, ownPid: number, timeoutMs: number = EXEC_TIMEOUT_MS): Promise<number[]> {
	if (!isPort(clientPort) || !isPort(serverPort)) {
		return [];
	}
	switch (process.platform) {
		case 'darwin':
			return findPeerPidsViaLsof(clientPort, serverPort, ownPid, timeoutMs);
		case 'linux': {
			let viaSs: number[] | undefined;
			try {
				viaSs = await findPeerPidsViaSs(clientPort, serverPort, ownPid, timeoutMs);
			} catch {
				viaSs = undefined;
			}
			return viaSs !== undefined && viaSs.length > 0 ? viaSs : findPeerPidsViaLsof(clientPort, serverPort, ownPid, timeoutMs);
		}
		default:
			return [];
	}
}

/** `lsof` によるピアPID特定（macOS主経路 / Linuxフォールバック）。 */
async function findPeerPidsViaLsof(clientPort: number, serverPort: number, ownPid: number, timeoutMs: number): Promise<number[]> {
	let stdout: string;
	try {
		// 一致が無いと lsof は 1 で終わるので `|| true` で成功にする（失敗として扱うのは起動の失敗と時間切れだけ）
		({ stdout } = await execAsync(`lsof -nP -iTCP@127.0.0.1:${clientPort} -sTCP:ESTABLISHED 2>/dev/null || true`, {
			timeout: timeoutMs,
			maxBuffer: 1024 * 1024,
		}));
	} catch (error) {
		throw new ParadisPeerProbeError(`lsof failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`);
	}
	return paradisParseLsofPeerPids(stdout, clientPort, serverPort, ownPid);
}

/** `ss -Htnp` によるピアPID特定（Linux主経路）。送信元・宛先のアドレスとポートの両方で絞る。 */
async function findPeerPidsViaSs(clientPort: number, serverPort: number, ownPid: number, timeoutMs: number): Promise<number[]> {
	const { stdout } = await execAsync(`ss -Htnp state established "( src 127.0.0.1:${clientPort} and dst 127.0.0.1:${serverPort} )" 2>/dev/null || true`, {
		timeout: timeoutMs,
		maxBuffer: 1024 * 1024,
	});
	return paradisParseSsPeerPids(stdout, clientPort, serverPort, ownPid);
}

/** {@link paradisPeerProbeFor} の選び方。 */
interface IParadisPeerProbeOptions {
	/**
	 * macOS で、親をたどるためのプロセス表（`ps -A -o pid=,ppid=`）を最初に 1 回だけ取り、接続の持ち主を探す
	 * コマンドと同時に走らせる。親を 1 段ごとに `ps` で読むと、負荷が高いときに起動の待ちが積み重なる。
	 */
	readonly processTable?: boolean;
}

/**
 * 1 回の照合に使う probe。`timeoutMs` は外部コマンド 1 本に待つ長さ。Windows では PowerShell の起動が重い
 * （1 回 0.3〜1 秒）ので、接続表とプロセス表を 1 本のスクリプトでまとめて取り、その結果だけで照合する
 * （hook の待ち時間 3 秒に収める）。
 */
function paradisPeerProbeFor(clientPort: number, serverPort: number, timeoutMs: number = EXEC_TIMEOUT_MS, options?: IParadisPeerProbeOptions): IParadisPeerProcessProbe {
	if (process.platform === 'win32') {
		let snapshot: Promise<IParadisWindowsPeerSnapshot | undefined> | undefined;
		const load = () => snapshot ??= readWindowsPeerSnapshot(clientPort, serverPort, timeoutMs);
		return {
			findPeerPids: async (_clientPort, _serverPort, ownPid) => {
				const loaded = await load();
				if (loaded === undefined) {
					throw new ParadisPeerProbeError('the Windows connection snapshot failed');
				}
				return uniquePids(loaded.peerPids, ownPid);
			},
			readProcess: async pid => (await load())?.processes.get(pid),
			readTokenFromEnv: async () => undefined,
		};
	}
	let table: Promise<ReadonlyMap<number, IParadisProcessInfo>> | undefined;
	if (process.platform === 'darwin' && options?.processTable === true) {
		table = readProcessTable(timeoutMs);
		// 使われずに失敗しても、未処理の拒否にしない
		table.catch(() => undefined);
	}
	return {
		findPeerPids: (clientPortArg, serverPortArg, ownPid) => findPeerPids(clientPortArg, serverPortArg, ownPid, timeoutMs),
		readProcess: async pid => table !== undefined ? (await table).get(pid) : readProcessInfo(pid),
		readTokenFromEnv,
	};
}

/** `ps -A -o pid=,ppid=` の出力を PID → 親 PID の表にする。 */
export function paradisParseProcessTable(stdout: string): ReadonlyMap<number, IParadisProcessInfo> {
	const table = new Map<number, IParadisProcessInfo>();
	for (const line of stdout.split('\n')) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 2) {
			continue;
		}
		const pid = Number.parseInt(cols[0], 10);
		const ppid = Number.parseInt(cols[1], 10);
		if (Number.isSafeInteger(pid) && pid > 0) {
			table.set(pid, { ppid: Number.isSafeInteger(ppid) && ppid > 0 ? ppid : undefined });
		}
	}
	return table;
}

/** macOS のプロセス表を 1 回で読む。失敗・時間切れは {@link ParadisPeerProbeError}。 */
async function readProcessTable(timeoutMs: number): Promise<ReadonlyMap<number, IParadisProcessInfo>> {
	try {
		const { stdout } = await execAsync('ps -A -o pid=,ppid=', { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
		const table = paradisParseProcessTable(stdout);
		if (table.size === 0) {
			throw new Error('empty process table');
		}
		return table;
	} catch (error) {
		throw new ParadisPeerProbeError(`ps failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`);
	}
}

interface IParadisWindowsPeerSnapshot {
	readonly peerPids: readonly number[];
	readonly processes: ReadonlyMap<number, IParadisProcessInfo>;
}

/** `C <pid>`（4つ組の接続の持ち主）と `P <pid> <ppid> <起動時刻の ticks>`（プロセス表）の行を読む。 */
export function paradisParseWindowsPeerSnapshot(stdout: string): IParadisWindowsPeerSnapshot {
	const peerPids: number[] = [];
	const processes = new Map<number, IParadisProcessInfo>();
	for (const line of stdout.split(/\r?\n/)) {
		const cols = line.trim().split(/\s+/);
		if (cols[0] === 'C' && cols.length >= 2) {
			peerPids.push(Number.parseInt(cols[1], 10));
		} else if (cols[0] === 'P' && cols.length >= 3) {
			const pid = Number.parseInt(cols[1], 10);
			const ppid = Number.parseInt(cols[2], 10);
			const ticks = Number(cols[3]);
			if (Number.isSafeInteger(pid) && pid > 0) {
				processes.set(pid, {
					ppid: Number.isSafeInteger(ppid) && ppid > 0 ? ppid : undefined,
					...(Number.isFinite(ticks) && ticks > 0 ? { startTime: ticks } : {}),
				});
			}
		}
	}
	return { peerPids, processes };
}

async function readWindowsPeerSnapshot(clientPort: number, serverPort: number, timeoutMs: number): Promise<IParadisWindowsPeerSnapshot | undefined> {
	if (!isPort(clientPort) || !isPort(serverPort)) {
		return undefined;
	}
	const script = [
		`Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${clientPort} -RemoteAddress 127.0.0.1 -RemotePort ${serverPort} -State Established -ErrorAction SilentlyContinue | ForEach-Object { 'C ' + $_.OwningProcess }`,
		`Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { 'P {0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks } else { 0 }) }`,
	].join('; ');
	try {
		// スクリプトは UTF-16LE の Base64 で渡す（cmd.exe を経由する引用の崩れを避ける）
		const encoded = Buffer.from(script, 'utf16le').toString('base64');
		const { stdout } = await execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, { timeout: timeoutMs * 2, maxBuffer: 8 * 1024 * 1024 });
		const parsed = paradisParseWindowsPeerSnapshot(stdout);
		if (parsed.peerPids.length > 0) {
			return parsed;
		}
		// Get-NetTCPConnection が使えない環境（古い Windows など）は netstat で持ち主を探す
		const { stdout: netstat } = await execAsync('netstat -ano -p TCP', { timeout: timeoutMs * 2, maxBuffer: 4 * 1024 * 1024 });
		return { peerPids: paradisParseNetstatPeerPids(netstat, clientPort, serverPort, 0), processes: parsed.processes };
	} catch {
		return undefined;
	}
}

// --- 環境変数からのトークン読み取り -------------------------------------------

async function readTokenFromEnv(pid: number): Promise<string | undefined> {
	if (process.platform === 'win32') {
		// 他プロセスのenv読み取りはネイティブコード無しでは困難なため実装しない
		// （Windowsは祖先チェーン⇔シェルPID突合が主経路）。
		return undefined;
	}
	if (process.platform === 'linux') {
		try {
			const environ = await fs.readFile(`/proc/${pid}/environ`, 'utf8');
			for (const entry of environ.split('\0')) {
				if (entry.startsWith(`${PARADIS_PANE_TOKEN_ENV_VAR}=`)) {
					return entry.slice(PARADIS_PANE_TOKEN_ENV_VAR.length + 1) || undefined;
				}
			}
			return undefined;
		} catch {
			// /proc が読めない場合は ps eww にフォールバック
		}
	}
	try {
		// `ps eww` はコマンドラインの後ろに環境変数を連結して出力する（macOSでは
		// 同一ユーザーのサードパーティバイナリのenvも読める。実機検証済み）。
		const { stdout } = await execAsync(`ps eww -o command= -p ${pid} 2>/dev/null || true`, {
			timeout: EXEC_TIMEOUT_MS,
			maxBuffer: 4 * 1024 * 1024,
		});
		const match = stdout.match(TOKEN_PATTERN);
		return match?.[1] ?? undefined;
	} catch {
		return undefined;
	}
}

// --- 親PIDの解決 --------------------------------------------------------------

async function readProcessInfo(pid: number): Promise<IParadisProcessInfo | undefined> {
	if (process.platform === 'win32') {
		try {
			// 親 PID と起動時刻（UTC の ticks）。親が死んでも ParentProcessId は更新されないので、
			// 起動時刻で PID の使い回しを見分ける
			const cmd = `powershell -NoProfile -NonInteractive -Command "$p = Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\" -ErrorAction SilentlyContinue; if ($p) { '{0} {1}' -f $p.ParentProcessId, $p.CreationDate.ToUniversalTime().Ticks }"`;
			const { stdout } = await execAsync(cmd, { timeout: EXEC_TIMEOUT_MS * 2, maxBuffer: 1024 * 1024 });
			const [ppidText, ticksText] = stdout.trim().split(/\s+/);
			const ppid = Number.parseInt(ppidText ?? '', 10);
			const ticks = Number(ticksText);
			return {
				ppid: Number.isFinite(ppid) && ppid > 0 ? ppid : undefined,
				...(Number.isFinite(ticks) && ticks > 0 ? { startTime: ticks } : {}),
			};
		} catch {
			return undefined;
		}
	}
	if (process.platform === 'linux') {
		try {
			// /proc/<pid>/stat の4フィールド目がppid（comm内の括弧を考慮して末尾から辿る）
			const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
			const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
			const ppid = Number.parseInt(afterComm[1] ?? '', 10);
			// 22 番目（comm の後ろから数えて 20 番目）が起動時刻（ブート後の clock tick）
			const startTime = Number(afterComm[19]);
			if (Number.isFinite(ppid) && ppid > 0) {
				return { ppid, ...(Number.isFinite(startTime) && startTime > 0 ? { startTime } : {}) };
			}
		} catch {
			// ps にフォールバック
		}
	}
	try {
		const { stdout } = await execAsync(`ps -o ppid= -p ${pid} 2>/dev/null || true`, { timeout: EXEC_TIMEOUT_MS });
		const ppid = Number.parseInt(stdout.trim(), 10);
		// macOS / Linux では親が死ぬと子は 1（launchd / init）へ付け替えられるので、使い回しは起きない
		return { ppid: Number.isFinite(ppid) && ppid > 0 ? ppid : undefined };
	} catch {
		return undefined;
	}
}
