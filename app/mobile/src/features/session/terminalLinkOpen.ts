// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ターミナルで押した `localhost` などの URL を PC の内蔵ブラウザで開き、スマホのブラウザのタブで
 * そのページを映すまで（W2-31、Q123 A）。
 *
 * PC は URL を内蔵ブラウザの新しいタブで開くだけで、どのページになったかは返さない（内蔵ブラウザの
 * 開く命令が何も返さないため）。開く前と後のページ一覧を比べ、増えたページのうち URL が合うものを選ぶ。
 * ページが一覧に現れるまで少しかかるので、何度か見に行く。見つからなければ `undefined`（ブラウザの
 * タブは既定の選び方で映す）。
 */

export interface BrowserTargetLike {
	readonly targetId: string;
	readonly url: string;
}

/** 比べるための形（スキームとホストは小文字、`#` 以降と末尾の `/` は外す）。 */
function normalizeUrl(url: string): string {
	const withoutHash = url.trim().replace(/#.*$/, '');
	const match = /^(?<origin>[a-z][a-z0-9+.-]*:\/\/[^/?#]*)(?<rest>.*)$/i.exec(withoutHash);
	const origin = match?.groups?.origin?.toLowerCase() ?? withoutHash;
	const rest = (match?.groups?.rest ?? '').replace(/\/$/, '');
	return origin + rest;
}

function originOf(url: string): string {
	return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(url.trim())?.[0].toLowerCase() ?? '';
}

/**
 * 開いたページを選ぶ。開く前に無かったページを優先し、その中で URL が同じもの → オリジンが同じもの、の順。
 * 新しいページが無ければ、すでに開いていた同じ URL のページ（内蔵ブラウザが既存のタブを前に出した場合）。
 * オリジンが違う新しいページは選ばない（同じ時にほかで開いたページを映さないため。リダイレクトで別の
 * オリジンへ移った場合は見つからず、ブラウザのタブは既定の選び方で映す）。
 */
export function pickOpenedBrowserTarget<T extends BrowserTargetLike>(targets: readonly T[], url: string, before: ReadonlySet<string>): T | undefined {
	const wanted = normalizeUrl(url);
	const origin = originOf(url);
	const fresh = targets.filter(target => !before.has(target.targetId));
	return fresh.find(target => normalizeUrl(target.url) === wanted)
		?? fresh.find(target => originOf(target.url) === origin)
		?? targets.find(target => normalizeUrl(target.url) === wanted);
}

export interface OpenUrlInPcBrowserDeps<T extends BrowserTargetLike> {
	/** PC に開いてもらう（失敗したら reject）。 */
	open(): Promise<unknown>;
	/** PC の内蔵ブラウザのページ一覧。 */
	listTargets(): Promise<readonly T[]>;
	wait(ms: number): Promise<void>;
}

/** 一覧を見に行く回数と間隔。合わせて 2 秒ほど待つ。 */
const LIST_ATTEMPTS = 6;
const LIST_INTERVAL_MS = 350;

/** PC で開いて、映すページを探す。開くのに失敗したら reject する（探すのに失敗しても reject しない）。 */
export async function openUrlInPcBrowser<T extends BrowserTargetLike>(url: string, deps: OpenUrlInPcBrowserDeps<T>): Promise<T | undefined> {
	const listed = async (): Promise<readonly T[]> => {
		try {
			return await deps.listTargets();
		} catch {
			return [];
		}
	};
	const before = new Set((await listed()).map(target => target.targetId));
	await deps.open();
	for (let attempt = 0; attempt < LIST_ATTEMPTS; attempt++) {
		await deps.wait(LIST_INTERVAL_MS);
		const picked = pickOpenedBrowserTarget(await listed(), url, before);
		if (picked !== undefined) {
			return picked;
		}
	}
	return undefined;
}
