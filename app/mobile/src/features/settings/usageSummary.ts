// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { dayCost, localDateKey } from '../../usageFormat.js';
import type { RateLimitAccount, RateLimitProviderSnapshot, RateLimitResetCredits, RateLimitWindow, UsageAgent, UsageDashboardResult } from '../../store.js';

/**
 * 使用量（`/settings/usage`、Orca の accounts）の表示の算出。画面から切り離した純関数で、
 * テストで固定している（`usageSummary.test.ts`）。
 *
 * 既存の計算（今日のコスト・日付の区切り・使用率）は `src/usageFormat.ts` にあり、ここはそれを
 * 使って新しい画面の文言を組むだけにする。アカウントの状態の説明は旧「利用上限」画面
 * （`legacy-screens/(settings)/ratelimit.tsx`）にあったものを、画面の外へ移した。
 */

/** アカウントの見出し（メール → ホームの呼び名 → ID の順）。 */
export function accountName(account: RateLimitAccount): string {
	return account.email ?? account.homeLabel ?? account.id;
}

/** アカウントの枠（5時間・7日・追加の枠）を、見せる順に並べる。 */
export function accountWindows(account: Pick<RateLimitAccount, 'fiveHour' | 'sevenDay' | 'scoped'>): { label: string; window: RateLimitWindow }[] {
	const rows: { label: string; window: RateLimitWindow }[] = [];
	if (account.fiveHour) {
		rows.push({ label: '5時間', window: account.fiveHour });
	}
	if (account.sevenDay) {
		rows.push({ label: '7日', window: account.sevenDay });
	}
	for (const scoped of account.scoped ?? []) {
		rows.push({ label: scoped.label ?? '追加枠', window: scoped });
	}
	return rows;
}

/** 控えている間の前の値の枠（{@link hasPreviousValue} が false なら空）。 */
export function previousWindows(account: RateLimitAccount): { label: string; window: RateLimitWindow }[] {
	return hasPreviousValue(account) ? accountWindows(account.previousWindows!) : [];
}

/**
 * 値が取れていないアカウントの説明。値が取れている（`ok`）なら undefined。
 *
 * `refreshing` と `unavailable` は認証の問題ではない（上限に達したアカウントは、PC 側が枠の
 * リセットまで取得を止める）ので、再ログインを促さない。
 *
 * `remoteHost` は SSH の接続先のログインを出しているとき（{@link RateLimitProviderSnapshot.remoteHost}）。
 * 直すのは接続先の Claude Code なので、PC の Para Code ではなく接続先のターミナルでの操作を案内する。
 */
export function accountStatusMessage(account: RateLimitAccount, remoteHost = false): string | undefined {
	if (remoteHost) {
		const message = remoteHostStatusMessage(account);
		if (message !== undefined) {
			return message;
		}
	}
	switch (account.status) {
		case 'ok':
			return undefined;
		case 'refreshing':
			return 'アクセストークンの期限が切れています。PC 側で自動で更新されます';
		case 'unavailable':
			if (account.unavailableReason === 'api_key') {
				return 'API キーで使っているため、サブスクリプションの使用状況はありません';
			}
			if (account.unavailableReason === 'keychain_unavailable') {
				return 'キーチェーンを読み取れないため、使用状況を取得できません';
			}
			if (account.unavailableReason === 'rate_limited') {
				return '使用状況の取得回数が上限に達したため、しばらく待ってから取り直します';
			}
			// 'not_fetched' は PC が statusDetail に本当の理由を入れる（PC の使用量パネルと同じ出し分け）
			switch (account.statusDetail) {
				case CLAUDE_DETAIL_SHARED_WITH_CLAUDE_SWAP:
					return 'claude-swap と同じログインを共有している可能性があるため、PC がログインの更新を控えています。PC でこのアカウントを使うと表示されます';
				case CLAUDE_DETAIL_SAME_LINEAGE:
					return 'いまのログインと同じトークンのため、ログインの更新は Claude Code に任せています。更新されると表示されます';
				default:
					return '使用状況をまだ取得していません。PC が順に取りに行くので、しばらくすると表示されます';
			}
		case 'no_credentials':
			return '認証情報が見つかりません。PC の Para Code から再ログインしてください';
		case 'relogin_required':
			return '再ログインが必要です。PC の Para Code から操作してください';
		case 'error':
			return account.statusDetail ?? '使用状況を取得できませんでした';
		default:
			return '使用状況を取得できていません';
	}
}

/**
 * 取りに行くのを控えている（'not_fetched'）が、前に取れた値を PC が `previousWindows`・`previousFetchedAt` で
 * 送っているか。PC の paradisLimitsPreviousValue と同じ決まり。古い PC はこの項目を送らないので false になり、前と同じ表示になる。
 */
export function hasPreviousValue(account: RateLimitAccount): boolean {
	return account.status === 'unavailable'
		&& account.unavailableReason === 'not_fetched'
		&& account.previousFetchedAt !== undefined
		&& Number.isFinite(account.previousFetchedAt)
		&& account.previousWindows !== undefined
		&& accountWindows(account.previousWindows).length > 0;
}

/** 「12分前の値」「3時間前の値」「2日前の値」。 */
export function previousValueAge(fetchedAt: number, now: number): string {
	const minutes = Math.max(0, Math.floor((now - fetchedAt) / 60_000));
	if (minutes < 60) {
		return `${minutes}分前の値`;
	}
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}時間前の値` : `${Math.floor(hours / 24)}日前の値`;
}

/**
 * 前の値に添える一文（「12分前の値・ログインの更新を控えています（claude-swap と共有のため）」）。
 * 前の値が無ければ undefined（いつもの説明文を出す）。PC の使用量パネルと同じ文言。
 */
export function previousValueNote(account: RateLimitAccount, now: number): string | undefined {
	if (!hasPreviousValue(account)) {
		return undefined;
	}
	const age = previousValueAge(account.previousFetchedAt!, now);
	switch (account.statusDetail) {
		case CLAUDE_DETAIL_SHARED_WITH_CLAUDE_SWAP:
			return `${age}・ログインの更新を控えています（claude-swap と共有のため）`;
		case CLAUDE_DETAIL_SAME_LINEAGE:
			return `${age}・ログインの更新は Claude Code に任せています`;
		default:
			return `${age}・取り直しています`;
	}
}

/** リセット時刻を過ぎた枠に、使用率の代わりに出す言葉（取り直すまで今の値は分からない）。 */
export const WINDOW_RESET_UNKNOWN_LABEL = 'リセット済み（今の値は不明）';

/**
 * PC が 'not_fetched' に添える statusDetail（PC の paradisLimitsMonitor.ts の PARADIS_CLAUDE_DETAIL_* と同じ文字列）。
 * claude-swap と共有しているかもしれないので更新を控えている／いまのログインと同じ系列なので Claude Code に任せている。
 */
const CLAUDE_DETAIL_SHARED_WITH_CLAUDE_SWAP = 'shared with claude-swap';
const CLAUDE_DETAIL_SAME_LINEAGE = 'same lineage as the current login';

/** 接続先のログインで、手元の PC と説明が変わる状態だけを返す（それ以外は undefined）。PC の使用量パネルと同じ文言。 */
function remoteHostStatusMessage(account: RateLimitAccount): string | undefined {
	switch (account.status) {
		case 'refreshing':
			// 接続先の Claude Code は、接続先で claude を動かしている間しかトークンを更新しない
			return 'アクセストークンの期限が切れています。接続先で claude を起動すると Claude Code が更新し、表示が戻ります';
		case 'no_credentials':
		case 'relogin_required':
			return '接続先のターミナルで claude を起動し、/login でログインし直してください';
		case 'unavailable':
			switch (account.unavailableReason) {
				case 'host_not_logged_in':
					return '接続先に Claude のサブスクリプションのログインが見つかりません。接続先で使うときは、接続先のターミナルで claude を起動し /login でログインすると表示されます（API キーで使っている場合は表示できません）';
				case 'host_fetch_failed':
					return account.statusDetail !== undefined
						? `接続先から使用量を取得できていません（${account.statusDetail}）。しばらくしてから取り直します`
						: '接続先から使用量を取得できていません。しばらくしてから取り直します';
				case 'keychain_unavailable':
					return '接続先では Claude のログインが macOS のキーチェーンに保存されているため、SSH 越しには読み取れません';
				default:
					return undefined;
			}
		default:
			return undefined;
	}
}

/**
 * アカウントの行の補足（見出しの下の一行）。状態の説明があればそれ、無ければ「使用中」やプラン。
 * 接続先のログインは「使用中」の印の代わりに、どの接続先のログインかを書く。
 */
export function accountHint(account: RateLimitAccount, remoteHost: RateLimitProviderSnapshot['remoteHost'], now?: number): string | undefined {
	// 控えている間の前の値を出すときは、その古さと控えている理由を書く（`now` を渡したときだけ）。
	const previous = now !== undefined ? previousValueNote(account, now) : undefined;
	if (previous !== undefined) {
		return previous;
	}
	const message = accountStatusMessage(account, remoteHost !== undefined);
	if (message !== undefined) {
		return message;
	}
	if (remoteHost !== undefined) {
		return remoteHost.label !== undefined ? `接続先 ${remoteHost.label} でログイン中` : '接続先でログイン中';
	}
	return account.active === true ? '使用中' : account.planType;
}

/**
 * 使用量の画面の下の注記。接続先の Claude のログインを出しているときは、Claude の直し方が接続先の
 * ターミナルになることも書く。
 */
export function usageFootNote(claude: RateLimitProviderSnapshot | undefined): string {
	return claude?.remoteHost !== undefined
		? '接続先の Claude のログインは、接続先のターミナルで claude を起動して /login で行います。この PC の Claude のアカウントは、この PC のウィンドウを選ぶと見られます。'
		: 'アカウントの追加や再ログインは、PC の Para Code から行います。';
}

/** アカウントが1つも無いときの説明。 */
export function providerEmptyMessage(snapshot: RateLimitProviderSnapshot): string {
	if (snapshot.cswapMissing === true) {
		return 'claude-swap（cswap）が PC にありません';
	}
	return snapshot.sourceError ?? 'アカウントが見つかりません';
}

/**
 * 枠のリセットまでの時間（「2時間10分後にリセット」「3日後にリセット」）。
 * もう過ぎている・時刻が無いときは undefined。1日以上先は日と時間まで、それ未満は時間と分まで。
 */
export function resetInLabel(resetsAt: number | undefined, now: number): string | undefined {
	if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= now) {
		return undefined;
	}
	const totalMinutes = Math.ceil((resetsAt - now) / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	const span = days > 0
		? `${days}日${hours > 0 ? `${hours}時間` : ''}`
		: hours > 0
			? `${hours}時間${minutes > 0 ? `${minutes}分` : ''}`
			: `${minutes}分`;
	return `${span}後にリセット`;
}

/** 「10/4 11:12」（端末の時刻。年はまたいでも省く。期限は数十日先までなので紛れない）。 */
export function formatMonthDayTime(at: number): string {
	const date = new Date(at);
	return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** `target` が `now` から見て暦の上で何日後か（端末の時刻。今日は 0、明日は 1、過ぎた日は負）。 */
export function calendarDayOffset(target: number, now: number): number {
	const day = (at: number) => {
		const date = new Date(at);
		return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
	};
	return Math.round((day(target) - day(now)) / 86_400_000);
}

/** 期限の「今日 11:12」「明日 08:00」「10/9 08:00」（今日・明日だけ言葉にする）。 */
function expiryWhen(at: number, now: number): string {
	const days = calendarDayOffset(at, now);
	const time = formatMonthDayTime(at);
	if (days === 0) {
		return `今日 ${time.split(' ')[1]}`;
	}
	if (days === 1) {
		return `明日 ${time.split(' ')[1]}`;
	}
	return time;
}

/** 期限の一覧の1行。 */
export interface ResetCreditRow {
	/** 「10/4 11:12 まで」「期限なし」「ほか 2 回（期限は不明）」 */
	readonly label: string;
	/** 「今日」「明日」「7日後」「期限切れ」（期限のある行だけ）。 */
	readonly relative?: string;
	/** 今日・明日（か過ぎた）期限。目立たせる。 */
	readonly soon: boolean;
}

/**
 * 期限の一覧の行（期限の早い順、期限の無いものはその後、期限の分からない残りは最後）。PC の使用量パネルの
 * 一覧（paradisCodexResetCreditRows）と同じ決まりで、明細と残り回数が合わないときは次のようにする。
 * - 明細が無い: 残り回数ぶんを「N 回（期限は不明）」の1行
 * - 明細が残り回数より少ない: 足りない回数を「ほか N 回（期限は不明）」で足す
 * - 明細が残り回数より多い: 残り回数を正とし、期限の早いものから残り回数ぶんだけ
 */
export function resetCreditRows(resetCredits: RateLimitResetCredits, now: number): ResetCreditRow[] {
	const count = Math.max(0, Math.floor(resetCredits.availableCount));
	if (count === 0) {
		return [];
	}
	const credits = resetCredits.credits;
	if (credits === undefined) {
		return [{ label: `${count} 回（期限は不明）`, soon: false }];
	}
	const dated = credits
		.map(credit => credit.expiresAt)
		.filter((at): at is number => at !== undefined && Number.isFinite(at))
		.sort((a, b) => a - b)
		.map((at): ResetCreditRow => {
			const days = calendarDayOffset(at, now);
			return {
				label: `${formatMonthDayTime(at)} まで`,
				relative: days < 0 ? '期限切れ' : days === 0 ? '今日' : days === 1 ? '明日' : `${days}日後`,
				soon: days <= 1,
			};
		});
	const noExpiry = credits.filter(credit => credit.expiresAt === undefined).map((): ResetCreditRow => ({ label: '期限なし', soon: false }));
	const rows = [...dated, ...noExpiry].slice(0, count);
	if (rows.length < count) {
		rows.push({ label: rows.length === 0 ? `${count} 回（期限は不明）` : `ほか ${count - rows.length} 回（期限は不明）`, soon: false });
	}
	return rows;
}

/**
 * メーターの下に足す1行の決まり（PC の paradisCodexAccounts.ts の `paradisCodexResetSummary` と同じ。両方のテストが同じ表で確かめる）。
 * - count: 残り回数
 * - nextExpiresAt / nextDayOffset: 最も早い期限と、それが暦の上で何日後か（期限のあるものが無ければ無い）
 * - hasNoExpiry: 期限の無いものがある
 * - listable: 1件ごとの期限の一覧を開けるか（残りが2回以上で、明細が1件でもある。明細の無い古い PC は
 *   一覧にしても「期限は不明」しか並ばないので開けない）
 */
export interface ResetCreditsFacts {
	readonly count: number;
	readonly listable: boolean;
	readonly nextExpiresAt?: number;
	readonly nextDayOffset?: number;
	readonly hasNoExpiry: boolean;
}

export function resetCreditsFacts(resetCredits: RateLimitResetCredits, now: number): ResetCreditsFacts {
	const count = Math.max(0, Math.floor(resetCredits.availableCount));
	const nextExpiresAt = resetCredits.credits
		?.map(credit => credit.expiresAt)
		.filter((at): at is number => at !== undefined && Number.isFinite(at))
		.sort((a, b) => a - b)[0] ?? resetCredits.nextExpiresAt;
	return {
		count,
		listable: count >= 2 && (resetCredits.credits?.length ?? 0) > 0,
		...(count > 0 && nextExpiresAt !== undefined ? { nextExpiresAt, nextDayOffset: calendarDayOffset(nextExpiresAt, now) } : {}),
		hasNoExpiry: resetCredits.credits?.some(credit => credit.expiresAt === undefined) === true,
	};
}

/**
 * メーターの下に足す1行（「リセット 残り 4 回 · 次は今日 11:12 に期限」）と、期限の一覧を開けるか。
 * 開けるのは残りが2回以上で、明細があるときだけ（1回なら1行に期限まで書く）。
 */
export function resetCreditsSummary(resetCredits: RateLimitResetCredits, now: number): { text: string; listable: boolean; soon: boolean } {
	const facts = resetCreditsFacts(resetCredits, now);
	const { count, listable } = facts;
	if (count === 0) {
		return { text: 'リセット 残りなし', listable: false, soon: false };
	}
	const soon = facts.nextDayOffset !== undefined && facts.nextDayOffset <= 1;
	if (facts.nextExpiresAt === undefined) {
		return { text: count === 1 && facts.hasNoExpiry ? 'リセット 残り 1 回 · 期限なし' : `リセット 残り ${count} 回`, listable, soon };
	}
	const when = expiryWhen(facts.nextExpiresAt, now);
	return { text: count === 1 ? `リセット 残り 1 回 · ${when} に期限` : `リセット 残り ${count} 回 · 次は${when} に期限`, listable, soon };
}

/**
 * 直近 `days` 日（今日を含む）の1日あたりのコスト。記録の無い日は 0 として数える。
 * 期間のどの日にも記録が無ければ undefined（「平均 $0.00」と言い切らない）。
 */
export function recentDailyAverage(data: UsageDashboardResult, now: number, days = 7, agent: UsageAgent | 'all' = 'all'): number | undefined {
	const byDate = new Map(data.days.map(day => [day.date, day]));
	let total = 0;
	let found = false;
	const today = new Date(now);
	for (let offset = 0; offset < days; offset++) {
		const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
		const row = byDate.get(localDateKey(date));
		if (row !== undefined) {
			found = true;
			total += dayCost(row, agent);
		}
	}
	return found ? total / days : undefined;
}

/** ドル表記（小数2桁）。 */
export function formatUsd(value: number): string {
	return `$${value.toFixed(2)}`;
}

/** 使用率（%）。上限が取れていない（0以下）ときは undefined。 */
export function ratioPercent(used: number, limit: number): number | undefined {
	if (!(limit > 0) || !Number.isFinite(used)) {
		return undefined;
	}
	return Math.min(100, Math.max(0, (used / limit) * 100));
}
