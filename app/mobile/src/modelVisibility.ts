// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { KeyStore } from './store.js';

/**
 * チャットの「モデルを選ぶ」シートに出さないモデル（シート右上の歯車 →「表示するモデル」）。
 * 計算と保存の形だけを持つ純関数（`modelVisibility.test.ts` で固定）。画面は
 * `src/features/session/modelDrawer.tsx`、状態は `appState.ts` の `hiddenModels`。
 *
 *  - 覚えるのは「隠したモデルの id」だけ。PC に新しいモデルが増えたら何もしなくても表示される
 *  - この端末の中だけの設定で、PC ごとには分けない（Claude の別名も Codex のモデル名も PC 間で同じ文字列）。PC へは送らない
 *  - エージェント（Claude Code / Codex）ごとに持つ。Claude は PC の CLI から取った一覧にも、アプリ固定の予備表にも同じ id で効く
 *  - PC の一覧から消えた id が残っていても何も起きない（一覧に無い id は数えも表示もしない）
 *  - 使用中のモデルは隠していてもシートに残す（ピルの表示と「使用中」の印をずらさないため）
 *  - 最後の 1 つは隠せない。ただし一覧が入れ替わって表示中が 0 になったときは、隠す設定を無視して全部出す
 */

/** 隠す設定を持つエージェント。 */
export type ModelVisibilityAgent = 'claude' | 'codex';

/** エージェントごとの「隠したモデルの id」。 */
export interface HiddenModels {
	readonly claude: readonly string[];
	readonly codex: readonly string[];
}

export const EMPTY_HIDDEN_MODELS: HiddenModels = { claude: [], codex: [] };

/** 保存先のキー（`secureKeyStore`。ほかの端末ローカルの設定と同じ）。 */
export const HIDDEN_MODELS_KEY = 'hiddenModels';

/** 選べる行の最小の形（Claude の `AgentModelOption` も Codex の行もこれを満たす）。 */
interface ModelLike {
	readonly id: string;
}

/** シートの行。`hidden` は「隠しているが使用中なので出している」もの。 */
export interface ModelChoice<T extends ModelLike> {
	readonly option: T;
	readonly hidden: boolean;
}

/** セッションのエージェント種別から、隠す設定の対象を返す。対象外（シェルなど）は undefined。 */
export function modelVisibilityAgent(agent: string | undefined): ModelVisibilityAgent | undefined {
	return agent === 'claude' || agent === 'codex' ? agent : undefined;
}

function normalizeIds(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const ids = new Set<string>();
	for (const item of value) {
		if (typeof item === 'string' && item.length > 0) {
			ids.add(item);
		}
	}
	return [...ids];
}

/** 保存値（JSON を解いたもの）を使える形に直す。壊れた値・知らない形は空として扱う。 */
export function normalizeHiddenModels(raw: unknown): HiddenModels {
	if (typeof raw !== 'object' || raw === null) {
		return EMPTY_HIDDEN_MODELS;
	}
	const record = raw as { readonly claude?: unknown; readonly codex?: unknown };
	return { claude: normalizeIds(record.claude), codex: normalizeIds(record.codex) };
}

/** 保存した値を読む。無い・壊れている場合は空。読めない（Keychain がロック中など）ときは reject。 */
export async function loadHiddenModels(store: Pick<KeyStore, 'getItem'>): Promise<HiddenModels> {
	const raw = await store.getItem(HIDDEN_MODELS_KEY);
	if (raw === null) {
		return EMPTY_HIDDEN_MODELS;
	}
	try {
		return normalizeHiddenModels(JSON.parse(raw) as unknown);
	} catch {
		return EMPTY_HIDDEN_MODELS;
	}
}

/** 保存する。何も隠していなければ項目ごと消す。 */
export function saveHiddenModels(store: Pick<KeyStore, 'setItem' | 'deleteItem'>, hidden: HiddenModels): Promise<void> {
	return hidden.claude.length === 0 && hidden.codex.length === 0
		? store.deleteItem(HIDDEN_MODELS_KEY)
		: store.setItem(HIDDEN_MODELS_KEY, JSON.stringify({ claude: hidden.claude, codex: hidden.codex }));
}

/** 1 つのモデルを隠す・表示に戻す。変わらなければ同じオブジェクトを返す。 */
export function withModelHidden(hidden: HiddenModels, agent: ModelVisibilityAgent, id: string, hide: boolean): HiddenModels {
	const current = hidden[agent];
	if (current.includes(id) === hide) {
		return hidden;
	}
	const next = hide ? [...current, id] : current.filter(item => item !== id);
	return { ...hidden, [agent]: next };
}

/** 一覧のうち、隠していないものの数（一覧に無い id は数えない）。 */
export function countVisibleModels(options: readonly ModelLike[], hiddenIds: readonly string[]): number {
	return options.filter(option => !hiddenIds.includes(option.id)).length;
}

/** このモデルを隠してよいか。最後の 1 つ（隠していないものが 1 つだけ）のときは隠せない。 */
export function canHideModel(options: readonly ModelLike[], hiddenIds: readonly string[], id: string): boolean {
	return !hiddenIds.includes(id) && options.some(option => option.id === id) && countVisibleModels(options, hiddenIds) > 1;
}

/**
 * 「モデルを選ぶ」に並べる行。隠したものを外し、使用中のものは隠していても残す（`hidden: true`）。
 * 一覧が入れ替わって隠していないものが 1 つも無くなったときは、隠す設定を無視して全部出す。
 */
export function pickerModelChoices<T extends ModelLike>(options: readonly T[], hiddenIds: readonly string[], currentId: string | undefined): ModelChoice<T>[] {
	if (countVisibleModels(options, hiddenIds) === 0) {
		return options.map(option => ({ option, hidden: false }));
	}
	const choices: ModelChoice<T>[] = [];
	for (const option of options) {
		const hidden = hiddenIds.includes(option.id);
		if (!hidden || option.id === currentId) {
			choices.push({ option, hidden });
		}
	}
	return choices;
}

/**
 * シートで印を付けるモデル。シートで選んだもの → 使用中 → 既定（Codex の isDefault）→ 先頭、の順に、
 * **表示している行の中から**選ぶ。先頭まで落とすのは `fallbackToFirst` のときだけ（Claude は使用中が
 * 分からなければ何も選ばない）。
 */
export function initialModelSelection<T extends ModelLike>(shown: readonly T[], { pickedId, currentId, defaultId, fallbackToFirst }: {
	readonly pickedId: string | undefined;
	readonly currentId: string | undefined;
	readonly defaultId: string | undefined;
	readonly fallbackToFirst: boolean;
}): T | undefined {
	for (const id of [pickedId, currentId, defaultId]) {
		const found = id !== undefined ? shown.find(option => option.id === id) : undefined;
		if (found !== undefined) {
			return found;
		}
	}
	return fallbackToFirst ? shown[0] : undefined;
}
