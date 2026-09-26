// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { WidgetAgent, WidgetPc } from '../../widgets/snapshot.js';
import type { WidgetPcMetric, WidgetSettings } from '../../widgets/settings.js';

/**
 * 設定 → ウィジェットのプレビューの材料（純関数）。見本のデータは架空のもの（モックと同じ筋書き）で、
 * 並べ方・絞り込み・指標の選び方は Swift のウィジェット（`native/ParaCodeWidgets/*Widget.swift`）と同じ規則にする。
 * プレビューは近似で、実際のウィジェットと寸分違わないことは狙わない。
 */

export type WidgetDesign = 'attention' | 'agents' | 'pcStatus' | 'space';
export type WidgetPreviewSize = 'small' | 'medium' | 'large';

export const WIDGET_DESIGN_LABELS: Readonly<Record<WidgetDesign, string>> = {
	attention: '要対応',
	agents: 'エージェント',
	pcStatus: 'PC の状態',
	space: 'スペース',
};

export const WIDGET_SIZE_LABELS: Readonly<Record<WidgetPreviewSize, string>> = {
	small: '小',
	medium: '中',
	large: '大',
};

const MINUTE = 60_000;

/** 見本の PC（架空）。`now` を基準に時刻を作る。 */
export function samplePc(now: number): WidgetPc {
	return {
		id: 'sample-pc',
		name: 'MacBook Pro',
		online: true,
		lastSeenAt: now,
		updatedAt: now - 2 * MINUTE,
		battery: { level: 76, charging: false },
		resources: { cpu: 34, memPercent: 71, memTotal: 36 * 1_073_741_824, diskFree: 182 * 1_073_741_824, diskTotal: 1000 * 1_073_741_824 },
		usage: {
			todayCost: 4.12,
			costClaude: 3.05,
			costCodex: 1.07,
			limits: [
				{ key: 'claude5h', label: 'Claude 5時間', usedPercent: 62, resetsAt: now + 80 * MINUTE },
				{ key: 'claudeWeek', label: 'Claude 週', usedPercent: 38, resetsAt: now + 3 * 24 * 60 * MINUTE },
				{ key: 'codex5h', label: 'Codex 5時間', usedPercent: 21, resetsAt: now + 125 * MINUTE },
				{ key: 'codexWeek', label: 'Codex 週', usedPercent: 14, resetsAt: now + 5 * 24 * 60 * MINUTE },
			],
			fetchedAt: now - 9 * MINUTE,
		},
		attention: 2,
		agents: [
			{ key: 's-auth', title: '認証フローの整理', kind: 'claude', spaceId: 's1', state: 'approve', since: now - 3 * MINUTE, detail: 'Bash: pnpm test --filter relay' },
			{ key: 's-relay', title: '再接続のテスト', kind: 'codex', spaceId: 's2', state: 'question', since: now - MINUTE, detail: '再接続の待ち時間の上限は 30 秒でよいですか' },
			{ key: 's-diff', title: '差分ビューの配色', kind: 'claude', spaceId: 's1', state: 'running', since: now - 12 * MINUTE },
			{ key: 's-readme', title: 'README の更新', kind: 'codex', spaceId: 's3', state: 'unread', since: now - 25 * MINUTE },
			{ key: 's-build', title: '夜間ビルドの確認', kind: 'codex', spaceId: 's3', state: 'idle' },
		],
		spaces: [
			{ id: 's1', name: 'sample-app', branch: 'feature/widgets', changes: 5, files: [{ code: 'A', path: 'src/widgets/sync.ts' }, { code: 'M', path: 'src/app.ts' }, { code: 'M', path: 'README.md' }, { code: 'M', path: 'app.json' }, { code: 'D', path: 'old.ts' }], commits: [{ subject: '再接続の待ち時間を短くする', at: now - 12 * MINUTE }, { subject: '配色をそろえる', at: now - 60 * MINUTE }] },
			{ id: 's2', name: 'relay-retry', branch: 'relay-retry', changes: 2 },
			{ id: 's3', name: 'docs', branch: 'docs', changes: 1 },
		],
	};
}

const STATE_RANK: Readonly<Record<WidgetAgent['state'], number>> = { approve: 0, question: 1, error: 2, running: 3, unread: 4, idle: 5 };

/** 案 A の行（待機を除く）。要対応を先に、同じ状態の中は設定の並び。 */
export function attentionRows(agents: readonly WidgetAgent[], settings: WidgetSettings): WidgetAgent[] {
	const newest = settings.attention.order === 'newest';
	return agents.filter(agent => agent.state !== 'idle').sort((a, b) => {
		const byState = STATE_RANK[a.state] - STATE_RANK[b.state];
		if (byState !== 0) {
			return byState;
		}
		const ta = a.since ?? (newest ? -Infinity : Infinity);
		const tb = b.since ?? (newest ? -Infinity : Infinity);
		return newest ? tb - ta : ta - tb;
	});
}

/** 案 B の行。設定で選んだ状態だけを、設定の並びで。 */
export function listedAgents(agents: readonly WidgetAgent[], settings: WidgetSettings): WidgetAgent[] {
	const filters = new Set(settings.agents.states);
	const filtered = agents.filter(agent => {
		switch (agent.state) {
			case 'approve':
			case 'question':
			case 'error':
				return filters.has('attention');
			case 'running':
				return filters.has('running');
			case 'unread':
				return filters.has('unread');
			default:
				return filters.has('idle');
		}
	});
	if (settings.agents.order === 'newest') {
		return filtered.sort((a, b) => (b.since ?? -Infinity) - (a.since ?? -Infinity));
	}
	return filtered.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (a.since ?? Infinity) - (b.since ?? Infinity));
}

export interface PreviewMetric {
	readonly key: WidgetPcMetric;
	readonly label: string;
	readonly short: string;
	readonly value: string;
	/** 0〜100。バーやリングに使う。 */
	readonly percent: number | undefined;
	readonly sub: string | undefined;
}

function hoursLabel(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / MINUTE));
	const days = Math.floor(minutes / (60 * 24));
	if (days > 0) {
		return `${days}日後`;
	}
	const hours = Math.floor(minutes / 60);
	return hours > 0 ? `${hours}時間${minutes % 60 > 0 ? `${minutes % 60}分` : ''}後` : `${minutes}分後`;
}

/** 案 C の指標（設定で選んだもの、取れているものだけ、設定の並びで）。 */
export function pcMetrics(pc: WidgetPc, settings: WidgetSettings, now: number): PreviewMetric[] {
	const result: PreviewMetric[] = [];
	for (const key of settings.pc.metrics) {
		const metric = pcMetric(pc, key, now);
		if (metric !== undefined) {
			result.push(metric);
		}
	}
	return result;
}

function pcMetric(pc: WidgetPc, key: WidgetPcMetric, now: number): PreviewMetric | undefined {
	switch (key) {
		case 'battery':
			return pc.battery === undefined
				? { key, label: '電源', short: '電池', value: '電源', percent: undefined, sub: undefined }
				: { key, label: '電池', short: '電池', value: `${pc.battery.level}%`, percent: pc.battery.level, sub: pc.battery.charging ? '充電中' : undefined };
		case 'cpu':
			return pc.resources?.cpu === undefined ? undefined : { key, label: 'CPU', short: 'CPU', value: `${Math.round(pc.resources.cpu)}%`, percent: pc.resources.cpu, sub: undefined };
		case 'memory':
			return pc.resources?.memPercent === undefined ? undefined : { key, label: 'メモリ', short: 'メモリ', value: `${Math.round(pc.resources.memPercent)}%`, percent: pc.resources.memPercent, sub: undefined };
		case 'disk': {
			const free = pc.resources?.diskFree;
			const total = pc.resources?.diskTotal;
			if (free === undefined) {
				return undefined;
			}
			return { key, label: 'SSD の空き', short: 'SSD 空き', value: `${Math.round(free / 1_073_741_824)} GB`, percent: total !== undefined && total > 0 ? ((total - free) / total) * 100 : undefined, sub: undefined };
		}
		case 'cost':
			return pc.usage?.todayCost === undefined ? undefined : { key, label: '今日のコスト', short: '今日', value: `$${pc.usage.todayCost.toFixed(2)}`, percent: undefined, sub: undefined };
		default: {
			const limit = pc.usage?.limits.find(item => item.key === key);
			if (limit === undefined) {
				return undefined;
			}
			return {
				key,
				label: limit.label,
				short: limit.label.replace('5時間', '5h'),
				value: `${Math.round(limit.usedPercent)}%`,
				percent: limit.usedPercent,
				sub: limit.resetsAt !== undefined ? `${hoursLabel(limit.resetsAt - now)}にリセット` : undefined,
			};
		}
	}
}
