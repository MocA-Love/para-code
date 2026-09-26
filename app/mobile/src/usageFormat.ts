// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { colors } from './theme.js';
import { formatRelativeTime } from './time.js';
import type { UsageLevel } from './systemResources.js';
import type { RateLimitAccount, RateLimitProviderSnapshot, UsageAgent, UsageDashboardResult, UsageDayData } from './store.js';

/**
 * 使用量まわり（まとめ画面「使用量」と、コスト / 利用上限 / RTK の節約 / GitHub API / システム）で
 * 共有する表示用の計算。画面ごとに書くと「更新時刻の書き方」や「今日の範囲」がずれるので、
 * ここに寄せて画面は呼ぶだけにする。
 */

/** `formatRelativeTime` は60秒未満を「今」と返すので、そのまま「〜に更新」へ繋ぐと「今に更新」になる。 */
const JUST_NOW_MS = 60_000;

/** ヘッダーの副題に出す「5分前に更新」。どの画面も同じ書き方にする。 */
export function updatedAtLabel(at: number, now: number): string {
	return now - at < JUST_NOW_MS ? 'たった今更新' : `${formatRelativeTime(at, now)}に更新`;
}

/**
 * 接続先が応答していない間、薄く残している直近の値に添える一文。
 * 薄くするだけだと「読み込み中」なのか「古い」のか区別が付かないので、いつの値で、
 * なぜ更新されないのかを文字で書く。
 */
export function staleValueLabel(at: number, now: number): string {
	const age = now - at < JUST_NOW_MS ? 'たった今' : formatRelativeTime(at, now);
	return `${age}の値です（接続先が応答するまで更新されません）`;
}

/** '3d 12h' / '2h 27m' / '41m' 形式の残り時間（PC版 paradisLimitsFormatCountdown と同じ規則）。 */
export function formatLimitCountdown(resetsAt: number | undefined, now: number): string | undefined {
	if (resetsAt === undefined || !isFinite(resetsAt)) { return undefined; }
	const remainingMs = resetsAt - now;
	if (remainingMs <= 0) { return undefined; }
	const totalMinutes = Math.ceil(remainingMs / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) { return `${days}d ${hours}h`; }
	if (hours > 0) { return `${hours}h ${minutes}m`; }
	return `${minutes}m`;
}

/** ローカル日付の YYYY-MM-DD（PC側 daily の period と同じ形式）。 */
export function localDateKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** その日のうち、選んだエージェントぶんだけのコスト合計（'all' は全エージェント）。 */
export function dayCost(day: UsageDayData, agent: UsageAgent | 'all'): number {
	return day.models.reduce((sum, m) => (agent === 'all' || m.agent === agent ? sum + m.cost : sum), 0);
}

/** 今日のコスト。記録の無い日は 0。 */
export function todayCost(data: UsageDashboardResult, now: number, agent: UsageAgent | 'all' = 'all'): number {
	const today = localDateKey(new Date(now));
	const row = data.days.find(d => d.date === today);
	return row !== undefined ? dayCost(row, agent) : 0;
}

/**
 * まとめ画面に1つだけ出すアカウント。いま使っていて値の取れているものを優先し、
 * 次に値の取れている最初のもの、最後に使用中のもの（値は取れていないが状態を伝える）を選ぶ。
 */
export function pickRateLimitAccount(snapshot: RateLimitProviderSnapshot): RateLimitAccount | undefined {
	const accounts = snapshot.accounts;
	return accounts.find(a => a.active === true && a.status === 'ok')
		?? accounts.find(a => a.status === 'ok')
		?? accounts.find(a => a.active === true)
		?? accounts[0];
}

/** 使用率（0〜1）。上限が0以下（取得できていない）なら 0。 */
export function usedRatio(used: number, limit: number): number {
	return limit > 0 && isFinite(used) ? Math.min(1, Math.max(0, used / limit)) : 0;
}

/**
 * PCのリソースの度合いの色。平常時は緑にして、黄（警告）と見分けが付くようにする。
 * 以前のシステム画面は RAM だけ平常時から黄色で描いており、警告なのかどうか区別できなかった。
 * 度合いの判定（しきい値）は `systemResources.ts` の `usageLevel` / `diskLevel` に任せる。
 */
export function resourceLevelColor(level: UsageLevel): string {
	return level === 'critical' ? colors.red : level === 'warn' ? colors.yellow : colors.green;
}
