/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * スマホのプルリクエストの画面（Orca W2-36）で PC とアプリが同じ答えを出すべき判定と、`gh` の出力の読み方。
 *
 * **このファイルは import を持たない。** アプリ（`app/mobile`）が相対パスで直接 import する（Metro の `.js` → `.ts` の
 * 読み替えはアプリ自身のコードからの import にしか効かないので、ここから別のファイルを import するとアプリで解決できない）。
 * アプリの tsconfig は `noUncheckedIndexedAccess` が有効。依頼文の組み立て（PC だけが使う）は `paradisMobileAgentPrompts.ts`。
 */

/** `prView`（PR の状態と CI のチェック）と `prFixChecks`（失敗したチェックをエージェントに直してもらう）を受ける。 */
export const PARADIS_MOBILE_PR_VIEW_CAPABILITY = 'pr.view.v1';
/** `prMerge`（見た時点の head に固定してマージ）を受ける。 */
export const PARADIS_MOBILE_PR_MERGE_CAPABILITY = 'pr.merge.v1';

/** チェックの区分（`gh pr checks` の bucket と同じ語）。 */
export type ParadisPullRequestCheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';

export interface IParadisPullRequestCheck {
	readonly name: string;
	readonly workflow?: string;
	readonly bucket: ParadisPullRequestCheckBucket;
	/** GitHub 上の詳細（https のみ）。 */
	readonly url?: string;
	/** GitHub Actions のジョブなら、ログを取るためのジョブの id と、`gh -R` に渡すリポジトリ（`owner/repo` か `host/owner/repo`）。 */
	readonly jobId?: string;
	readonly repo?: string;
}

export type ParadisPullRequestState = 'open' | 'draft' | 'merged' | 'closed';

export interface IParadisPullRequestDetail {
	readonly number: number;
	readonly title: string;
	readonly url: string;
	readonly state: ParadisPullRequestState;
	/** `gh -R` に渡すリポジトリ（PR の URL から。`owner/repo` か `host/owner/repo`）。 */
	readonly repo: string;
	readonly headRefName: string;
	/** マージをこのコミットに固定する（`--match-head-commit`）。 */
	readonly headSha: string;
	readonly baseRefName?: string;
	/** `MERGEABLE` / `CONFLICTING` / `UNKNOWN`。 */
	readonly mergeable?: string;
	/** `CLEAN` / `BLOCKED` / `BEHIND` / `DIRTY` / `UNSTABLE` / `HAS_HOOKS` / `DRAFT` / `UNKNOWN`。 */
	readonly mergeStateStatus?: string;
	/** `APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED`（レビューが要らなければ無い）。 */
	readonly reviewDecision?: string;
	/** 画面に出すチェック（{@link PARADIS_PR_MAX_CHECKS} 件まで）。 */
	readonly checks: readonly IParadisPullRequestCheck[];
	/** 切る前の全件の区分ごとの数（マージの判断はこちらで数える。W2-36 より前の形には無い）。 */
	readonly checkCounts?: Record<ParadisPullRequestCheckBucket, number>;
	/**
	 * チェックが切られている・gh が全件を返したか分からない（{@link PARADIS_PR_CHECKS_MAYBE_TRUNCATED} 件以上）。
	 * このときスマホからはマージさせない。
	 */
	readonly checksIncomplete?: boolean;
}

/** PR を出せない理由（`prView` の `unavailable`）。 */
export type ParadisPullRequestUnavailable = 'no-gh' | 'no-auth' | 'no-pr' | 'detached' | 'error';

/** git channel の `getPullRequestDetail` の結果。 */
export type ParadisPullRequestLookup =
	| { readonly kind: 'ok'; readonly detail: IParadisPullRequestDetail }
	| { readonly kind: 'none'; readonly reason: ParadisPullRequestUnavailable; readonly message?: string };

/** `gh pr view --json` に渡す項目。 */
export const PARADIS_PR_DETAIL_FIELDS = 'number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup';

/** 一度に返すチェックの上限（大きなモノレポで何百と並ぶことがある）。 */
export const PARADIS_PR_MAX_CHECKS = 200;

/**
 * この件数以上のチェックが届いたら、gh が途中で切った可能性があるとみなす。gh の `statusCheckRollup` は GraphQL の
 * `contexts(first: 100)` 相当で取っていると推測していて（打ち切り件数は確かめられていない）、全件かどうかが分からない。
 */
export const PARADIS_PR_CHECKS_MAYBE_TRUNCATED = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function httpsUrl(value: unknown): string | undefined {
	return typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value) && value.length <= 2_000 ? value : undefined;
}

const SEGMENT = '[A-Za-z0-9_.-]+';

/** GitHub の URL から `gh -R` に渡すリポジトリを読む（github.com なら `owner/repo`、それ以外は `host/owner/repo`）。 */
export function paradisGithubRepoFromUrl(url: string): string | undefined {
	const match = new RegExp(`^https://(?<host>[A-Za-z0-9.-]+(?::\\d+)?)/(?<owner>${SEGMENT})/(?<repo>${SEGMENT})/`).exec(url);
	if (match?.groups === undefined || match.groups.owner === '..' || match.groups.repo === '..' || match.groups.owner === '.' || match.groups.repo === '.') {
		return undefined;
	}
	const { host, owner, repo } = match.groups;
	return host === 'github.com' ? `${owner}/${repo}` : `${host}/${owner}/${repo}`;
}

/** Actions のジョブの詳細 URL（`…/actions/runs/<run>/job/<job>`）からジョブの id を読む。 */
export function paradisGithubJobIdFromUrl(url: string): string | undefined {
	return /\/actions\/runs\/\d+\/jobs?\/(?<job>\d{1,20})(?:[/?#]|$)/.exec(url)?.groups?.job;
}

/** statusCheckRollup の1件（CheckRun か StatusContext）を区分にする。 */
export function paradisPullRequestCheckBucket(entry: { readonly status?: unknown; readonly conclusion?: unknown; readonly state?: unknown }): ParadisPullRequestCheckBucket {
	// StatusContext（外部の CI）は state だけを持つ
	if (entry.status === undefined && typeof entry.state === 'string') {
		switch (entry.state.toUpperCase()) {
			case 'SUCCESS': return 'pass';
			case 'FAILURE':
			case 'ERROR': return 'fail';
			default: return 'pending';
		}
	}
	if (typeof entry.status === 'string' && entry.status.toUpperCase() !== 'COMPLETED') {
		return 'pending';
	}
	switch (typeof entry.conclusion === 'string' ? entry.conclusion.toUpperCase() : '') {
		case 'SUCCESS': return 'pass';
		case 'NEUTRAL':
		case 'SKIPPED': return 'skipping';
		case 'CANCELLED': return 'cancel';
		case 'FAILURE':
		case 'TIMED_OUT':
		case 'STARTUP_FAILURE':
		case 'ACTION_REQUIRED':
		case 'STALE': return 'fail';
		default: return 'pending';
	}
}

/**
 * `gh pr view --json <PARADIS_PR_DETAIL_FIELDS>` の出力を読む。いまのブランチの PR でなければ
 * （gh が別の PR を返した）undefined。
 */
export function paradisParseGhPullRequestDetail(stdout: string, currentBranch: string): IParadisPullRequestDetail | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!isRecord(raw)) {
		return undefined;
	}
	const url = httpsUrl(raw.url);
	const headRefName = stringOf(raw.headRefName);
	const headSha = stringOf(raw.headRefOid);
	const repo = url !== undefined ? paradisGithubRepoFromUrl(url) : undefined;
	if (typeof raw.number !== 'number' || !Number.isSafeInteger(raw.number) || raw.number <= 0 || url === undefined || repo === undefined
		|| headRefName === undefined || headSha === undefined || !/^[0-9a-f]{40}$/i.test(headSha) || typeof raw.state !== 'string') {
		return undefined;
	}
	if (currentBranch !== headRefName && !currentBranch.endsWith(`/${headRefName}`)) {
		return undefined;
	}
	let state: ParadisPullRequestState;
	switch (raw.state) {
		case 'OPEN': state = raw.isDraft === true ? 'draft' : 'open'; break;
		case 'MERGED': state = 'merged'; break;
		case 'CLOSED': state = 'closed'; break;
		default: return undefined;
	}
	const checks: IParadisPullRequestCheck[] = [];
	const checkCounts: Record<ParadisPullRequestCheckBucket, number> = { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 };
	const rollup = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : [];
	for (const entry of rollup) {
		if (!isRecord(entry)) {
			continue;
		}
		// マージの判断に使う数は、画面に出す分を切る前の全件で数える
		const bucket = paradisPullRequestCheckBucket(entry);
		checkCounts[bucket]++;
		const name = stringOf(entry.name) ?? stringOf(entry.context);
		if (name === undefined || checks.length >= PARADIS_PR_MAX_CHECKS) {
			continue;
		}
		const checkUrl = httpsUrl(entry.detailsUrl) ?? httpsUrl(entry.targetUrl);
		const jobId = checkUrl !== undefined ? paradisGithubJobIdFromUrl(checkUrl) : undefined;
		// ログを取るのは PR と同じリポジトリ（同じホスト・owner/repo）の Actions のジョブだけ。第三者の App が
		// 詳細の URL に別のホストを書いても、そこへ gh を向けさせない
		const jobRepo = jobId !== undefined && checkUrl !== undefined ? paradisGithubRepoFromUrl(checkUrl) : undefined;
		const sameRepo = jobRepo !== undefined && jobRepo.toLowerCase() === repo.toLowerCase();
		const workflow = stringOf(entry.workflowName);
		checks.push({
			name: name.slice(0, 200),
			...(workflow !== undefined ? { workflow: workflow.slice(0, 200) } : {}),
			bucket,
			...(checkUrl !== undefined ? { url: checkUrl } : {}),
			...(jobId !== undefined && sameRepo ? { jobId, repo } : {}),
		});
	}
	const checksIncomplete = rollup.length >= PARADIS_PR_CHECKS_MAYBE_TRUNCATED || rollup.length > checks.length;
	const baseRefName = stringOf(raw.baseRefName);
	const mergeable = stringOf(raw.mergeable);
	const mergeStateStatus = stringOf(raw.mergeStateStatus);
	const reviewDecision = stringOf(raw.reviewDecision);
	return {
		number: raw.number,
		title: typeof raw.title === 'string' ? raw.title.slice(0, 500) : '',
		url,
		state,
		repo,
		headRefName,
		headSha: headSha.toLowerCase(),
		...(baseRefName !== undefined ? { baseRefName } : {}),
		...(mergeable !== undefined ? { mergeable } : {}),
		...(mergeStateStatus !== undefined ? { mergeStateStatus } : {}),
		...(reviewDecision !== undefined ? { reviewDecision } : {}),
		checks,
		checkCounts,
		...(checksIncomplete ? { checksIncomplete: true } : {}),
	};
}

/** チェックの数を区分ごとに数える。 */
export function paradisPullRequestCheckCounts(checks: readonly IParadisPullRequestCheck[]): Record<ParadisPullRequestCheckBucket, number> {
	const counts: Record<ParadisPullRequestCheckBucket, number> = { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 };
	for (const check of checks) {
		counts[check.bucket]++;
	}
	return counts;
}

/** スマホからマージできない理由。 */
export type ParadisPullRequestMergeBlock = 'not-open' | 'draft' | 'conflict' | 'checks-failing' | 'checks-pending' | 'checks-unknown' | 'changes-requested' | 'review-required' | 'blocked';

/**
 * スマホからマージしてよいか（Q128 A）。CI が失敗・実行中なら出さず、PC でのマージを案内する。
 * レビュー待ち・変更の要求・競合・保護の規則で止まっているときも出さない（`gh` は `--admin` 無しでは断るが、
 * 押せるように見せない）。PC は `prMerge` を受けたときに取り直した状態でもう一度これを確かめる。
 */
export function paradisPullRequestMergeBlock(detail: IParadisPullRequestDetail): { readonly code: ParadisPullRequestMergeBlock; readonly message: string } | undefined {
	if (detail.state === 'draft') {
		return { code: 'draft', message: '下書きの PR はマージできません。' };
	}
	if (detail.state !== 'open') {
		return { code: 'not-open', message: 'この PR は開いていません。' };
	}
	if (detail.mergeable === 'CONFLICTING' || detail.mergeStateStatus === 'DIRTY') {
		return { code: 'conflict', message: 'ベースのブランチと競合しています。PC で解決してください。' };
	}
	// 画面に出す分を切る前の全件の数で判断する（切った後ろに失敗が隠れていてもマージさせない）
	const counts = detail.checkCounts ?? paradisPullRequestCheckCounts(detail.checks);
	if (counts.fail > 0 || counts.cancel > 0) {
		return { code: 'checks-failing', message: '失敗した CI のチェックがあります。PC でマージしてください。' };
	}
	if (counts.pending > 0) {
		return { code: 'checks-pending', message: 'CI のチェックが実行中です。終わるのを待つか、PC でマージしてください。' };
	}
	if (detail.checksIncomplete === true) {
		return { code: 'checks-unknown', message: 'CI のチェックが多く、すべてを確かめられません。PC でマージしてください。' };
	}
	if (detail.reviewDecision === 'CHANGES_REQUESTED') {
		return { code: 'changes-requested', message: '変更を求めるレビューがあります。' };
	}
	if (detail.reviewDecision === 'REVIEW_REQUIRED') {
		return { code: 'review-required', message: 'レビューの承認を待っています。' };
	}
	if (detail.mergeStateStatus === 'BLOCKED') {
		return { code: 'blocked', message: 'ブランチの保護の規則でマージが止められています。PC で確かめてください。' };
	}
	return undefined;
}

/**
 * `gh pr merge` が成功した後に取り直した PR から、`prMerge` の応答の `merged` / `queued` を決める（Q145 A）。
 * マージキューのあるリポジトリでは、gh はキューへ入れただけで成功を返す。取り直した PR が MERGED のときだけ
 * マージしたと返し、それ以外（まだ開いている・取り直せなかった・別の PR になった）は「キューに入れた」と返す
 * （マージ済みを「キューに入れた」と言っても、スマホは続けて PR を取り直すので状態は正しく出る）。
 * `queued` は後から足した任意項目で、古いアプリは読まずに「マージしました」と出す。
 */
export function paradisPullRequestMergeOutcome(after: ParadisPullRequestLookup | undefined, number: number): { readonly merged: true } | { readonly merged: false; readonly queued: true } {
	return after?.kind === 'ok' && after.detail.number === number && after.detail.state === 'merged' ? { merged: true } : { merged: false, queued: true };
}

/** 失敗したチェック（「直してもらう」の対象）。ログを取れる Actions のジョブを先に並べる。 */
export function paradisFailedPullRequestChecks(checks: readonly IParadisPullRequestCheck[]): IParadisPullRequestCheck[] {
	const failed = checks.filter(check => check.bucket === 'fail');
	return [...failed.filter(check => check.jobId !== undefined), ...failed.filter(check => check.jobId === undefined)];
}

/** ログを取るジョブの数・1 ジョブの行数・文字数の上限（Q128 A: 末尾 200 行まで、3 ジョブまで）。 */
export const PARADIS_PR_FAILED_LOG_JOBS = 3;
export const PARADIS_PR_FAILED_LOG_LINES = 200;
export const PARADIS_PR_FAILED_LOG_CHARS = 12_000;

/**
 * `gh run view --job <id> --log-failed` の出力の末尾を残す。各行の先頭の「ジョブ名<TAB>ステップ名<TAB>時刻 」を
 * 落とし、ステップが変わる所に見出しを入れる。行数と文字数の両方で切る（新しい行を優先）。
 */
export function paradisTailFailedJobLog(raw: string, maxLines = PARADIS_PR_FAILED_LOG_LINES, maxChars = PARADIS_PR_FAILED_LOG_CHARS): string {
	const parsed = raw.replace(/\r\n?/g, '\n').split('\n').filter(line => line.length > 0).map(line => {
		const match = /^[^\t]*\t(?<step>[^\t]*)\t(?:\d{4}-\d\d-\d\dT[\d:.]+Z ?)?(?<text>.*)$/.exec(line);
		return match?.groups !== undefined ? { step: match.groups.step, text: match.groups.text ?? '' } : { step: undefined, text: line };
	});
	const kept: string[] = [];
	let chars = 0;
	let lines = 0;
	let step: string | undefined;
	for (let index = parsed.length - 1; index >= 0 && lines < maxLines; index--) {
		const entry = parsed[index];
		if (entry === undefined) {
			continue;
		}
		const text = entry.text.length > 500 ? `${entry.text.slice(0, 500)}…` : entry.text;
		if (chars + text.length + 1 > maxChars) {
			break;
		}
		if (step !== undefined && entry.step !== step) {
			kept.push(`--- ${step} ---`);
		}
		step = entry.step;
		kept.push(text);
		chars += text.length + 1;
		lines++;
	}
	if (step !== undefined) {
		kept.push(`--- ${step} ---`);
	}
	return kept.reverse().join('\n');
}

/** `gh repo view --json viewerDefaultMergeMethod,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed` からマージの方式を選ぶ。 */
export function paradisPickMergeMethod(stdout: string): 'merge' | 'squash' | 'rebase' | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!isRecord(raw)) {
		return undefined;
	}
	const allowed = {
		merge: raw.mergeCommitAllowed === true,
		squash: raw.squashMergeAllowed === true,
		rebase: raw.rebaseMergeAllowed === true,
	};
	const preferred = typeof raw.viewerDefaultMergeMethod === 'string' ? raw.viewerDefaultMergeMethod.toLowerCase() : '';
	if ((preferred === 'merge' || preferred === 'squash' || preferred === 'rebase') && allowed[preferred]) {
		return preferred;
	}
	// 既定が読めなければ、許されているものを squash → merge → rebase の順に選ぶ（Orca と同じく squash を先に）
	return allowed.squash ? 'squash' : allowed.merge ? 'merge' : allowed.rebase ? 'rebase' : undefined;
}
