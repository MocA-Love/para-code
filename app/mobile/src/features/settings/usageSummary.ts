// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { dayCost, localDateKey } from '../../usageFormat.js';
import type { RateLimitAccount, RateLimitProviderSnapshot, RateLimitWindow, UsageAgent, UsageDashboardResult } from '../../store.js';

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
export function accountWindows(account: RateLimitAccount): { label: string; window: RateLimitWindow }[] {
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

/**
 * 値が取れていないアカウントの説明。値が取れている（`ok`）なら undefined。
 *
 * `refreshing` と `unavailable` は認証の問題ではない（上限に達したアカウントは、PC 側が枠の
 * リセットまで取得を止める）ので、再ログインを促さない。
 */
export function accountStatusMessage(account: RateLimitAccount): string | undefined {
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
			return '使用状況を一時的に取得できていません（上限に達したアカウントは、リセットまで取得を止めます）';
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
