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

/**
 * loopback接続のリモート（クライアント側エフェメラル）ポートからペイントークンを解決する。
 * 解決できない場合は undefined（呼び出し元はバインド無しとして扱う）。
 */
export async function paradisResolvePaneTokenForPeerPort(
	remotePort: number,
	ownPid: number,
	shellLookup: IParadisPaneShellLookup,
): Promise<string | undefined> {
	const peerPid = await resolvePeerPid(remotePort, ownPid);
	if (peerPid === undefined) {
		return undefined;
	}
	// ピアPIDとその祖先を辿りながら、(a) 既知シェルPID表との突合、(b) env読み取り の両方を試す
	let current = peerPid;
	for (let depth = 0; depth < MAX_PARENT_WALK; depth++) {
		if (!Number.isFinite(current) || current <= 1) {
			return undefined;
		}
		const byShell = shellLookup.getTokenForShellPid(current);
		if (byShell) {
			return byShell;
		}
		const byEnv = await readTokenFromEnv(current);
		if (byEnv) {
			return byEnv;
		}
		const parent = await readPpid(current);
		if (parent === undefined || parent === current) {
			return undefined;
		}
		current = parent;
	}
	return undefined;
}

// --- ピアPID特定 -------------------------------------------------------------

async function resolvePeerPid(remotePort: number, ownPid: number): Promise<number | undefined> {
	if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
		return undefined;
	}
	switch (process.platform) {
		case 'darwin':
			return resolvePeerPidViaLsof(remotePort, ownPid);
		case 'linux':
			return await resolvePeerPidViaSs(remotePort, ownPid) ?? resolvePeerPidViaLsof(remotePort, ownPid);
		case 'win32':
			return await resolvePeerPidViaPowerShell(remotePort, ownPid) ?? resolvePeerPidViaNetstat(remotePort, ownPid);
		default:
			return undefined;
	}
}

/**
 * `lsof` によるピアPID特定（macOS主経路 / Linuxフォールバック）。
 * loopback接続ではサーバー側とクライアント側の2エントリが現れるため、
 * 「ローカルポートがremotePortに一致し、かつ自プロセスでない」ものをピアとみなす。
 */
async function resolvePeerPidViaLsof(remotePort: number, ownPid: number): Promise<number | undefined> {
	try {
		const { stdout } = await execAsync(`lsof -nP -iTCP:${remotePort} -sTCP:ESTABLISHED 2>/dev/null || true`, {
			timeout: EXEC_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		for (const line of stdout.trim().split('\n').slice(1)) { // ヘッダー行をスキップ
			const cols = line.trim().split(/\s+/);
			if (cols.length < 9) {
				continue;
			}
			const pid = Number.parseInt(cols[1] ?? '', 10);
			if (!Number.isFinite(pid) || pid <= 0 || pid === ownPid) {
				continue;
			}
			const name = cols.slice(8).join(' ');
			const match = name.match(/^(?:\[::1\]|127\.0\.0\.1):(\d+)->(?:\[::1\]|127\.0\.0\.1):(\d+)/);
			if (match && Number.parseInt(match[1] ?? '', 10) === remotePort) {
				return pid;
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** `ss -Htnp` によるピアPID特定（Linux主経路）。sport＝クライアント側ローカルポートで絞る。 */
async function resolvePeerPidViaSs(remotePort: number, ownPid: number): Promise<number | undefined> {
	try {
		const { stdout } = await execAsync(`ss -Htnp state established "( sport = :${remotePort} )" 2>/dev/null || true`, {
			timeout: EXEC_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		for (const line of stdout.trim().split('\n')) {
			// 出力例: `0 0 127.0.0.1:47285 127.0.0.1:9222 users:(("node",pid=123,fd=45))`
			for (const match of line.matchAll(/pid=(\d+)/g)) {
				const pid = Number.parseInt(match[1] ?? '', 10);
				if (Number.isFinite(pid) && pid > 0 && pid !== ownPid) {
					return pid;
				}
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** PowerShell `Get-NetTCPConnection` によるピアPID特定（Windows主経路）。 */
async function resolvePeerPidViaPowerShell(remotePort: number, ownPid: number): Promise<number | undefined> {
	try {
		const cmd = `powershell -NoProfile -NonInteractive -Command "(Get-NetTCPConnection -LocalPort ${remotePort} -State Established -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)"`;
		const { stdout } = await execAsync(cmd, { timeout: EXEC_TIMEOUT_MS * 2, maxBuffer: 1024 * 1024 });
		for (const line of stdout.trim().split(/\r?\n/)) {
			const pid = Number.parseInt(line.trim(), 10);
			if (Number.isFinite(pid) && pid > 0 && pid !== ownPid) {
				return pid;
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** `netstat -ano` パースによるピアPID特定（Windowsフォールバック）。 */
async function resolvePeerPidViaNetstat(remotePort: number, ownPid: number): Promise<number | undefined> {
	try {
		const { stdout } = await execAsync('netstat -ano -p TCP', { timeout: EXEC_TIMEOUT_MS * 2, maxBuffer: 4 * 1024 * 1024 });
		for (const line of stdout.split(/\r?\n/)) {
			const cols = line.trim().split(/\s+/);
			// 形式: `TCP 127.0.0.1:<localPort> 127.0.0.1:<remotePort> ESTABLISHED <pid>`
			if (cols.length < 5 || cols[0] !== 'TCP' || !/ESTABLISHED/i.test(cols[3] ?? '')) {
				continue;
			}
			const localPort = Number.parseInt((cols[1] ?? '').split(':').pop() ?? '', 10);
			if (localPort !== remotePort) {
				continue;
			}
			const pid = Number.parseInt(cols[4] ?? '', 10);
			if (Number.isFinite(pid) && pid > 0 && pid !== ownPid) {
				return pid;
			}
		}
		return undefined;
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

async function readPpid(pid: number): Promise<number | undefined> {
	if (process.platform === 'win32') {
		try {
			const cmd = `powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\" -ErrorAction SilentlyContinue).ParentProcessId"`;
			const { stdout } = await execAsync(cmd, { timeout: EXEC_TIMEOUT_MS * 2, maxBuffer: 1024 * 1024 });
			const ppid = Number.parseInt(stdout.trim(), 10);
			return Number.isFinite(ppid) && ppid > 0 ? ppid : undefined;
		} catch {
			return undefined;
		}
	}
	if (process.platform === 'linux') {
		try {
			// /proc/<pid>/stat の4フィールド目がppid（comm内の括弧を考慮して末尾から辿る）
			const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
			const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
			const ppid = Number.parseInt(afterComm.split(' ')[1] ?? '', 10);
			if (Number.isFinite(ppid) && ppid > 0) {
				return ppid;
			}
		} catch {
			// ps にフォールバック
		}
	}
	try {
		const { stdout } = await execAsync(`ps -o ppid= -p ${pid} 2>/dev/null || true`, { timeout: EXEC_TIMEOUT_MS });
		const ppid = Number.parseInt(stdout.trim(), 10);
		return Number.isFinite(ppid) && ppid > 0 ? ppid : undefined;
	} catch {
		return undefined;
	}
}
