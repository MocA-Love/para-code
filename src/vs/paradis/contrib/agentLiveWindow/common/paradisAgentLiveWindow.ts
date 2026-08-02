/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';

/**
 * ライブウィンドウが扱う状態。エージェント実績はあるが hook 上は何も走っていない端末を
 * 'idle' として明示的に持つ (状態ストアは実行中のものしか持たないため、ここで補う)。
 */
export type ParadisAgentLiveStatus = ParadisAgentStatus | 'idle';

/** チップの並び順であり、状態グループの表示順であり、「状態順」ソートの優先度でもある。 */
export const PARADIS_AGENT_LIVE_STATUS_ORDER: readonly ParadisAgentLiveStatus[] = ['permission', 'question', 'working', 'review', 'idle'];

/** 手が止まっていてユーザーの操作を待っている状態。「要対応のみ」フィルタの定義。 */
export function paradisIsAttentionStatus(status: ParadisAgentLiveStatus): boolean {
	return status === 'permission' || status === 'question';
}

/** ライブウィンドウのタイル1枚分。 */
export interface IParadisAgentLiveEntry {
	/**
	 * ペイントークン。手動並び順・ピン・非表示の永続キーはこれを使う。instanceId は
	 * ウィンドウリロードで振り直されるため、跨ぐと別の端末の位置が入れ替わる。
	 */
	readonly token: string;
	readonly instanceId: number;
	/** 所属スペースの状態キー。park 台帳にも載っていない端末では undefined */
	readonly stateKey: string | undefined;
	readonly spaceName: string;
	/** スペース色 (hex)。未設定のリポジトリでは undefined */
	readonly spaceColor: string | undefined;
	/** ブランチ名など、スペース名の下に出す補足 */
	readonly detail: string;
	/** ターミナルタイトル */
	readonly title: string;
	readonly status: ParadisAgentLiveStatus;
	/**
	 * 現在の状態を最初に観測した時刻 (epoch ms)。状態ストアは状態が変わった時刻を保持しない
	 * ため、モデル側で観測ベースに記録する。ウィンドウを開く前から続いている状態については
	 * 「観測を始めてからの時間」になる。
	 */
	readonly since: number;
	/** 最後に出力があった時刻 (epoch ms)。「最後に動いた順」ソート用 */
	readonly lastOutputAt: number;
}

/** タイトルバーのボタンが出すバッジの材料。 */
export interface IParadisAgentLiveSummary {
	/** ライブウィンドウに載る端末の総数 (待機も含む) */
	readonly total: number;
	/** 実行中・要対応など、待機以外の数 */
	readonly active: number;
	/** 許可待ち・質問中の数。1以上ならバッジを警告色にする */
	readonly attention: number;
	readonly byStatus: ReadonlyMap<ParadisAgentLiveStatus, number>;
}

export const IParadisAgentLiveWindowService = createDecorator<IParadisAgentLiveWindowService>('paradisAgentLiveWindowService');

/**
 * 稼働中エージェントのライブウィンドウ (別ウィンドウ) を管理するサービス。
 * ウィンドウを開いていない間もサマリだけは更新し続ける (タイトルバーのバッジのため)。
 */
export interface IParadisAgentLiveWindowService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSummary: Event<void>;
	readonly summary: IParadisAgentLiveSummary;
	/** 開いていなければ開き、開いていれば前面に出す。 */
	open(): Promise<void>;
}

export type ParadisAgentLiveSort = 'attention' | 'status' | 'elapsed' | 'updated' | 'space' | 'manual';
export type ParadisAgentLiveGroup = 'none' | 'space' | 'status';

export interface IParadisAgentLiveViewState {
	/** 空 = 全状態を表示 */
	statuses: ParadisAgentLiveStatus[];
	/** undefined = 全スペースを表示 */
	spaces: string[] | undefined;
	attentionOnly: boolean;
	sort: ParadisAgentLiveSort;
	sortDesc: boolean;
	group: ParadisAgentLiveGroup;
	columns: number;
	dense: boolean;
	pinTop: boolean;
	/** 手動並び順 (ペイントークン) */
	manualOrder: string[];
	pinned: string[];
	hidden: string[];
}

export const PARADIS_AGENT_LIVE_MIN_COLUMNS = 1;
export const PARADIS_AGENT_LIVE_MAX_COLUMNS = 4;

export function paradisDefaultAgentLiveViewState(): IParadisAgentLiveViewState {
	return {
		statuses: [],
		spaces: undefined,
		attentionOnly: false,
		sort: 'attention',
		sortDesc: true,
		group: 'none',
		columns: 3,
		dense: false,
		pinTop: true,
		manualOrder: [],
		pinned: [],
		hidden: [],
	};
}

const SORTS: readonly ParadisAgentLiveSort[] = ['attention', 'status', 'elapsed', 'updated', 'space', 'manual'];
const GROUPS: readonly ParadisAgentLiveGroup[] = ['none', 'space', 'status'];

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

/**
 * 保存済みビュー状態を読み戻す。壊れた値・未知の値は既定へ落とす (保存形式を将来変えても
 * 起動不能にならないようにするため、例外は投げない)。
 */
export function paradisParseAgentLiveViewState(raw: string | undefined): IParadisAgentLiveViewState {
	const state = paradisDefaultAgentLiveViewState();
	if (!raw) {
		return state;
	}
	let parsed: Record<string, unknown>;
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== 'object') {
			return state;
		}
		parsed = value as Record<string, unknown>;
	} catch {
		return state;
	}

	const statuses = stringArray(parsed.statuses);
	if (statuses) {
		state.statuses = statuses.filter((status): status is ParadisAgentLiveStatus => (PARADIS_AGENT_LIVE_STATUS_ORDER as readonly string[]).includes(status));
	}
	const spaces = stringArray(parsed.spaces);
	state.spaces = spaces && spaces.length > 0 ? spaces : undefined;
	state.attentionOnly = parsed.attentionOnly === true;
	if (typeof parsed.sort === 'string' && (SORTS as readonly string[]).includes(parsed.sort)) {
		state.sort = parsed.sort as ParadisAgentLiveSort;
	}
	state.sortDesc = parsed.sortDesc !== false;
	if (typeof parsed.group === 'string' && (GROUPS as readonly string[]).includes(parsed.group)) {
		state.group = parsed.group as ParadisAgentLiveGroup;
	}
	if (typeof parsed.columns === 'number' && Number.isFinite(parsed.columns)) {
		state.columns = Math.min(PARADIS_AGENT_LIVE_MAX_COLUMNS, Math.max(PARADIS_AGENT_LIVE_MIN_COLUMNS, Math.round(parsed.columns)));
	}
	state.dense = parsed.dense === true;
	state.pinTop = parsed.pinTop !== false;
	state.manualOrder = stringArray(parsed.manualOrder) ?? [];
	state.pinned = stringArray(parsed.pinned) ?? [];
	state.hidden = stringArray(parsed.hidden) ?? [];
	return state;
}

export function paradisSerializeAgentLiveViewState(state: IParadisAgentLiveViewState): string {
	return JSON.stringify(state);
}

/** 絞り込みが1つでも効いているか (状況バーの表示条件)。 */
export function paradisHasAgentLiveFilter(state: IParadisAgentLiveViewState): boolean {
	return state.attentionOnly || state.statuses.length > 0 || state.spaces !== undefined || state.hidden.length > 0;
}

export function paradisFilterAgentLiveEntries(entries: readonly IParadisAgentLiveEntry[], state: IParadisAgentLiveViewState): IParadisAgentLiveEntry[] {
	const hidden = new Set(state.hidden);
	const spaces = state.spaces ? new Set(state.spaces) : undefined;
	const statuses = state.statuses.length > 0 ? new Set(state.statuses) : undefined;
	return entries.filter(entry => {
		if (hidden.has(entry.token)) {
			return false;
		}
		if (spaces && !spaces.has(entry.stateKey ?? '')) {
			return false;
		}
		if (state.attentionOnly && !paradisIsAttentionStatus(entry.status)) {
			return false;
		}
		if (statuses && !statuses.has(entry.status)) {
			return false;
		}
		return true;
	});
}

function statusRank(status: ParadisAgentLiveStatus): number {
	const index = PARADIS_AGENT_LIVE_STATUS_ORDER.indexOf(status);
	return index < 0 ? PARADIS_AGENT_LIVE_STATUS_ORDER.length : index;
}

/**
 * 並び替え。ピン留めは (pinTop が有効なら) どのソートでも常に先頭へ寄せる。
 * 手動順に載っていないトークンは末尾に回す (新しく現れた端末が既存の並びを崩さないため)。
 */
export function paradisSortAgentLiveEntries(entries: readonly IParadisAgentLiveEntry[], state: IParadisAgentLiveViewState, now: number): IParadisAgentLiveEntry[] {
	const direction = state.sortDesc ? 1 : -1;
	const manualIndex = new Map(state.manualOrder.map((token, index) => [token, index]));
	const manualRank = (entry: IParadisAgentLiveEntry): number => manualIndex.get(entry.token) ?? Number.MAX_SAFE_INTEGER;
	const elapsed = (entry: IParadisAgentLiveEntry): number => Math.max(0, now - entry.since);

	const sorted = [...entries];
	sorted.sort((a, b) => {
		switch (state.sort) {
			case 'manual': {
				const byManual = manualRank(a) - manualRank(b);
				return byManual !== 0 ? byManual : a.token.localeCompare(b.token);
			}
			case 'attention': {
				const attention = (paradisIsAttentionStatus(a.status) ? 0 : 1) - (paradisIsAttentionStatus(b.status) ? 0 : 1);
				return attention !== 0 ? attention : (elapsed(b) - elapsed(a)) * direction;
			}
			case 'status': {
				const byStatus = (statusRank(a.status) - statusRank(b.status)) * direction;
				return byStatus !== 0 ? byStatus : elapsed(b) - elapsed(a);
			}
			case 'elapsed':
				return (elapsed(b) - elapsed(a)) * direction;
			case 'updated':
				return (b.lastOutputAt - a.lastOutputAt) * direction;
			case 'space': {
				const bySpace = a.spaceName.localeCompare(b.spaceName) * direction;
				return bySpace !== 0 ? bySpace : a.detail.localeCompare(b.detail);
			}
		}
	});

	if (state.pinTop && state.pinned.length > 0) {
		const pinned = new Set(state.pinned);
		// 安定ソート前提で、ピンの有無だけをキーに並べ直す (ピン内・非ピン内の順序は保つ)。
		sorted.sort((a, b) => (pinned.has(b.token) ? 1 : 0) - (pinned.has(a.token) ? 1 : 0));
	}
	return sorted;
}

export interface IParadisAgentLiveGroupResult {
	readonly key: string;
	readonly label: string;
	/** スペースグループの色帯 (hex)。状態グループでは undefined */
	readonly color: string | undefined;
	/** 状態グループのドット色に使う状態。スペースグループでは undefined */
	readonly status: ParadisAgentLiveStatus | undefined;
	readonly entries: readonly IParadisAgentLiveEntry[];
}

/**
 * グループ化。並び替え済みの配列を受け取り、順序を保ったまま束ねる
 * (グループの出現順は、グループ内の先頭要素が元の並びで先に来る順)。
 */
export function paradisGroupAgentLiveEntries(
	entries: readonly IParadisAgentLiveEntry[],
	state: IParadisAgentLiveViewState,
	statusLabel: (status: ParadisAgentLiveStatus) => string,
): IParadisAgentLiveGroupResult[] {
	if (state.group === 'none') {
		return [{ key: '', label: '', color: undefined, status: undefined, entries }];
	}

	const groups = new Map<string, { label: string; color: string | undefined; status: ParadisAgentLiveStatus | undefined; entries: IParadisAgentLiveEntry[] }>();
	for (const entry of entries) {
		const key = state.group === 'space' ? (entry.stateKey ?? '') : entry.status;
		let group = groups.get(key);
		if (!group) {
			group = state.group === 'space'
				? { label: entry.spaceName, color: entry.spaceColor, status: undefined, entries: [] }
				: { label: statusLabel(entry.status), color: undefined, status: entry.status, entries: [] };
			groups.set(key, group);
		}
		group.entries.push(entry);
	}
	return [...groups].map(([key, group]) => ({ key, label: group.label, color: group.color, status: group.status, entries: group.entries }));
}

/**
 * ドラッグ＆ドロップ後の手動並び順を返す。
 *
 * 自動ソート中にドラッグされた場合は、その時点で見えている並び (visibleOrder) を手動順の
 * 土台にする。そうしないと「画面の並びと手動順が無関係」な状態から1件だけ動かすことになり、
 * 直後に全体が別の順序へ飛ぶ。
 */
export function paradisApplyAgentLiveManualDrop(
	currentOrder: readonly string[],
	visibleOrder: readonly string[],
	dragged: string,
	target: string,
): string[] {
	const base = [...currentOrder];
	// 見えているトークンを、現在の手動順に無いものも含めて土台へ反映する。
	for (let index = 0; index < visibleOrder.length; index++) {
		if (!base.includes(visibleOrder[index])) {
			const previous = index > 0 ? visibleOrder[index - 1] : undefined;
			const at = previous !== undefined ? base.indexOf(previous) + 1 : 0;
			base.splice(at, 0, visibleOrder[index]);
		}
	}

	const from = base.indexOf(dragged);
	if (from >= 0) {
		base.splice(from, 1);
	}
	const to = base.indexOf(target);
	base.splice(to < 0 ? base.length : to, 0, dragged);
	return base;
}

/** 経過時間の表示 (「42秒」「3分07秒」「2時間14分」)。 */
export function paradisFormatAgentLiveDuration(milliseconds: number): string {
	const total = Math.max(0, Math.floor(milliseconds / 1000));
	if (total < 60) {
		return `${total}秒`;
	}
	if (total < 3600) {
		return `${Math.floor(total / 60)}分${String(total % 60).padStart(2, '0')}秒`;
	}
	return `${Math.floor(total / 3600)}時間${Math.floor((total % 3600) / 60)}分`;
}
