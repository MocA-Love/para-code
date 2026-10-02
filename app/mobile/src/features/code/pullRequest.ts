// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import {
	paradisFailedPullRequestChecks,
	paradisPullRequestCheckCounts,
	paradisPullRequestMergeBlock,
	type IParadisPullRequestCheck,
	type IParadisPullRequestDetail,
	type ParadisPullRequestCheckBucket,
	type ParadisPullRequestUnavailable,
} from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobilePullRequest.js';

/**
 * スマホのプルリクエストの区分（Orca W2-36）の判定。React に依存しない純関数で、`pullRequest.test.ts` で固定している。
 * マージしてよいかの判定は PC と同じ関数（`paradisPullRequestMergeBlock`）を使う。
 */

export type PrDetail = IParadisPullRequestDetail;
export type PrCheck = IParadisPullRequestCheck;

/** PR の区分を開いている間に取り直す間隔（GitHub の制限に触れないよう、開いている間だけ）。 */
export const PR_POLL_MS = 60_000;

/** {@link startPrPolling} が使うタイマー（テストでは差し替える）。 */
export interface PrPollTimers {
	readonly set: (callback: () => void, ms: number) => unknown;
	readonly clear: (handle: unknown) => void;
}

const DEFAULT_TIMERS: PrPollTimers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * すぐに 1 回読み、読み終わってから `intervalMs` 後に次を読む（前の要求が終わるまで次を出さない）。
 * 決まった間隔で出すと、PC の応答が間隔より遅いとき次の要求が前の要求の応答を捨て続け、読み込み中のまま止まる。
 * 返す関数で止める（読んでいる最中に止めたら、その後は次を予約しない）。
 */
export function startPrPolling(refresh: () => Promise<void>, intervalMs: number = PR_POLL_MS, timers: PrPollTimers = DEFAULT_TIMERS): () => void {
	let stopped = false;
	let handle: unknown;
	const tick = async () => {
		handle = undefined;
		try {
			await refresh();
		} catch {
			// refresh は失敗を自分で画面へ出す。ここでは次の予約だけを続ける
		}
		if (!stopped) {
			handle = timers.set(() => { void tick(); }, intervalMs);
		}
	};
	void tick();
	return () => {
		stopped = true;
		if (handle !== undefined) {
			timers.clear(handle);
			handle = undefined;
		}
	};
}

/** `prView` の応答。 */
export type PrViewResult =
	| { readonly kind: 'pr'; readonly pr: PrDetail }
	| { readonly kind: 'unavailable'; readonly reason: ParadisPullRequestUnavailable; readonly message: string | undefined };

const BUCKETS: readonly ParadisPullRequestCheckBucket[] = ['pass', 'fail', 'pending', 'skipping', 'cancel'];
const REASONS: readonly ParadisPullRequestUnavailable[] = ['no-gh', 'no-auth', 'no-pr', 'detached', 'error'];

function parseCheck(value: unknown): PrCheck | undefined {
	const check = value as Partial<Record<keyof PrCheck, unknown>> | null;
	if (check === null || typeof check !== 'object' || typeof check.name !== 'string') {
		return undefined;
	}
	const bucket = BUCKETS.find(candidate => candidate === check.bucket);
	if (bucket === undefined) {
		return undefined;
	}
	return {
		name: check.name,
		bucket,
		...(typeof check.workflow === 'string' ? { workflow: check.workflow } : {}),
		...(typeof check.url === 'string' && check.url.startsWith('https://') ? { url: check.url } : {}),
		...(typeof check.jobId === 'string' ? { jobId: check.jobId } : {}),
		...(typeof check.repo === 'string' ? { repo: check.repo } : {}),
	};
}

/** 切る前の全件の数（無い・形が違えば何も足さない。マージの判断は画面に出すチェックから数え直す）。 */
function parseCheckCounts(value: unknown): { readonly checkCounts?: Record<ParadisPullRequestCheckBucket, number> } {
	const counts = value as Partial<Record<ParadisPullRequestCheckBucket, unknown>> | null | undefined;
	if (counts === null || typeof counts !== 'object' || !BUCKETS.every(bucket => typeof counts[bucket] === 'number')) {
		return {};
	}
	return { checkCounts: { pass: Number(counts.pass), fail: Number(counts.fail), pending: Number(counts.pending), skipping: Number(counts.skipping), cancel: Number(counts.cancel) } };
}

/** PC から届いた `prView` の応答を読む。形の違うものは「取得できなかった」にする。 */
export function parsePrView(reply: { readonly pr?: unknown; readonly unavailable?: unknown; readonly message?: unknown }): PrViewResult {
	const raw = reply.pr as Partial<Record<keyof PrDetail, unknown>> | null | undefined;
	if (raw !== null && typeof raw === 'object' && typeof raw.number === 'number' && typeof raw.url === 'string' && raw.url.startsWith('https://')
		&& typeof raw.headSha === 'string' && typeof raw.headRefName === 'string' && typeof raw.repo === 'string'
		&& (raw.state === 'open' || raw.state === 'draft' || raw.state === 'merged' || raw.state === 'closed')) {
		const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
		const baseRefName = text(raw.baseRefName);
		const mergeable = text(raw.mergeable);
		const mergeStateStatus = text(raw.mergeStateStatus);
		const reviewDecision = text(raw.reviewDecision);
		return {
			kind: 'pr',
			pr: {
				number: raw.number,
				title: typeof raw.title === 'string' ? raw.title : '',
				url: raw.url,
				state: raw.state,
				repo: raw.repo,
				headRefName: raw.headRefName,
				headSha: raw.headSha,
				...(baseRefName !== undefined ? { baseRefName } : {}),
				...(mergeable !== undefined ? { mergeable } : {}),
				...(mergeStateStatus !== undefined ? { mergeStateStatus } : {}),
				...(reviewDecision !== undefined ? { reviewDecision } : {}),
				checks: Array.isArray(raw.checks) ? raw.checks.map(parseCheck).filter((check): check is PrCheck => check !== undefined) : [],
				...parseCheckCounts(raw.checkCounts),
				...(raw.checksIncomplete === true ? { checksIncomplete: true } : {}),
			},
		};
	}
	const reason = REASONS.find(candidate => candidate === reply.unavailable) ?? 'error';
	return { kind: 'unavailable', reason, message: typeof reply.message === 'string' && reply.message.length > 0 ? reply.message : undefined };
}

/** PR を出せないときの見出しと本文。 */
export function prUnavailableText(reason: ParadisPullRequestUnavailable, message: string | undefined): { readonly title: string; readonly body: string } {
	switch (reason) {
		case 'no-gh':
			return { title: 'PC に GitHub CLI がありません', body: 'PC に gh を入れて、`gh auth login` を実行してください。' };
		case 'no-auth':
			return { title: 'GitHub にログインしていません', body: 'PC で `gh auth login` を実行してください。' };
		case 'no-pr':
			return { title: 'このブランチのプルリクエストはありません', body: 'PR を作ると、ここで CI の結果を見てマージできます。' };
		case 'detached':
			return { title: 'ブランチがありません', body: 'detached HEAD のため PR を探せません。' };
		case 'error':
			return { title: 'PR を取得できませんでした', body: message ?? 'しばらくしてから読み直してください。' };
	}
}

const ORDER: Record<ParadisPullRequestCheckBucket, number> = { fail: 0, cancel: 1, pending: 2, pass: 3, skipping: 4 };

/** チェックを 失敗 → 取り消し → 実行中 → 成功 → スキップ の順に並べる（同じ区分の中は PC から届いた順）。 */
export function orderedChecks(checks: readonly PrCheck[]): PrCheck[] {
	return checks.map((check, index) => ({ check, index })).sort((a, b) => ORDER[a.check.bucket] - ORDER[b.check.bucket] || a.index - b.index).map(entry => entry.check);
}

/** チェックの数の一行（「失敗 1・実行中 2・成功 3」）。チェックが無ければ undefined。 */
export function checkSummaryText(checks: readonly PrCheck[], allCounts?: Record<ParadisPullRequestCheckBucket, number>): string | undefined {
	const counts = allCounts ?? paradisPullRequestCheckCounts(checks);
	if (Object.values(counts).every(count => count === 0)) {
		return undefined;
	}
	return [
		counts.fail > 0 ? `失敗 ${counts.fail}` : undefined,
		counts.cancel > 0 ? `取り消し ${counts.cancel}` : undefined,
		counts.pending > 0 ? `実行中 ${counts.pending}` : undefined,
		counts.pass > 0 ? `成功 ${counts.pass}` : undefined,
		counts.skipping > 0 ? `スキップ ${counts.skipping}` : undefined,
	].filter(part => part !== undefined).join('・');
}

/** 「AI に直してもらう」を出すか（失敗したチェックがあるとき）。 */
export function canFixChecks(pr: PrDetail): boolean {
	return pr.state === 'open' || pr.state === 'draft' ? paradisFailedPullRequestChecks(pr.checks).length > 0 : false;
}

/** このスマホからマージキューに入れた PR（番号と、入れたときの head と時刻）。 */
export interface PrQueued {
	readonly number: number;
	readonly headSha: string;
	readonly at: number;
}

/**
 * マージキューに入れた印を持ち続ける時間（ms）。キューから外された PR をいつまでもマージできなくしないよう、
 * この時間が過ぎたら（または手で読み直したら）印を外す。
 */
export const PR_QUEUED_HOLD_MS = 10 * 60_000;

/** いまも効いているマージキューの印（時間が過ぎていれば undefined）。 */
export function activePrQueued(queued: PrQueued | undefined, now: number): PrQueued | undefined {
	return queued !== undefined && now - queued.at < PR_QUEUED_HOLD_MS ? queued : undefined;
}

/**
 * マージのボタン。`reason` があれば押せない（CI の失敗・実行中は「PC でマージしてください」）。
 * マージキューに入れた PR は、同じ head のまま開いている間は押せない（GitHub がマージするのを待つ）。
 */
export function prMergeButton(pr: PrDetail, queued?: PrQueued): { readonly visible: boolean; readonly reason: string | undefined } {
	if (pr.state === 'merged' || pr.state === 'closed') {
		return { visible: false, reason: undefined };
	}
	if (queued !== undefined && queued.number === pr.number && queued.headSha === pr.headSha) {
		return { visible: true, reason: 'マージキューに入れました。GitHub がマージするとマージ済みに変わります。' };
	}
	return { visible: true, reason: paradisPullRequestMergeBlock(pr)?.message };
}

/** マージの結果。`queued`（Q145）を返さない古い PC はマージしたものとして扱う。 */
export type PrMergeOutcome = 'merged' | 'queued';

export function parsePrMergeReply(reply: { readonly queued?: unknown } | undefined): PrMergeOutcome {
	return reply?.queued === true ? 'queued' : 'merged';
}

/** マージの後のお知らせ。 */
export function prMergeToastText(number: number, outcome: PrMergeOutcome): string {
	return outcome === 'queued' ? `#${number} をマージキューに入れました` : `#${number} をマージしました`;
}

/** マージの確かめのシートの本文（題名・ブランチ・チェックの結果・固定するコミット）。 */
export function mergeConfirmMessage(pr: PrDetail): string {
	return [
		`#${pr.number} ${pr.title}`,
		`${pr.headRefName}${pr.baseRefName !== undefined ? ` → ${pr.baseRefName}` : ''}`,
		checkSummaryText(pr.checks, pr.checkCounts) ?? 'CI のチェックはありません',
		`コミット ${pr.headSha.slice(0, 7)} をリポジトリの既定の方法でマージします。この操作は取り消せません。`,
	].join('\n');
}

export function prStateLabel(state: PrDetail['state']): string {
	switch (state) {
		case 'open': return 'オープン';
		case 'draft': return '下書き';
		case 'merged': return 'マージ済み';
		case 'closed': return 'クローズ';
	}
}

export function checkBucketLabel(bucket: ParadisPullRequestCheckBucket): string {
	switch (bucket) {
		case 'pass': return '成功';
		case 'fail': return '失敗';
		case 'pending': return '実行中';
		case 'skipping': return 'スキップ';
		case 'cancel': return '取り消し';
	}
}
