/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 動作中のエージェントの対話から検出した GitHub Issue の共通型・抽出ユーティリティ。
// 依存ゼロの純粋関数のみで、workspaceSwitch (gh CLI 解決: paradisWorktreeGitChannel.ts) と
// mobileRelay (対話ログの tailer: paradisMobileAgentChat.ts) の複数 contrib から参照するため
// 特定の contrib の下ではなく src/vs/paradis/common/ に置く。

/** GitHub Issue の状態。GitHub の表示色に対応する2値 (PR と異なり draft/merged は無い)。 */
export type ParadisIssueState = 'open' | 'closed';

/** `gh issue view` の抜粋。番号ごとに解決した後の要約。 */
export interface IParadisIssueStatus {
	readonly number: number;
	readonly title: string;
	readonly url: string;
	readonly state: ParadisIssueState;
}

/**
 * Issue URL の一括解決結果。`resolved` は成功した分だけ、`attempted` は成功・失敗を問わず
 * 実際に gh へ問い合わせた URL 全部 (呼び出し側の上限で弾かれた分は含まない)。
 *
 * 呼び出し側 (paradisWorkspacesView.ts) が「まだ結果が来ていない」と「試みたが解決できなかった」
 * を区別するために `attempted` が要る。複数 worktree ぶんの URL がホスト単位で1回に集約されて
 * 送られるため、呼び出し側は自分が送った URL 数と実際に処理された数が一致するとは限らない
 * (1回の呼び出しあたりの上限で追加分が弾かれることがある) — `attempted` はその実際の内訳を
 * 呼び出し側へ返す唯一の手段になる。
 */
export interface IParadisIssueStatusesResult {
	readonly resolved: Record<string, IParadisIssueStatus>;
	readonly attempted: readonly string[];
}

/**
 * `https://github.com/{owner}/{repo}/issues/{number}` 形式の URL にマッチする (抽出用、global)。
 * **exec/test を直接呼ばないこと** — global 正規表現は呼ぶたびに lastIndex が進み、次回の
 * matchAll がその位置から再開してしまう (String.prototype[Symbol.matchAll] はクローンを
 * 作る際に元の lastIndex を引き継ぐため)。1行に複数URLがあると2回目以降の抽出で行頭側の
 * URL を取りこぼす形で壊れ、しかも例外を投げないので気づきにくい。抽出は必ず
 * {@link paradisExtractIssueUrls} 経由、単発の解析は下の非global な
 * {@link GITHUB_ISSUE_URL_PARSE_RE} を使う (このファイル内で完結させ、外へは export しない)。
 */
const GITHUB_ISSUE_URL_EXTRACT_RE = /https:\/\/github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/issues\/(\d{1,9})(?!\d)/g;

/** 単発解析用 (非global、完全一致)。lastIndexを持ち越さないため exec のたびに独立して動く。 */
const GITHUB_ISSUE_URL_PARSE_RE = /^https:\/\/github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/issues\/(\d{1,9})(?!\d)$/;

/**
 * テキストから GitHub Issue の URL を抽出する (重複除去、出現順)。
 * エージェントの対話ログの1行 (ユーザーの発言・ツール入出力) に対してそのまま呼べる。
 */
export function paradisExtractIssueUrls(text: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const match of text.matchAll(GITHUB_ISSUE_URL_EXTRACT_RE)) {
		const url = match[0];
		if (!seen.has(url)) {
			seen.add(url);
			result.push(url);
		}
	}
	return result;
}

/** Issue URL を owner/repo/number に分解する。マッチしなければ undefined。 */
export function paradisParseIssueUrl(url: string): { owner: string; repo: string; number: number } | undefined {
	const match = GITHUB_ISSUE_URL_PARSE_RE.exec(url);
	if (!match) {
		return undefined;
	}
	return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/**
 * `gh issue view <number> --repo <owner/repo> --json number,title,url,state` の stdout を
 * IParadisIssueStatus へ変換する。paradisParseGhPrStatus (paradisWorktreeCreate.ts) と対の関数。
 */
export function paradisParseGhIssueStatus(stdout: string): IParadisIssueStatus | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const issue = raw as { number?: unknown; title?: unknown; url?: unknown; state?: unknown };
	if (typeof issue.number !== 'number' || typeof issue.url !== 'string' || typeof issue.state !== 'string') {
		return undefined;
	}
	// url は gh (GitHub API) の応答由来でクリック時に openerService へ渡すため、プロトコル
	// ハンドラ系スキーム (file:/vscode: 等) が紛れ込まないよう https/http に限定する
	if (!/^https?:\/\//.test(issue.url)) {
		return undefined;
	}
	let state: ParadisIssueState;
	switch (issue.state) {
		case 'OPEN': state = 'open'; break;
		case 'CLOSED': state = 'closed'; break;
		default: return undefined;
	}
	return { number: issue.number, title: typeof issue.title === 'string' ? issue.title : '', url: issue.url, state };
}

/** {@link paradisSelectIssueLookupBatch} への1入力 (1スペースぶんの検出済み Issue URL)。 */
export interface IParadisIssueLookupTarget<TResource> {
	readonly resource: TResource;
	readonly issueUrls: readonly string[];
}

/**
 * 複数 target (worktree) の検出済み Issue URL から、次にサーバーへ送るバッチを選ぶ。
 *
 * **必ず全 target を横断した合計で `budget` 件に絞ってから target ごとへ再分配すること**
 * (target ごとに個別へ `budget` 件を割り当ててはいけない)。呼び出し側 (paradisWorktreeGitChannel.ts
 * の getIssueStatuses) はホスト単位で複数 target ぶんの URL を1回の gh 呼び出しへ集約したうえで
 * 同じ `budget` 件に丸めるため、分母を揃えないと「target ごとに budget 件 = 実際にはホスト全体で
 * target数倍の予算を要求している」ことになる。すると target が複数かつ合計が budget を超える
 * 構成 (例: 3スペースが4件ずつ = 合計12件、budget=8) で、先行 target が予算を食い切り、
 * 後続 target の URL が一度もサーバーへ送られない状態が固定化し、
 * 呼び出し側の「未送信の Issue がある」判定が恒久的に真のまま残ってしまう
 * (即時ポーリングが無限に再発火し、gh 連続 spawn でレート枠を枯渇させた実測不具合の再発)。
 *
 * `attempted` (サーバーが実際に gh へ問い合わせ済みと確認した URL) を優先度にのみ使う。
 * まだ一度も試みていない URL を先に選ぶことで、会話が長引いて件数が budget を超えても、
 * 直近に検出した分から遅れて解決されていく。ループ防止の判定 (「送ったかどうか」) はこの
 * 関数の呼び出し側が別に持つ台帳 (_issueLookupRequested 等) で行うこと — この関数は
 * 「今回どれを送るか」を選ぶだけで、「送った」の記録自体は行わない (純関数のため副作用を持たない)。
 */
export function paradisSelectIssueLookupBatch<TResource>(
	targets: readonly IParadisIssueLookupTarget<TResource>[],
	attempted: ReadonlySet<string>,
	budget: number,
): IParadisIssueLookupTarget<TResource>[] {
	const flattened = targets.flatMap(target => target.issueUrls.map(url => ({ resource: target.resource, url })));
	const prioritized = [...flattened].sort((a, b) => Number(attempted.has(a.url)) - Number(attempted.has(b.url)));
	const selected = prioritized.slice(0, Math.max(0, budget));
	const byResource = new Map<TResource, string[]>();
	for (const item of selected) {
		const list = byResource.get(item.resource);
		if (list) {
			list.push(item.url);
		} else {
			byResource.set(item.resource, [item.url]);
		}
	}
	return [...byResource.entries()].map(([resource, issueUrls]) => ({ resource, issueUrls }));
}
