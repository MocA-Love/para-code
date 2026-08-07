// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { SpaceDiskResult, SystemResourcesResult, SystemScopeMetrics } from './store.js';

/**
 * 「システム」画面とワークスペースドロワーのPCカードが共有する、表示用の計算。
 * 画面側に散らすと閾値の色分けが場所ごとにずれるので、判定はすべてここに集約する。
 */

/** 逼迫の度合い。normal=色を付けない / warn=黄 / critical=赤。 */
export type UsageLevel = 'normal' | 'warn' | 'critical';

export interface UsageThresholds {
	/** この%以上で warn。 */
	warn: number;
	/** この%以上で critical。 */
	critical: number;
}

/** CPUは瞬間的に跳ねるので、警告はやや高めから。 */
export const CPU_THRESHOLDS: UsageThresholds = { warn: 75, critical: 92 };
/** メモリはスワップが始まると体感が急落するため早めに。 */
export const MEMORY_THRESHOLDS: UsageThresholds = { warn: 78, critical: 92 };
/** ディスクは使用率が高いだけでは問題にならないので高め。空き容量の判定と併用する。 */
export const DISK_THRESHOLDS: UsageThresholds = { warn: 88, critical: 96 };
/**
 * 使用率に関わらず、これを切ったら critical 扱いにする空き容量。
 * 大容量ディスクでも「ビルドが落ちる」のは絶対量で決まるため。
 */
export const DISK_CRITICAL_FREE_BYTES = 10 * 1024 * 1024 * 1024;
/** 同じく warn 扱いにする空き容量。 */
export const DISK_WARN_FREE_BYTES = 25 * 1024 * 1024 * 1024;

/** 0除算を避けた使用率(0〜100)。 */
export function usagePercent(used: number, total: number): number {
	if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
		return 0;
	}
	return Math.min(100, Math.max(0, (used / total) * 100));
}

export function usageLevel(percent: number, thresholds: UsageThresholds): UsageLevel {
	if (percent >= thresholds.critical) {
		return 'critical';
	}
	if (percent >= thresholds.warn) {
		return 'warn';
	}
	return 'normal';
}

/** ディスクは使用率と空き容量の厳しいほうを採る。 */
export function diskLevel(total: number, free: number): UsageLevel {
	const byPercent = usageLevel(usagePercent(Math.max(0, total - free), total), DISK_THRESHOLDS);
	const byFree: UsageLevel = free <= DISK_CRITICAL_FREE_BYTES ? 'critical' : free <= DISK_WARN_FREE_BYTES ? 'warn' : 'normal';
	const order: UsageLevel[] = ['normal', 'warn', 'critical'];
	return order.indexOf(byPercent) >= order.indexOf(byFree) ? byPercent : byFree;
}

/** 3つのうち最も厳しい度合い。ドロワーのカード全体の色に使う。 */
export function worstLevel(levels: readonly UsageLevel[]): UsageLevel {
	if (levels.includes('critical')) {
		return 'critical';
	}
	return levels.includes('warn') ? 'warn' : 'normal';
}

/**
 * バイトを人が読む単位へ。GB以上は小数1桁、MB以下は整数（桁が増えても行が伸びないように）。
 */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) {
		return '—';
	}
	const kb = 1024;
	const mb = kb * 1024;
	const gb = mb * 1024;
	const tb = gb * 1024;
	if (bytes >= tb) {
		return `${(bytes / tb).toFixed(1)} TB`;
	}
	if (bytes >= gb) {
		return `${(bytes / gb).toFixed(1)} GB`;
	}
	if (bytes >= mb) {
		return `${Math.round(bytes / mb)} MB`;
	}
	if (bytes >= kb) {
		return `${Math.round(bytes / kb)} KB`;
	}
	return `${Math.round(bytes)} B`;
}

/** CPU使用率の表示。マルチコアで100%を超え得る内訳側でも同じ書式を使う。 */
export function formatCpu(percent: number | undefined): string {
	if (percent === undefined || !Number.isFinite(percent)) {
		return '—';
	}
	return `${Math.round(percent)}%`;
}

/** 「システム」画面の内訳1行。 */
export interface ResourceRow {
	key: string;
	name: string;
	sub: string;
	cpu: number;
	memory: number;
}

/**
 * プロセス軸の内訳。Para Code本体（ウィンドウ・拡張ホスト）と、監視対象ターミナルの
 * プロセスツリーを1つのリストにしてメモリ降順で返す。
 */
export function buildProcessRows(report: SystemResourcesResult): ResourceRow[] {
	const rows: ResourceRow[] = [{
		key: '__paracode__',
		name: 'Para Code',
		sub: 'ウィンドウ・拡張ホスト',
		cpu: report.snapshot.app.cpu,
		memory: report.snapshot.app.memory,
	}];
	for (const scope of report.snapshot.scopes) {
		for (const session of scope.sessions) {
			rows.push({
				key: `${scope.stateKey}:${session.pid}`,
				name: session.name,
				sub: scope.scopeName,
				cpu: session.cpu,
				memory: session.memory,
			});
		}
	}
	return rows.sort((a, b) => b.memory - a.memory);
}

/** スペース（ワークスペース／worktree）軸の内訳。Para Code本体は特定のスペースに属さないので含めない。 */
export function buildScopeRows(report: SystemResourcesResult): ResourceRow[] {
	return report.snapshot.scopes
		.map((scope: SystemScopeMetrics) => ({
			key: scope.stateKey,
			name: scope.scopeName,
			sub: `${scope.sessions.length} ターミナル`,
			cpu: scope.cpu,
			memory: scope.memory,
		}))
		.sort((a, b) => b.memory - a.memory);
}

/**
 * 内訳を1つの指標で降順に並べ替える。
 *
 * 以前は1行にCPUとメモリの2本のバーを重ねて出していたが、どちらがどちらか色でしか
 * 区別できず（凡例はリストの最下部に1度だけ）、順序もメモリ基準の1通りしか無かった。
 * 「CPUを食っているのは何か」と「メモリを食っているのは何か」は別々に見たい問いなので、
 * 指標ごとに並べ替えた独立のリストへ分ける。
 */
export function sortRowsBy(rows: readonly ResourceRow[], metric: 'cpu' | 'memory'): ResourceRow[] {
	return [...rows].sort((a, b) => b[metric] - a[metric]);
}

/** 「システム」画面のボリューム内訳に出すスペース1行。 */
export interface SpaceDiskRow {
	key: string;
	name: string;
	/** worktree を含めた合計。 */
	totalBytes: number;
	/** worktree を除いた本体。 */
	ownBytes: number;
	worktrees: { key: string; name: string; bytes: number; outside: boolean; error?: string; truncated?: boolean }[];
	error?: string;
	/** 上限に達して数え切れなかった（値は「少なくともこれだけ」）。 */
	truncated?: boolean;
}

/**
 * スペースのディスク使用量を、大きい順に並べた表示用の行にする。
 *
 * PC側は「本体（worktreeを除いた分）」と「worktreeそれぞれ」を分けて返す。合計は
 * ここで足す。**PC側で引き算済みなので、ここで再度引いてはいけない**（本体が小さく出る）。
 */
export function buildSpaceDiskRows(result: SpaceDiskResult): SpaceDiskRow[] {
	return result.spaces
		.map(space => ({
			key: space.stateKey,
			name: space.name,
			ownBytes: space.ownBytes,
			totalBytes: space.ownBytes + space.worktrees.reduce((sum, w) => sum + w.bytes, 0),
			worktrees: [...space.worktrees]
				.sort((a, b) => b.bytes - a.bytes)
				// error / truncated を落とすと、測れなかった worktree が「0 B」として並び、
				// 本当に空なのか失敗したのか区別できなくなる。
				.map(w => ({ key: w.stateKey, name: w.name, bytes: w.bytes, outside: w.outside, error: w.error, truncated: w.truncated })),
			error: space.error,
			truncated: space.truncated,
		}))
		.sort((a, b) => b.totalBytes - a.totalBytes);
}
