// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { DockPanel } from './shortcuts.js';

/**
 * ショートカットの受け口（画面ごとの操作）を集める場所。
 *
 * 画面は `useShortcutSlot` で「この操作ならこれを呼ぶ」を置き、画面が外れる・前面でなくなると外す。
 * 同じ種類の受け口が重なったら**後から置いたもの**に届く（シートの上にシートを重ねたときの Esc など）。
 * どの受け口があるかで、`ShortcutHost` がネイティブへ渡すショートカットを決める。
 */

export interface SlotHandlers {
	/** 前面のセッション。`tabCount` は ⌘数字 を何番まで効かせるかに使う。 */
	session: {
		readonly tabCount: number;
		selectTab(index: number): void;
		stepTab(delta: 1 | -1): void;
		openQuick(): void;
		openPanel(panel: DockPanel): void;
	};
	/** 入力欄の送信（会話・ターミナル・回答）。 */
	send: { send(): void };
	/** PC の画面の一覧（前後のエージェントを開く）。 */
	list: { stepAgent(delta: 1 | -1): void };
	/** 起動のシートを出す。 */
	launch: { launch(): void };
	/** 左の列を隠す・出す。 */
	sidebar: { toggle(): void };
	/** 閉じる（シート・ドック）。 */
	escape: { escape(): void };
	/** ライブ入力中の矢印を PC のターミナルへ送る。 */
	terminalArrows: { arrow(key: 'up' | 'down' | 'left' | 'right'): void };
	/** 開いたファイルの中の検索（ファイルのビューア）。`step` は欄が閉じていれば開く。 */
	find: { open(): void; step(delta: 1 | -1): void };
}

export type SlotName = keyof SlotHandlers;

interface SlotEntry<K extends SlotName> {
	readonly token: number;
	readonly ref: { readonly current: SlotHandlers[K] | undefined };
	/** ネイティブへ渡す一覧を変えるための値（セッションのタブの数）。 */
	readonly meta: number;
}

type Slots = { readonly [K in SlotName]: readonly SlotEntry<K>[] };

interface ShortcutRegistry {
	readonly slots: Slots;
	add<K extends SlotName>(slot: K, entry: SlotEntry<K>): void;
	remove(slot: SlotName, token: number): void;
	setMeta(slot: SlotName, token: number, meta: number): void;
}

const EMPTY_SLOTS: Slots = { session: [], send: [], list: [], launch: [], sidebar: [], escape: [], terminalArrows: [], find: [] };

export const useShortcutRegistry = create<ShortcutRegistry>()(set => ({
	slots: EMPTY_SLOTS,
	add(slot, entry) {
		set(state => ({ slots: { ...state.slots, [slot]: [...state.slots[slot], entry] } }));
	},
	remove(slot, token) {
		set(state => ({ slots: { ...state.slots, [slot]: state.slots[slot].filter(entry => entry.token !== token) } }));
	},
	setMeta(slot, token, meta) {
		set(state => ({ slots: { ...state.slots, [slot]: state.slots[slot].map(entry => (entry.token === token ? { ...entry, meta } : entry)) } }));
	},
}));

let nextToken = 1;

/** その種類の受け口のうち、いちばん後に置いたもの（無ければ undefined）。 */
export function topSlot<K extends SlotName>(slot: K): SlotHandlers[K] | undefined {
	const entries = useShortcutRegistry.getState().slots[slot] as readonly SlotEntry<K>[];
	return entries[entries.length - 1]?.ref.current;
}

/**
 * ショートカットの受け口を置く。`handler` が undefined の間は置かない（シートが閉じている・画面が前面に
 * 無いなど）。中身の関数は毎回の描画で差し替わってよい（最新のものを呼ぶ）。
 */
export function useShortcutSlot<K extends SlotName>(slot: K, handler: SlotHandlers[K] | undefined): void {
	const ref = useRef<SlotHandlers[K] | undefined>(handler);
	ref.current = handler;
	const active = handler !== undefined;
	const meta = slot === 'session' && handler !== undefined ? (handler as SlotHandlers['session']).tabCount : 0;
	const tokenRef = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (!active) {
			return;
		}
		const token = nextToken++;
		tokenRef.current = token;
		useShortcutRegistry.getState().add(slot, { token, ref, meta: 0 });
		return () => {
			tokenRef.current = undefined;
			useShortcutRegistry.getState().remove(slot, token);
		};
	}, [active, slot]);
	useEffect(() => {
		const token = tokenRef.current;
		if (token !== undefined) {
			useShortcutRegistry.getState().setMeta(slot, token, meta);
		}
	}, [active, slot, meta]);
}
