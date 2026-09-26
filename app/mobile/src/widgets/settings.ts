// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ウィジェットの見た目と表示項目の、アプリ内の設定（設定 → ウィジェット）。
 *
 * App Group の `widget-settings.json` に書き、ウィジェットは要約と一緒に読む。形は Swift 側
 * （`native/ParaCodeWidgets/WidgetShared.swift` の `WidgetAppSettings`）と一致させること。
 * ウィジェット自身の設定（長押し →「ウィジェットを編集」で選ぶ PC・スペース・並び順など）と重なる項目は
 * **ウィジェット側を優先**し、ここの値は「ウィジェット側で既定のままにしたとき」の値として使う。
 *
 * 形の判定・既定値・並べ替えは純関数（`settings.test.ts`）。保存は `widgetSettingsStore.ts`。
 */

export const WIDGET_SETTINGS_VERSION = 1;

/** アクセントの色。`theme` は「設定 → 色」の主ボタンの色に合わせる。 */
export type WidgetAccent = 'theme' | 'mono' | 'blue' | 'green' | 'orange' | 'purple' | 'pink';

export const WIDGET_ACCENTS: readonly WidgetAccent[] = ['theme', 'mono', 'blue', 'green', 'orange', 'purple', 'pink'];

export const WIDGET_ACCENT_LABELS: Readonly<Record<WidgetAccent, string>> = {
	theme: '主ボタンの色に合わせる',
	mono: '白黒',
	blue: '青',
	green: '緑',
	orange: '橙',
	purple: '紫',
	pink: '桃',
};

/** 固定のアクセント（`theme` と `mono` 以外）。`mono` はウィジェットの文字色をそのまま使う。 */
export const WIDGET_ACCENT_HEX: Readonly<Record<Exclude<WidgetAccent, 'theme' | 'mono'>, string>> = {
	blue: '#3b82f6',
	green: '#10b981',
	orange: '#f59e0b',
	purple: '#8b5cf6',
	pink: '#ec4899',
};

/** 「◯分前の状態」を出す場面。 */
export type WidgetFreshness = 'always' | 'stale';

export const WIDGET_FRESHNESS_LABELS: Readonly<Record<WidgetFreshness, string>> = {
	always: 'いつも出す',
	stale: '古いときだけ（5分以上）',
};

/** 要対応（案 A）の並び。 */
export type WidgetAttentionOrder = 'oldest' | 'newest';

export const WIDGET_ATTENTION_ORDER_LABELS: Readonly<Record<WidgetAttentionOrder, string>> = {
	oldest: '待たせている順',
	newest: '新しい順',
};

/** エージェント一覧（案 B）で出す状態のまとまり。 */
export type WidgetAgentFilter = 'attention' | 'running' | 'unread' | 'idle';

export const WIDGET_AGENT_FILTERS: readonly WidgetAgentFilter[] = ['attention', 'running', 'unread', 'idle'];

export const WIDGET_AGENT_FILTER_LABELS: Readonly<Record<WidgetAgentFilter, string>> = {
	attention: '要対応',
	running: '実行中',
	unread: '未確認',
	idle: '待機',
};

/** エージェント一覧（案 B）の並び。 */
export type WidgetAgentsOrder = 'attention' | 'newest';

export const WIDGET_AGENTS_ORDER_LABELS: Readonly<Record<WidgetAgentsOrder, string>> = {
	attention: '要対応を先に',
	newest: '新しく動いた順',
};

/** エージェント一覧（大）に出す行数の範囲。 */
export const WIDGET_AGENTS_LIMIT_MIN = 3;
export const WIDGET_AGENTS_LIMIT_MAX = 8;

/** PC の状態（案 C）に出す指標。並びはこの配列の順（設定で並べ替えられる）。 */
export type WidgetPcMetric = 'battery' | 'cpu' | 'memory' | 'disk' | 'cost' | 'claude5h' | 'claudeWeek' | 'codex5h' | 'codexWeek';

export const WIDGET_PC_METRICS: readonly WidgetPcMetric[] = ['battery', 'cpu', 'memory', 'disk', 'cost', 'claude5h', 'claudeWeek', 'codex5h', 'codexWeek'];

export const WIDGET_PC_METRIC_LABELS: Readonly<Record<WidgetPcMetric, string>> = {
	battery: 'バッテリー',
	cpu: 'CPU',
	memory: 'メモリ',
	disk: 'SSD の空き',
	cost: '今日のコスト',
	claude5h: 'Claude 5時間の上限',
	claudeWeek: 'Claude 週の上限',
	codex5h: 'Codex 5時間の上限',
	codexWeek: 'Codex 週の上限',
};

export interface WidgetSpaceRef {
	readonly pcId: string;
	readonly spaceId: string;
}

export interface WidgetSettings {
	readonly v: typeof WIDGET_SETTINGS_VERSION;
	readonly accent: WidgetAccent;
	/** ホーム画面にエージェント名・スペース名を出す（ロック画面は OS の設定に従って隠す）。 */
	readonly showNames: boolean;
	/** 質問文とコマンドを出す（既定は出さない。オフのときは要約にも入れない）。 */
	readonly showDetail: boolean;
	readonly freshness: WidgetFreshness;
	readonly attention: {
		readonly order: WidgetAttentionOrder;
		readonly showApprove: boolean;
		readonly showAnswer: boolean;
		readonly showReview: boolean;
	};
	readonly agents: {
		readonly states: readonly WidgetAgentFilter[];
		readonly order: WidgetAgentsOrder;
		readonly limit: number;
	};
	readonly pc: {
		/** 出す指標（並びどおり）。 */
		readonly metrics: readonly WidgetPcMetric[];
	};
	readonly space: {
		/** ウィジェット側でスペースを選んでいないときに出すスペース。無ければいま見ているスペース。 */
		readonly defaultSpace?: WidgetSpaceRef;
		readonly showAgents: boolean;
		readonly showChanges: boolean;
		readonly showCommits: boolean;
	};
}

export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = {
	v: WIDGET_SETTINGS_VERSION,
	accent: 'mono',
	showNames: true,
	showDetail: false,
	freshness: 'always',
	attention: { order: 'oldest', showApprove: true, showAnswer: true, showReview: true },
	agents: { states: ['attention', 'running', 'unread', 'idle'], order: 'attention', limit: 8 },
	pc: { metrics: ['battery', 'cpu', 'memory', 'cost', 'claude5h', 'claudeWeek', 'codex5h'] },
	space: { showAgents: true, showChanges: true, showCommits: true },
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

/** 並びを保ったまま、許された値だけを重複なく残す。 */
function pickList<T extends string>(value: unknown, allowed: readonly T[], fallback: readonly T[]): T[] {
	if (!Array.isArray(value)) {
		return [...fallback];
	}
	const result: T[] = [];
	for (const item of value) {
		if (typeof item === 'string' && (allowed as readonly string[]).includes(item) && !result.includes(item as T)) {
			result.push(item as T);
		}
	}
	return result;
}

export function clampAgentsLimit(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_WIDGET_SETTINGS.agents.limit;
	}
	return Math.min(WIDGET_AGENTS_LIMIT_MAX, Math.max(WIDGET_AGENTS_LIMIT_MIN, Math.round(value)));
}

function pickSpaceRef(value: unknown): WidgetSpaceRef | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const pcId = value['pcId'];
	const spaceId = value['spaceId'];
	if (typeof pcId !== 'string' || pcId.length === 0 || pcId.length > 200 || typeof spaceId !== 'string' || spaceId.length === 0 || spaceId.length > 500) {
		return undefined;
	}
	return { pcId, spaceId };
}

/**
 * 保存された値を検証して、足りないところを既定で埋める。形が壊れていれば既定を返す
 * （古い版で保存した値に新しい項目が無くても、その項目だけ既定になる）。
 */
export function normalizeWidgetSettings(raw: unknown): WidgetSettings {
	if (!isRecord(raw)) {
		return DEFAULT_WIDGET_SETTINGS;
	}
	const d = DEFAULT_WIDGET_SETTINGS;
	const attention = isRecord(raw['attention']) ? raw['attention'] : {};
	const agents = isRecord(raw['agents']) ? raw['agents'] : {};
	const pc = isRecord(raw['pc']) ? raw['pc'] : {};
	const space = isRecord(raw['space']) ? raw['space'] : {};
	const defaultSpace = pickSpaceRef(space['defaultSpace']);
	return {
		v: WIDGET_SETTINGS_VERSION,
		accent: pickEnum(raw['accent'], WIDGET_ACCENTS, d.accent),
		showNames: pickBoolean(raw['showNames'], d.showNames),
		showDetail: pickBoolean(raw['showDetail'], d.showDetail),
		freshness: pickEnum(raw['freshness'], ['always', 'stale'] as const, d.freshness),
		attention: {
			order: pickEnum(attention['order'], ['oldest', 'newest'] as const, d.attention.order),
			showApprove: pickBoolean(attention['showApprove'], d.attention.showApprove),
			showAnswer: pickBoolean(attention['showAnswer'], d.attention.showAnswer),
			showReview: pickBoolean(attention['showReview'], d.attention.showReview),
		},
		agents: {
			states: pickList(agents['states'], WIDGET_AGENT_FILTERS, d.agents.states),
			order: pickEnum(agents['order'], ['attention', 'newest'] as const, d.agents.order),
			limit: clampAgentsLimit(agents['limit']),
		},
		pc: {
			metrics: pickList(pc['metrics'], WIDGET_PC_METRICS, d.pc.metrics),
		},
		space: {
			...(defaultSpace !== undefined ? { defaultSpace } : {}),
			showAgents: pickBoolean(space['showAgents'], d.space.showAgents),
			showChanges: pickBoolean(space['showChanges'], d.space.showChanges),
			showCommits: pickBoolean(space['showCommits'], d.space.showCommits),
		},
	};
}

/** 保存した文字列を読む。読めなければ既定。 */
export function parseWidgetSettings(raw: string | null | undefined): WidgetSettings {
	if (raw === null || raw === undefined || raw.length === 0) {
		return DEFAULT_WIDGET_SETTINGS;
	}
	try {
		return normalizeWidgetSettings(JSON.parse(raw));
	} catch {
		return DEFAULT_WIDGET_SETTINGS;
	}
}

/** `#rrggbb` の形か。 */
export function isHexColor(value: string): boolean {
	return /^#[0-9a-f]{6}$/i.test(value);
}

/**
 * アクセントの実際の色。`theme` は主ボタンの色、`mono` は undefined（ウィジェットの文字色を使う）。
 * 主ボタンの色が壊れていたら `mono` と同じ扱いにする。
 */
export function resolveWidgetAccentHex(accent: WidgetAccent, themePrimaryHex: string | undefined): string | undefined {
	if (accent === 'mono') {
		return undefined;
	}
	if (accent === 'theme') {
		return themePrimaryHex !== undefined && isHexColor(themePrimaryHex) ? themePrimaryHex.toLowerCase() : undefined;
	}
	return WIDGET_ACCENT_HEX[accent];
}

/**
 * App Group へ書く JSON。ウィジェットは色の計算を持たないので、解決済みの色（`accentHex`）を添える。
 */
export function serializeWidgetSettings(settings: WidgetSettings, themePrimaryHex: string | undefined): string {
	const accentHex = resolveWidgetAccentHex(settings.accent, themePrimaryHex);
	return JSON.stringify({ ...settings, ...(accentHex !== undefined ? { accentHex } : {}) });
}

/** 指標を1つ上（-1）・下（+1）へ動かす。端なら同じものを返す。 */
export function moveMetric(metrics: readonly WidgetPcMetric[], metric: WidgetPcMetric, delta: -1 | 1): WidgetPcMetric[] {
	const index = metrics.indexOf(metric);
	const target = index + delta;
	if (index < 0 || target < 0 || target >= metrics.length) {
		return [...metrics];
	}
	const next = [...metrics];
	next[index] = metrics[target] as WidgetPcMetric;
	next[target] = metric;
	return next;
}

/** 指標の表示を切り替える。出すときは既定の並びで近い位置へ差し込む。 */
export function toggleMetric(metrics: readonly WidgetPcMetric[], metric: WidgetPcMetric): WidgetPcMetric[] {
	if (metrics.includes(metric)) {
		return metrics.filter(item => item !== metric);
	}
	const order = WIDGET_PC_METRICS.indexOf(metric);
	const insertAt = metrics.findIndex(item => WIDGET_PC_METRICS.indexOf(item) > order);
	return insertAt < 0 ? [...metrics, metric] : [...metrics.slice(0, insertAt), metric, ...metrics.slice(insertAt)];
}

/** 状態の絞り込みを切り替える。最後の1つは外せない（何も出ないウィジェットにしない）。 */
export function toggleAgentFilter(states: readonly WidgetAgentFilter[], state: WidgetAgentFilter): WidgetAgentFilter[] {
	if (states.includes(state)) {
		return states.length <= 1 ? [...states] : states.filter(item => item !== state);
	}
	return WIDGET_AGENT_FILTERS.filter(item => item === state || states.includes(item));
}
