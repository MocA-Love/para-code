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
//   - macOS:   `lsof -nP -iTCP:<port> -sTCP:ESTABLISHED`
//   - Linux:   `ss -Htnp` を優先し、失敗時は `lsof` にフォールバック
//   - Windows: PowerShell `Get-NetTCPConnection` を優先し、失敗時は `netstat -ano` パース
//
// 各コマンド実行は失敗してもゲートウェイ全体を壊さないよう、すべて undefined フォールバックで包む。
// 実機検証はmacOSのみ（Linux / Windows経路はコードレビュー品質、未検証）。

import { exec } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import { PARADIS_PANE_TOKEN_ENV_VAR } from '../common/paradisAgentBrowser.js';

const execAsync = promisify(exec);

const MAX_PARENT_WALK = 15;
const EXEC_TIMEOUT_MS = 3000;

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
	 */
	findPeerPids(clientPort: number, serverPort: number, ownPid: number): Promise<readonly number[]>;
	readProcess(pid: number): Promise<IParadisProcessInfo | undefined>;
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
	probe: IParadisPeerProcessProbe = PARADIS_REAL_PEER_PROBE,
): Promise<string | undefined> {
	if (serverPort === undefined) {
		return undefined;
	}
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
		const byEnv = await readTokenFromEnv(pid);
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
	/** このプロセス（shared process）自身の子孫。SSH の戻り経路など、Para Code が起こしたプロセス。 */
	| 'ownChild'
	/** どちらでもない、または確かめられなかった。 */
	| 'unknown';

/**
 * loopback 接続の相手のプロセスが、`ancestorPid`（ペインのシェル）の子孫か、このプロセス自身の子孫かを確かめる。
 *
 * MCP ツールで「トークンを名乗っているのが本当にそのペインの中のプロセスか」を見るのに使う。
 * 環境変数（`PARA_CODE_TERMINAL_PANE_ID`）は別のプロセスが自分に設定すれば偽装できるので見ない。
 * 接続を持つプロセスが複数あるときは、全部が同じ分類に着くときだけその分類を返す。
 * 相手の特定や親の読み取りに失敗したら `unknown`（確かめられないものは通さない）。
 */
export async function paradisClassifyPeer(
	clientPort: number,
	serverPort: number,
	ownPid: number,
	ancestorPid: number | undefined,
	probe: IParadisPeerProcessProbe = PARADIS_REAL_PEER_PROBE,
): Promise<ParadisPeerKind> {
	if (!isPort(clientPort) || !isPort(serverPort)) {
		return 'unknown';
	}
	const peerPids = await probe.findPeerPids(clientPort, serverPort, ownPid);
	if (peerPids.length === 0) {
		return 'unknown';
	}
	let verdict: ParadisPeerKind | undefined;
	for (const peerPid of peerPids) {
		let kind: ParadisPeerKind = 'unknown';
		await walkAncestors(peerPid, probe, pid => {
			if (ancestorPid !== undefined && pid === ancestorPid) {
				kind = 'descendant';
				return true;
			}
			if (pid === ownPid) {
				kind = 'ownChild';
				return true;
			}
			return false;
		});
		if (kind === 'unknown' || (verdict !== undefined && verdict !== kind)) {
			return 'unknown';
		}
		verdict = kind;
	}
	return verdict ?? 'unknown';
}

/** 互換用: 相手が `ancestorPid` の子孫か。 */
export async function paradisPeerDescendsFromPid(clientPort: number, serverPort: number, ownPid: number, ancestorPid: number, probe?: IParadisPeerProcessProbe): Promise<boolean> {
	return await paradisClassifyPeer(clientPort, serverPort, ownPid, ancestorPid, probe) === 'descendant';
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

async function findPeerPids(clientPort: number, serverPort: number, ownPid: number): Promise<number[]> {
	if (!isPort(clientPort) || !isPort(serverPort)) {
		return [];
	}
	switch (process.platform) {
		case 'darwin':
			return findPeerPidsViaLsof(clientPort, serverPort, ownPid);
		case 'linux': {
			const viaSs = await findPeerPidsViaSs(clientPort, serverPort, ownPid);
			return viaSs.length > 0 ? viaSs : findPeerPidsViaLsof(clientPort, serverPort, ownPid);
		}
		case 'win32': {
			const viaPowerShell = await findPeerPidsViaPowerShell(clientPort, serverPort, ownPid);
			return viaPowerShell.length > 0 ? viaPowerShell : findPeerPidsViaNetstat(clientPort, serverPort, ownPid);
		}
		default:
			return [];
	}
}

/** `lsof` によるピアPID特定（macOS主経路 / Linuxフォールバック）。 */
async function findPeerPidsViaLsof(clientPort: number, serverPort: number, ownPid: number): Promise<number[]> {
	try {
		const { stdout } = await execAsync(`lsof -nP -iTCP@127.0.0.1:${clientPort} -sTCP:ESTABLISHED 2>/dev/null || true`, {
			timeout: EXEC_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		return paradisParseLsofPeerPids(stdout, clientPort, serverPort, ownPid);
	} catch {
		return [];
	}
}

/** `ss -Htnp` によるピアPID特定（Linux主経路）。送信元・宛先のアドレスとポートの両方で絞る。 */
async function findPeerPidsViaSs(clientPort: number, serverPort: number, ownPid: number): Promise<number[]> {
	try {
		const { stdout } = await execAsync(`ss -Htnp state established "( src 127.0.0.1:${clientPort} and dst 127.0.0.1:${serverPort} )" 2>/dev/null || true`, {
			timeout: EXEC_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		return paradisParseSsPeerPids(stdout, clientPort, serverPort, ownPid);
	} catch {
		return [];
	}
}

/** PowerShell `Get-NetTCPConnection` によるピアPID特定（Windows主経路）。4つ組で絞る。 */
async function findPeerPidsViaPowerShell(clientPort: number, serverPort: number, ownPid: number): Promise<number[]> {
	try {
		const cmd = `powershell -NoProfile -NonInteractive -Command "(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${clientPort} -RemoteAddress 127.0.0.1 -RemotePort ${serverPort} -State Established -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)"`;
		const { stdout } = await execAsync(cmd, { timeout: EXEC_TIMEOUT_MS * 2, maxBuffer: 1024 * 1024 });
		return uniquePids(stdout.trim().split(/\r?\n/).map(line => Number.parseInt(line.trim(), 10)), ownPid);
	} catch {
		return [];
	}
}

/** `netstat -ano` パースによるピアPID特定（Windowsフォールバック）。 */
async function findPeerPidsViaNetstat(clientPort: number, serverPort: number, ownPid: number): Promise<number[]> {
	try {
		const { stdout } = await execAsync('netstat -ano -p TCP', { timeout: EXEC_TIMEOUT_MS * 2, maxBuffer: 4 * 1024 * 1024 });
		return paradisParseNetstatPeerPids(stdout, clientPort, serverPort, ownPid);
	} catch {
		return [];
	}
}

/** 実物の OS コマンドで探す・読む。 */
const PARADIS_REAL_PEER_PROBE: IParadisPeerProcessProbe = {
	findPeerPids,
	readProcess: readProcessInfo,
};

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
