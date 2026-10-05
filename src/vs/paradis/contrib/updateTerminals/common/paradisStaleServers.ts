/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先に残っている古い版の Para Code サーバーを見つけて、止めて、使っていない版のフォルダを
// 消す判断（純粋な部分）。実際に ps を読む・シグナルを送る・消すのは接続先のサーバー側
// （`node/paradisStaleServersService.ts`）で、手元のウィンドウは要求と結果だけを扱う。
//
// なぜ残るのか: 接続先のサーバーは `~/.para-code-server/bin/<commit>/` に版ごとに入り、版ごとに
// 別のプロセスとして動く。更新した後に繋ぐと新しい版が立ち上がり、前の版は残したターミナルを
// 抱えたまま、誰も繋がないまま猶予時間ぶん動き続ける（`paradisRemoteTerminalShutdown.ts`）。
//
// **止めてよいのは次をすべて満たすものだけ。** ここの関数はすべて、これを外したものしか返さない
// ように書き、テストで固定する。
//  - このユーザーのもの（ほかのユーザーのものには、どの段でも触らない）
//  - 今の版（自分自身とその木）ではない
//  - 今の版より**古い**版（`product.json` の `date` で比べる。分からなければ触らない）。
//    同じ接続先を別の PC が新しい版で使っていることがあるので、新しい版は止めない
//  - 今つながっているクライアントが無い（別の PC が古い版のまま使っているかもしれない。
//    確かめられない環境では触らない）

import { localize } from '../../../../nls.js';
import { paradisFormatUptime } from '../../ptyDaemon/common/paradisPtyDaemonStatus.js';

/** 接続先のサーバーが持つチャネル。古い REH には無い（`Unknown channel` で気づいて何もしない）。 */
export const PARADIS_STALE_SERVERS_CHANNEL = 'paradisStaleServers';

/** ps の1行。 */
export interface IParadisProcessRow {
	readonly pid: number;
	readonly ppid: number;
	readonly uid: number;
	/** 動いている時間（秒）。読めなければ undefined。 */
	readonly elapsedSeconds: number | undefined;
	/** 常駐メモリ（KiB）。 */
	readonly rssKb: number;
	readonly args: string;
}

/** このサーバーの置き場所と身元。 */
export interface IParadisServerLayout {
	/** `~/.para-code-server/bin`。版ごとのフォルダが並ぶ場所（ファイル操作はこの実体のパスで行う）。 */
	readonly binRoot: string;
	/**
	 * 同じ場所の別の書き方（シンボリックリンクを経た `~` など）。プロセスの引数はどちらで書かれて
	 * いるか分からないので、比べるときは全部を見る。
	 */
	readonly binRootAliases?: readonly string[];
	/** 今の版（このサーバー自身の commit）。 */
	readonly currentCommit: string;
	/** このサーバーを動かしているユーザー。 */
	readonly uid: number;
	/** このサーバーのプロセス。自分の木には絶対に触らないための目印。 */
	readonly selfPid: number;
}

/** 古い版のサーバー1つ。 */
export interface IParadisStaleServer {
	readonly commit: string;
	/** server-main の pid。 */
	readonly pid: number;
	readonly args: string;
	readonly elapsedSeconds: number | undefined;
	readonly terminalCount: number;
	readonly claudeCount: number;
	readonly codexCount: number;
	readonly rssBytes: number;
	/** 止める対象（server-main とその子孫。このユーザーのものだけ）。 */
	readonly pids: readonly number[];
}

/** 手元へ返す、見つけたものの要約。pid やパスは返さない（止めるときは接続先で探し直す）。 */
export interface IParadisStaleServerInfo {
	readonly commit: string;
	/** その版の `product.json` の version。読めなければ undefined。 */
	readonly version: string | undefined;
	readonly elapsedSeconds: number | undefined;
	readonly terminalCount: number;
	readonly claudeCount: number;
	readonly codexCount: number;
	readonly rssBytes: number;
}

export interface IParadisStaleServersScan {
	/** 版の置き場所が分からない（開発ビルドなど）ときは false。そのときは何も探さない。 */
	readonly supported: boolean;
	/** 止めてよいもの（{@link paradisJudgeStaleServer} が `stoppable`）だけ。 */
	readonly servers: readonly IParadisStaleServerInfo[];
	/** 今すぐ消せる、動いていない版のフォルダ。 */
	readonly removableDirCount: number;
	readonly removableBytes: number;
	/** 古い版のサーバーを止めた後に消せるようになるフォルダ。 */
	readonly removableAfterStopDirCount: number;
	readonly removableAfterStopBytes: number;
}

export interface IParadisStaleServersResult {
	/** 止めた server-main の数。 */
	readonly stoppedServers: number;
	/** TERM で止まらず KILL したプロセスの数。 */
	readonly forcedProcesses: number;
	readonly removedDirs: number;
	readonly freedBytes: number;
	/** 消せなかったフォルダの数。 */
	readonly failedDirs: number;
}

/** 手元から呼ぶ口。チャネルに出すのはこの2つだけ。 */
export interface IParadisStaleServersService {
	scan(): Promise<IParadisStaleServersScan>;
	/** 手元が通知に出した版（commit）だけを渡す。接続先で選び直した結果との積だけを止める。 */
	stopAndClean(commits: readonly string[]): Promise<IParadisStaleServersResult>;
}

/** 版のフォルダ名。commit の 40 桁。 */
const COMMIT_RE = /^[0-9a-f]{40}$/;

/** フォルダを置いたばかりのもの（別の接続が入れている最中）を消さないための猶予。 */
export const PARADIS_STALE_DIR_MIN_AGE_MS = 10 * 60 * 1000;

/** KILL の前の同一性確認で許す、開始時刻のずれ（etime は秒単位で、読む時刻もずれる）。 */
export const PARADIS_START_TIME_TOLERANCE_MS = 2_000;

/**
 * `ps -o etime=` の値（`[[dd-]hh:]mm:ss`）を秒にする。読めなければ undefined。
 */
export function paradisParseEtime(text: string): number | undefined {
	const match = /^\s*(?:(?<days>\d+)-)?(?:(?<hours>\d+):)?(?<minutes>\d+):(?<seconds>\d+)\s*$/.exec(text);
	if (!match?.groups) {
		return undefined;
	}
	const days = Number(match.groups.days ?? 0);
	const hours = Number(match.groups.hours ?? 0);
	const minutes = Number(match.groups.minutes);
	const seconds = Number(match.groups.seconds);
	return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/** `ps -A -ww -o pid=,ppid=,uid=,etime=,rss=,args=` の引数。`-ww` が無いと長い引数が切れる。 */
export const PARADIS_PS_ARGS: readonly string[] = ['-A', '-ww', '-o', 'pid=,ppid=,uid=,etime=,rss=,args='];

/**
 * `ps` の出力を読む。読めない行は捨てる。
 */
export function paradisParsePsOutput(stdout: string): IParadisProcessRow[] {
	const rows: IParadisProcessRow[] = [];
	for (const line of stdout.split('\n')) {
		const match = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<uid>\d+)\s+(?<etime>\S+)\s+(?<rss>\d+)\s+(?<args>.*)$/.exec(line);
		if (!match?.groups) {
			continue;
		}
		rows.push({
			pid: Number(match.groups.pid),
			ppid: Number(match.groups.ppid),
			uid: Number(match.groups.uid),
			elapsedSeconds: paradisParseEtime(match.groups.etime),
			rssKb: Number(match.groups.rss),
			args: match.groups.args.trim(),
		});
	}
	return rows;
}

function trimSlash(path: string): string {
	return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** 比べるときに見る置き場所の書き方すべて。 */
export function paradisBinRoots(layout: Pick<IParadisServerLayout, 'binRoot' | 'binRootAliases'>): string[] {
	return [...new Set([layout.binRoot, ...(layout.binRootAliases ?? [])].map(trimSlash))];
}

/**
 * その行の引数のどこかに `<binRoot>/<commit>/` があれば、その commit。
 *
 * 「その版のフォルダを使っているか」を広く拾うためのもの（フォルダを消してよいかの判断）。
 * サーバー本体かどうかの判断には {@link paradisServerMainCommit} を使う。
 */
export function paradisCommitOfArgs(args: string, binRoots: string | readonly string[]): string | undefined {
	for (const binRoot of typeof binRoots === 'string' ? [binRoots] : binRoots) {
		const root = `${trimSlash(binRoot)}/`;
		let from = 0;
		for (; ;) {
			const index = args.indexOf(root, from);
			if (index === -1) {
				break;
			}
			const match = /^(?<commit>[0-9a-f]{40})(?:\/|\s|$)/.exec(args.slice(index + root.length));
			if (match?.groups) {
				return match.groups.commit;
			}
			from = index + root.length;
		}
	}
	return undefined;
}

/**
 * サーバー本体（server-main）なら、その commit。
 *
 * 厳しく見る: 先頭が `<binRoot>/<commit>/node` で、次の引数が同じ版の `out/server-main.js` のときだけ。
 * そのファイルを `less` や `vim` で開いているだけのプロセスを、サーバーと取り違えないため。
 */
export function paradisServerMainCommit(args: string, binRoots: readonly string[]): string | undefined {
	const [executable, script] = args.split(/\s+/);
	if (executable === undefined || script === undefined) {
		return undefined;
	}
	for (const binRoot of binRoots) {
		const root = trimSlash(binRoot);
		if (!executable.startsWith(`${root}/`)) {
			continue;
		}
		const commit = executable.slice(root.length + 1, executable.length - '/node'.length);
		if (!COMMIT_RE.test(commit) || executable !== `${root}/${commit}/node`) {
			continue;
		}
		if (binRoots.some(other => script === `${trimSlash(other)}/${commit}/out/server-main.js`)) {
			return commit;
		}
	}
	return undefined;
}

/**
 * 更新をまたげる常駐（`reattachAcrossUpdates`）か。
 *
 * これは古い版の pty host から起こされるので親子関係では古いサーバーの子孫に見えるが、新しい版の
 * サーバーが繋ぎ直して使う。止めると、繋ぎ直せたはずのターミナルを失う。`bootstrap-fork` を
 * `--type=` なしで動かしているのは常駐だけ（pty host・拡張ホストなどは `--type=` を付ける）。
 */
function isAcrossUpdatesDaemon(row: IParadisProcessRow): boolean {
	return row.args.includes('bootstrap-fork') && !row.args.includes('--type=');
}

function isPtyHost(row: IParadisProcessRow): boolean {
	return row.args.includes('--type=ptyHost');
}

/** エージェントの CLI か。引数の先頭の方（実行ファイルと最初のスクリプト）で見る。 */
export function paradisAgentOfArgs(args: string): 'claude' | 'codex' | undefined {
	for (const token of args.split(/\s+/).slice(0, 3)) {
		const base = token.slice(token.lastIndexOf('/') + 1);
		if (base === 'claude') {
			return 'claude';
		}
		if (base === 'codex') {
			return 'codex';
		}
	}
	if (args.includes('/@anthropic-ai/claude-code/')) {
		return 'claude';
	}
	if (args.includes('/@openai/codex/')) {
		return 'codex';
	}
	return undefined;
}

function childrenIndex(rows: readonly IParadisProcessRow[]): Map<number, IParadisProcessRow[]> {
	const children = new Map<number, IParadisProcessRow[]>();
	for (const row of rows) {
		if (row.pid === row.ppid) {
			continue;
		}
		const list = children.get(row.ppid);
		if (list) {
			list.push(row);
		} else {
			children.set(row.ppid, [row]);
		}
	}
	return children;
}

/**
 * 自分自身（今の版の server-main）が ps に見えているか。
 *
 * 見えないなら、置き場所の書き方や起動のされ方がこちらの想定と違う。そのときは自分の木を正しく
 * 外せる保証が無いので、止めることも消すことも一切しない。
 */
export function paradisSelfServerFound(rows: readonly IParadisProcessRow[], layout: IParadisServerLayout): boolean {
	const roots = paradisBinRoots(layout);
	return rows.some(row => row.pid === layout.selfPid && paradisServerMainCommit(row.args, roots) === layout.currentCommit);
}

/**
 * このサーバー自身の木（自分の祖先と、自分を含む server-main の子孫すべて）。
 * 何があってもここには触らない。
 */
function ownTree(rows: readonly IParadisProcessRow[], layout: IParadisServerLayout, children: Map<number, IParadisProcessRow[]>): Set<number> {
	const roots = paradisBinRoots(layout);
	const byPid = new Map(rows.map(row => [row.pid, row]));
	const own = new Set<number>([layout.selfPid]);
	// 祖先をたどり、いちばん上の今の版の server-main を根にする（見つからなければ自分を根にする）。
	// 祖先そのもの（sshd・init など）も触らない側に入れるが、その子孫までは広げない。
	let root = layout.selfPid;
	let cursor = byPid.get(layout.selfPid);
	const seen = new Set<number>();
	while (cursor && !seen.has(cursor.pid)) {
		seen.add(cursor.pid);
		own.add(cursor.pid);
		if (paradisServerMainCommit(cursor.args, roots) === layout.currentCommit) {
			root = cursor.pid;
		}
		cursor = byPid.get(cursor.ppid);
	}
	const stack = [root];
	const visited = new Set<number>();
	while (stack.length > 0) {
		const pid = stack.pop()!;
		if (visited.has(pid)) {
			continue;
		}
		visited.add(pid);
		own.add(pid);
		for (const child of children.get(pid) ?? []) {
			stack.push(child.pid);
		}
	}
	return own;
}

/**
 * 今の版と違う版のサーバーを探す（まだ「止めてよい」かは決めない。{@link paradisJudgeStaleServer}）。
 *
 * 対象は「このユーザーの」server-main（{@link paradisServerMainCommit}）と、その子孫のうち同じ
 * ユーザーのものだけ。更新をまたげる常駐とその下は含めない。
 */
export function paradisFindStaleServers(rows: readonly IParadisProcessRow[], layout: IParadisServerLayout): IParadisStaleServer[] {
	const roots = paradisBinRoots(layout);
	const children = childrenIndex(rows);
	const own = ownTree(rows, layout, children);
	const servers: IParadisStaleServer[] = [];
	const claimed = new Set<number>();
	for (const row of rows) {
		if (row.uid !== layout.uid || own.has(row.pid) || claimed.has(row.pid)) {
			continue;
		}
		const commit = paradisServerMainCommit(row.args, roots);
		if (commit === undefined || commit === layout.currentCommit) {
			continue;
		}
		const pids: number[] = [];
		let rssKb = 0;
		let terminalCount = 0;
		let claudeCount = 0;
		let codexCount = 0;
		// 根から深さ優先でたどる。エージェントの下の子（MCP サーバーなど）は数えない。
		const stack: { row: IParadisProcessRow; underAgent: boolean; parentIsPtyHost: boolean }[] = [{ row, underAgent: false, parentIsPtyHost: false }];
		const visited = new Set<number>();
		while (stack.length > 0) {
			const { row: current, underAgent, parentIsPtyHost } = stack.pop()!;
			if (visited.has(current.pid) || own.has(current.pid) || current.uid !== layout.uid || isAcrossUpdatesDaemon(current)) {
				continue;
			}
			visited.add(current.pid);
			claimed.add(current.pid);
			pids.push(current.pid);
			rssKb += current.rssKb;
			if (parentIsPtyHost) {
				terminalCount++;
			}
			const agent = underAgent ? undefined : paradisAgentOfArgs(current.args);
			if (agent === 'claude') {
				claudeCount++;
			} else if (agent === 'codex') {
				codexCount++;
			}
			const ptyHost = isPtyHost(current);
			for (const child of children.get(current.pid) ?? []) {
				stack.push({ row: child, underAgent: underAgent || agent !== undefined, parentIsPtyHost: ptyHost });
			}
		}
		servers.push({ commit, pid: row.pid, args: row.args, elapsedSeconds: row.elapsedSeconds, terminalCount, claudeCount, codexCount, rssBytes: rssKb * 1024, pids });
	}
	return servers;
}

/** 止めてよいか。`stoppable` 以外は触らない。 */
export type ParadisStaleServerVerdict = 'stoppable' | 'not-older' | 'connected' | 'connection-unknown';

export interface IParadisStaleServerJudgeInput {
	/** そのサーバーの版の `product.json` の `date`。 */
	readonly productDate: string | undefined;
	/** 今の版の `product.json` の `date`。 */
	readonly currentProductDate: string | undefined;
	readonly serverPid: number;
	readonly serverArgs: string;
	/** その機械の TCP の様子（`ss`）。調べられない環境なら undefined。 */
	readonly tcp: IParadisTcpState | undefined;
}

/** `ss` から読んだ TCP の様子。 */
export interface IParadisTcpState {
	/** pid ごとの待ち受けポート（`ss -Htlnp`）。 */
	readonly listeningPorts: ReadonlyMap<number, ReadonlySet<number>>;
	/** 確立している接続の、こちら側のポートと持ち主（`ss -Htnp state established`）。 */
	readonly established: readonly { readonly pid: number; readonly localPort: number }[];
}

/**
 * 止めてよいかを決める。
 *
 * - 今の版より古いと `date` で言えるものだけ（新しい版・同じ時刻・分からないものは触らない）。
 *   同じ接続先を、先に更新した別の PC が新しい版で使っていることがある
 * - 今つながっているクライアントが無いと言えるものだけ。クライアント（SSH のポート転送）は
 *   server-main の待ち受けポートへ繋ぐので、**こちら側のポートが待ち受けポートと同じ**
 *   ESTABLISHED の接続があれば使われている。server-main が自分から外へ出ていく接続（実測で
 *   残っているものがあった）はクライアントの有無と関係ないので数えない
 * - 調べられない環境・待ち受けポートが取れないサーバー・ソケットファイルで待ち受けるサーバー
 *   （`--socket-path`。TCP を見ても分からない）は、使われているかもしれないので触らない
 */
export function paradisJudgeStaleServer(input: IParadisStaleServerJudgeInput): ParadisStaleServerVerdict {
	if (!paradisIsOlderBuildDate(input.productDate, input.currentProductDate)) {
		return 'not-older';
	}
	if (input.tcp === undefined || input.serverArgs.includes('--socket-path')) {
		return 'connection-unknown';
	}
	const ports = input.tcp.listeningPorts.get(input.serverPid);
	if (ports === undefined || ports.size === 0) {
		return 'connection-unknown';
	}
	const inbound = input.tcp.established.some(connection => connection.pid === input.serverPid && ports.has(connection.localPort));
	return inbound ? 'connected' : 'stoppable';
}

/**
 * `ss` の1行から、こちら側のポートと持ち主の pid を読む。
 *
 * 形は `[State] Recv-Q Send-Q Local:Port Peer:Port users:(("node",pid=1234,fd=23),...)`。
 * `-Htlnp` には先頭に State（`LISTEN`）が付き、`state established` を付けると付かない。どちらでも
 * 「`:ポート` で終わる最初の欄」をこちら側として読む（IPv6 の `[::1]:40805` も同じ）。
 */
function paradisParseSsLine(line: string): { readonly localPort: number; readonly pids: number[] } | undefined {
	const local = line.split(/\s+/).find(field => /:(\d+|\*)$/.test(field));
	const port = local !== undefined ? Number(/:(?<port>\d+)$/.exec(local)?.groups?.port) : NaN;
	if (!isFinite(port)) {
		return undefined;
	}
	const pids = [...line.matchAll(/pid=(?<pid>\d+)/g)].map(match => Number(match.groups!.pid));
	return pids.length > 0 ? { localPort: port, pids } : undefined;
}

/** `ss -Htlnp` の出力から、pid ごとの待ち受けポートを読む。 */
export function paradisParseListeningPorts(stdout: string): Map<number, Set<number>> {
	const ports = new Map<number, Set<number>>();
	for (const line of stdout.split('\n')) {
		const parsed = paradisParseSsLine(line);
		for (const pid of parsed?.pids ?? []) {
			let set = ports.get(pid);
			if (!set) {
				set = new Set();
				ports.set(pid, set);
			}
			set.add(parsed!.localPort);
		}
	}
	return ports;
}

/** `ss -Htnp state established` の出力から、確立している接続のこちら側のポートと持ち主を読む。 */
export function paradisParseEstablishedConnections(stdout: string): { pid: number; localPort: number }[] {
	const connections: { pid: number; localPort: number }[] = [];
	for (const line of stdout.split('\n')) {
		const parsed = paradisParseSsLine(line);
		for (const pid of parsed?.pids ?? []) {
			connections.push({ pid, localPort: parsed!.localPort });
		}
	}
	return connections;
}

/**
 * 実際に止める版。手元が通知に出した版と、接続先でいま選び直した版の積。
 * 手元から pid やパスは受け取らない。
 */
export function paradisCommitsToStop(requested: readonly string[], stoppable: readonly string[]): string[] {
	const wanted = new Set(requested.filter(commit => typeof commit === 'string' && COMMIT_RE.test(commit)));
	return [...new Set(stoppable)].filter(commit => wanted.has(commit));
}

/** 止める前に控えておく、1つのプロセスの見分け方。 */
export interface IParadisStopTarget {
	readonly pid: number;
	readonly args: string;
	/** 始まった時刻（ps の etime から求めたもの）。分からなければ undefined。 */
	readonly startedAtMs: number | undefined;
}

/** 行から始まった時刻を求める。 */
export function paradisStartedAt(row: IParadisProcessRow, now: number): number | undefined {
	return row.elapsedSeconds === undefined ? undefined : now - row.elapsedSeconds * 1000;
}

/**
 * TERM を送った後、まだ残っているもの（KILL する対象）。
 *
 * pid は使い回されることがあるので、同じ pid でも**同じユーザー・同じ引数・同じ開始時刻**のものだけを
 * 「まだ残っている」とみなす。違うものに替わっていたら、あるいは開始時刻が分からなければ触らない。
 */
export function paradisRemainingTargets(targets: readonly IParadisStopTarget[], rows: readonly IParadisProcessRow[], uid: number, now: number): number[] {
	const byPid = new Map(rows.map(row => [row.pid, row]));
	return targets.filter(target => {
		const row = byPid.get(target.pid);
		if (row === undefined || row.uid !== uid || row.args !== target.args) {
			return false;
		}
		const startedAt = paradisStartedAt(row, now);
		return target.startedAtMs !== undefined && startedAt !== undefined
			&& Math.abs(startedAt - target.startedAtMs) <= PARADIS_START_TIME_TOLERANCE_MS;
	}).map(target => target.pid);
}

/** `bin` の下の1項目。 */
export interface IParadisServerDirEntry {
	readonly name: string;
	readonly isDirectory: boolean;
	readonly mtimeMs: number;
}

/**
 * 消してよい版のフォルダを選ぶ。
 *
 * - 名前が commit（40 桁の16進）のフォルダだけ。ほかの物（ログ・ダウンロード途中のファイル）は触らない
 * - 今の版は消さない
 * - どのユーザーのどのプロセスでも、引数にそのフォルダの下のパスがあれば消さない
 * - 実行ファイル（Linux の `/proc/<pid>/exe`）がそのフォルダの下にあれば消さない。調べられなければ
 *   引数だけで判断する
 * - 置いたばかり（{@link PARADIS_STALE_DIR_MIN_AGE_MS} 以内）のものは消さない（別の接続が入れている最中かもしれない）
 */
export function paradisSelectRemovableServerDirs(
	entries: readonly IParadisServerDirEntry[],
	rows: readonly IParadisProcessRow[],
	layout: Pick<IParadisServerLayout, 'binRoot' | 'binRootAliases' | 'currentCommit'>,
	now: number,
	executables?: readonly string[],
): string[] {
	const roots = paradisBinRoots(layout);
	const inUse = new Set<string>();
	for (const row of rows) {
		const commit = paradisCommitOfArgs(row.args, roots);
		if (commit !== undefined) {
			inUse.add(commit);
		}
	}
	for (const executable of executables ?? []) {
		const commit = paradisCommitOfArgs(executable, roots);
		if (commit !== undefined) {
			inUse.add(commit);
		}
	}
	return entries
		.filter(entry => entry.isDirectory
			&& COMMIT_RE.test(entry.name)
			&& entry.name !== layout.currentCommit
			&& !inUse.has(entry.name)
			&& now - entry.mtimeMs >= PARADIS_STALE_DIR_MIN_AGE_MS)
		.map(entry => entry.name);
}

/**
 * `product.json` の `date` で、その版が今の版より古いと言えるか。どちらかが読めなければ false。
 * 同じ接続先を別の PC が先に新しい版で使っていることがあるので、新しい版には止めるのも消すのも
 * 手を出さない。
 */
export function paradisIsOlderBuildDate(date: string | undefined, currentDate: string | undefined): boolean {
	const value = date !== undefined ? Date.parse(date) : NaN;
	const current = currentDate !== undefined ? Date.parse(currentDate) : NaN;
	return isFinite(value) && isFinite(current) && value < current;
}

/** 消してよいフォルダのうち、`date` で今の版より古いと言えるものだけ（読めなければ消さない）。 */
export function paradisOnlyOlderBuilds(names: readonly string[], dates: ReadonlyMap<string, string | undefined>, currentDate: string | undefined): string[] {
	return names.filter(name => paradisIsOlderBuildDate(dates.get(name), currentDate));
}

/** 前の掃除で消しきれずに残った退避フォルダの名前か（{@link paradisRemovingDirName} の形）。 */
const REMOVING_DIR_RE = /^\.paradis-removing-[0-9a-f]{40}-\d+$/;

/** 前の掃除で取り残された退避フォルダ。ディレクトリ（lstat で見たもの）だけ。 */
export function paradisSelectLeftoverRemovingDirs(entries: readonly IParadisServerDirEntry[]): string[] {
	return entries.filter(entry => entry.isDirectory && REMOVING_DIR_RE.test(entry.name)).map(entry => entry.name);
}

/** 消す前に退避する名前。リネームしてから消すので、消している途中のフォルダが版として見えない。 */
export function paradisRemovingDirName(commit: string, now: number): string {
	return `.paradis-removing-${commit}-${now}`;
}

/**
 * 版の置き場所を、このサーバーの置き場所（appRoot）から決める。
 *
 * `<binRoot>/<commit>` の形でなければ（開発ビルド・別の置き方）undefined を返し、何も探さない。
 */
export function paradisServerBinRoot(appRoot: string, currentCommit: string | undefined): string | undefined {
	if (!currentCommit || !COMMIT_RE.test(currentCommit)) {
		return undefined;
	}
	const trimmed = trimSlash(appRoot);
	const index = trimmed.lastIndexOf('/');
	if (index <= 0 || trimmed.slice(index + 1) !== currentCommit) {
		return undefined;
	}
	const binRoot = trimmed.slice(0, index);
	return binRoot.slice(binRoot.lastIndexOf('/') + 1) === 'bin' ? binRoot : undefined;
}

// --- 手元のお知らせ ---------------------------------------------------------------------------------

export type ParadisStaleServerNoticePlan = 'staleServers' | 'stranded' | 'none';

/**
 * 繋いだときに何を知らせるか。
 *
 * 止めてよい古い版のサーバーが動いていれば、そちらのお知らせ（止められる）にまとめる。前の版で
 * 残したターミナルのお知らせ（`paradisShouldReportStrandedTerminals`）は、その中身を含むので重ねて
 * 出さない。止めてよいものが無ければ、今までどおり「開けません」だけを伝える。
 */
export function paradisPlanStaleServerNotice(input: { readonly staleServerCount: number; readonly strandedShouldReport: boolean }): ParadisStaleServerNoticePlan {
	if (input.staleServerCount > 0) {
		return 'staleServers';
	}
	return input.strandedShouldReport ? 'stranded' : 'none';
}

/** 大きさの表し方。GB 以上は1桁、それ未満は MB の整数。 */
export function paradisFormatBytes(bytes: number): string {
	if (!(bytes > 0)) {
		return '0MB';
	}
	const gigabytes = bytes / (1024 * 1024 * 1024);
	if (gigabytes >= 1) {
		return `${gigabytes >= 10 ? Math.round(gigabytes) : Math.round(gigabytes * 10) / 10}GB`;
	}
	return `${Math.max(1, Math.round(bytes / (1024 * 1024)))}MB`;
}

/** 版の名前。version があればそれと commit の頭、無ければ commit の頭だけ。 */
export function paradisStaleServerVersionLabel(server: Pick<IParadisStaleServerInfo, 'commit' | 'version'>): string {
	const short = server.commit.slice(0, 8);
	return server.version ? `${server.version} (${short})` : short;
}

/** お知らせの本文。 */
export function paradisStaleServerMessage(hostLabel: string, scan: IParadisStaleServersScan): string {
	const servers = scan.servers;
	const terminals = servers.reduce((sum, server) => sum + server.terminalCount, 0);
	const claude = servers.reduce((sum, server) => sum + server.claudeCount, 0);
	const codex = servers.reduce((sum, server) => sum + server.codexCount, 0);
	const memory = paradisFormatBytes(servers.reduce((sum, server) => sum + server.rssBytes, 0));
	const longest = servers.reduce<number | undefined>((max, server) => server.elapsedSeconds !== undefined && (max === undefined || server.elapsedSeconds > max) ? server.elapsedSeconds : max, undefined);
	const uptime = longest !== undefined ? paradisFormatUptime(longest * 1000) : localize('paradis.staleServers.uptimeUnknown', "しばらく");
	const agents = claude + codex > 0
		? localize('paradis.staleServers.agents', "（Claude {0}・Codex {1} を含む）", claude, codex)
		: '';
	const head = servers.length === 1
		? localize('paradis.staleServers.one', "{0} で古い版 {1} のサーバーが {2} 動いています。", hostLabel, paradisStaleServerVersionLabel(servers[0]), uptime)
		: localize('paradis.staleServers.many', "{0} で古い版のサーバーが {1} 個動いています（長いものは {2}）。", hostLabel, servers.length, uptime);
	// 「この版からは開けない」とだけ言うと、別の PC の古い版からは開けることを隠してしまう。
	const body = localize('paradis.staleServers.body', "ターミナル {0} 個{1}とメモリ約 {2} を使っています。今つながっているクライアントは無く、今の版の Para Code からは開けません。ただし、スリープ中などで一時的に切れている別の PC のものかもしれません（まだ更新していない別の PC からなら開けることがあります）。", terminals, agents, memory);
	const warn = localize('paradis.staleServers.warn', "止めると、その版のターミナルで動いているもの（nohup で残した処理を含む）もすべて止まります。");
	const dirs = scan.removableDirCount + scan.removableAfterStopDirCount;
	const bytes = scan.removableBytes + scan.removableAfterStopBytes;
	const tail = dirs > 0
		? localize('paradis.staleServers.dirs', "使っていない版のフォルダ {0} 個（{1}）も消せます。", dirs, paradisFormatBytes(bytes))
		: '';
	return [head, body, warn, tail].filter(part => part.length > 0).join(' ');
}

/** 止めた後の結果の本文。 */
export function paradisStaleServerResultMessage(hostLabel: string, result: IParadisStaleServersResult): string {
	const parts = [
		localize('paradis.staleServers.result.stopped', "{0} で古い版のサーバーを {1} 個止めました。", hostLabel, result.stoppedServers),
	];
	if (result.removedDirs > 0) {
		parts.push(localize('paradis.staleServers.result.removed', "使っていない版のフォルダ {0} 個（{1}）を消しました。", result.removedDirs, paradisFormatBytes(result.freedBytes)));
	}
	if (result.failedDirs > 0) {
		parts.push(localize('paradis.staleServers.result.failed', "{0} 個のフォルダは消せませんでした。", result.failedDirs));
	}
	return parts.join(' ');
}
