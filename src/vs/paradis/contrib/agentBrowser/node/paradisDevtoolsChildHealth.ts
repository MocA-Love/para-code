/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵 chrome-devtools-mcp の子プロセスの健康（メモリ・寿命）を見て、溜まりすぎる前に作り直すための部品。
//   - 子プロセスは使い続ける限り作り直されず、3 時間余りで V8 のヒープの上限（Electron の Node で約 4 GiB、
//     pointer compression のため `--max-old-space-size` を上げても増えない）に達して落ちた（Sentry JY / J8）
//   - 作り直すのは、応答待ちの呼び出しが無く、しばらく呼ばれていない合間だけ（paradisDevtoolsMcpProxy.ts）
//   - 作り直すと、take_snapshot の uid・コンソールとネットワークの記録は新しい子プロセスに引き継がれない。
//     タブ・ページ・ログイン状態は Para Code の内蔵ブラウザ側にあり、子プロセスは CDP ゲートウェイの接続を
//     切るだけなので失われない（Browser.close / Target.closeTarget はゲートウェイが常に断る）
//   - 標準エラーは秘密を含みうるので、V8 が落ちるときに書く行から数値と固定の語だけを抜く

import { execFile } from 'child_process';

/** 作り直しの目安。どれか 1 つを超えたら、次の合間に作り直す。 */
export interface IParadisDevtoolsRecycleLimits {
	/** 子プロセスの RSS（MiB）。ヒープの上限（約 4 GiB）より十分手前にする。 */
	readonly rssMib: number;
	/** 起動してからの時間（ミリ秒）。 */
	readonly ageMs: number;
	/** 受けたツール呼び出しの回数。 */
	readonly calls: number;
}

export const PARADIS_DEVTOOLS_RECYCLE_LIMITS: IParadisDevtoolsRecycleLimits = {
	rssMib: 1536,
	ageMs: 2 * 60 * 60_000,
	calls: 5000,
};

/** 作り直してよい合間（最後の呼び出しが終わってからの時間）。 */
export const PARADIS_DEVTOOLS_RECYCLE_QUIET_MS = 30_000;

/** RSS を測る間隔。作り直すかどうかもこの間隔で確かめる。 */
export const PARADIS_DEVTOOLS_HEALTH_INTERVAL_MS = 60_000;

/** 作り直す理由（Sentry へは固定の語だけを送る）。 */
export type ParadisDevtoolsRecycleReason = 'memory' | 'age' | 'calls';

/** 子プロセスの今の様子。 */
export interface IParadisDevtoolsChildStats {
	readonly rssMib: number | undefined;
	readonly ageMs: number;
	readonly calls: number;
}

/** 作り直すべきなら理由を返す（メモリを最優先。記録が大きくなったときに寄せるため）。 */
export function paradisDevtoolsRecycleReason(stats: IParadisDevtoolsChildStats, limits: IParadisDevtoolsRecycleLimits = PARADIS_DEVTOOLS_RECYCLE_LIMITS): ParadisDevtoolsRecycleReason | undefined {
	if (stats.rssMib !== undefined && stats.rssMib >= limits.rssMib) {
		return 'memory';
	}
	if (stats.ageMs >= limits.ageMs) {
		return 'age';
	}
	if (stats.calls >= limits.calls) {
		return 'calls';
	}
	return undefined;
}

/** V8 が落ちるときに標準エラーへ書いた行から抜いた値（数値と固定の語だけ）。 */
export interface IParadisV8FatalSummary {
	readonly kind: 'heap-limit' | 'ineffective-mark-compacts' | 'out-of-memory';
	/** 最後の GC の前後で使っていたヒープ（MiB）。GC の行が無ければ無い。 */
	readonly heapBeforeMib?: number;
	readonly heapAfterMib?: number;
}

/**
 * 標準エラーの末尾から、V8 のメモリ不足の行を読む。V8 の書き方は次のとおり:
 * `[71190:0x...]  11921000 ms: Mark-Compact 4049.2 (4130.5) -> 4033.1 (4131.0) MB, ...` と
 * `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`。
 * メモリ不足でなければ undefined。
 */
export function paradisParseV8FatalStderr(text: string): IParadisV8FatalSummary | undefined {
	let kind: IParadisV8FatalSummary['kind'];
	if (/Reached heap limit/.test(text)) {
		kind = 'heap-limit';
	} else if (/Ineffective mark-compacts near heap limit/.test(text)) {
		kind = 'ineffective-mark-compacts';
	} else if (/FATAL ERROR:[^\n]*out of memory|JavaScript heap out of memory/i.test(text)) {
		kind = 'out-of-memory';
	} else {
		return undefined;
	}
	let last: RegExpExecArray | undefined;
	const gcLine = /(?:Mark-Compact|Scavenge|Mark-sweep)[^\n]*?\s(?<before>\d+(?:\.\d+)?)\s\(\d+(?:\.\d+)?\)\s->\s(?<after>\d+(?:\.\d+)?)\s\(\d+(?:\.\d+)?\)\sMB/g;
	for (let match = gcLine.exec(text); match !== null; match = gcLine.exec(text)) {
		last = match;
	}
	if (!last?.groups) {
		return { kind };
	}
	return { kind, heapBeforeMib: Math.round(Number(last.groups.before)), heapAfterMib: Math.round(Number(last.groups.after)) };
}

/** 標準エラーの末尾として残す最大の文字数（V8 の最後の数行が入れば足りる）。 */
const STDERR_TAIL_CHARS = 16 * 1024;

/** 標準エラーの末尾を、上限の文字数まで足す。 */
export function paradisAppendStderrTail(tail: string, chunk: string): string {
	const joined = tail + chunk;
	return joined.length > STDERR_TAIL_CHARS ? joined.slice(joined.length - STDERR_TAIL_CHARS) : joined;
}

/** uid を受けるツールの引数名（click の `uid`、drag の `from_uid` / `to_uid`、fill_form の `elements[].uid` など）。 */
const UID_ARGUMENT_KEYS = new Set(['uid', 'from_uid', 'to_uid']);

/** 引数のどこかに take_snapshot の uid が入っているか（3 段まで見る）。 */
export function paradisDevtoolsArgsCarryUid(args: unknown, depth = 0): boolean {
	if (depth > 3 || typeof args !== 'object' || args === null) {
		return false;
	}
	if (Array.isArray(args)) {
		return args.some(item => paradisDevtoolsArgsCarryUid(item, depth + 1));
	}
	for (const [key, value] of Object.entries(args)) {
		if (UID_ARGUMENT_KEYS.has(key) && typeof value === 'string' && value.length > 0) {
			return true;
		}
		if (typeof value === 'object' && paradisDevtoolsArgsCarryUid(value, depth + 1)) {
			return true;
		}
	}
	return false;
}

/** 子プロセスを入れ替えた理由（エージェントへの案内の言い方を変える）。 */
export type ParadisDevtoolsReplacedReason = 'recycled' | 'exited' | 'idle';

function describeReplacement(reason: ParadisDevtoolsReplacedReason): string {
	switch (reason) {
		case 'recycled': return 'Para Code restarted its embedded DevTools bridge to free memory';
		case 'exited': return 'Para Code\'s embedded DevTools bridge stopped and was started again';
		case 'idle': return 'Para Code\'s embedded DevTools bridge was stopped while unused and started again';
	}
}

/** 入れ替えの後、新しい take_snapshot の前に uid を使う呼び出しへ返す文。子プロセスへは渡さない。 */
export function paradisDevtoolsStaleUidMessage(reason: ParadisDevtoolsReplacedReason): string {
	return `PARA_BROWSER_STALE_UID: ${describeReplacement(reason)}, so the element uids from your earlier take_snapshot are no longer valid. The page, its tabs and the login state are unchanged. Call take_snapshot again and use the new uids.`;
}

/** 記録を読むツール（入れ替えの前の記録は新しい子プロセスに無い）。 */
const RECORD_TOOLS: ReadonlySet<string> = new Set(['list_console_messages', 'get_console_message', 'list_network_requests', 'get_network_request']);

/** 入れ替えの後に記録を読むツールか。 */
export function paradisDevtoolsReadsRecords(name: string): boolean {
	return RECORD_TOOLS.has(name);
}

/** 入れ替えの後、最初に記録を読んだ結果へ 1 行添える文。 */
export function paradisDevtoolsRecordsResetNote(reason: ParadisDevtoolsReplacedReason): string {
	return `Note: ${describeReplacement(reason)}; console messages and network requests from before that are no longer listed, and settings made with emulate are reset. The page itself is unchanged.`;
}

/** RSS を読むときの待ち時間の上限。 */
const RSS_READ_TIMEOUT_MS = 5_000;

/**
 * 子プロセスの RSS（MiB）を `ps` で読む（macOS / Linux）。Windows や読めないときは undefined。
 * @param run テスト用の差し替え（既定は `ps -o rss= -p <pid>`）。
 */
export function paradisReadProcessRssMib(pid: number | undefined, platform: NodeJS.Platform = process.platform, run: (pid: number) => Promise<string> = runPs): Promise<number | undefined> {
	if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0 || platform === 'win32') {
		return Promise.resolve(undefined);
	}
	return run(pid).then(stdout => {
		const kib = Number.parseInt(stdout.trim(), 10);
		return Number.isSafeInteger(kib) && kib > 0 ? Math.round(kib / 1024) : undefined;
	}, () => undefined);
}

function runPs(pid: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: RSS_READ_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
			if (error) {
				reject(error);
			} else {
				resolve(String(stdout));
			}
		});
	});
}
