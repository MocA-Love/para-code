// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import { secureKeyStore } from '../../platform.js';

/**
 * ターミナルのライブ入力（直接入力）をオンにしているか。**既定はオン**で、利用者が自分で切り替えた
 * ターミナルだけその選択を覚えておく（Orca の mobile-terminal-direct-input-default.md に倣った。
 * 手動でオフにしたものは既定に戻さない）。
 *
 * 以前は画面を開くたびにオフから始まっていた（覚えていなかった）。いまはターミナルごとの選択を
 * 端末に保存し、次に開いたときも同じ状態にする。鍵は書きかけと同じ（PC × ターミナルの論理キー。
 * `terminalDraftKey`）。
 */

export const LIVE_INPUT_DEFAULT_ENABLED = true;

/** 覚えておく選択の上限。古いものから捨てる（捨てられたターミナルは既定のオンに戻る）。 */
export const LIVE_INPUT_CHOICE_LIMIT = 200;

const STORAGE_KEY = 'terminalLiveInputChoices';

export type LiveInputChoices = Readonly<Record<string, boolean>>;

export function liveInputEnabled(choices: LiveInputChoices, key: string): boolean {
	return choices[key] ?? LIVE_INPUT_DEFAULT_ENABLED;
}

/** 選択を覚える（最後に選んだものを末尾へ。上限を超えたら古いものから捨てる）。 */
export function withLiveInputChoice(choices: LiveInputChoices, key: string, enabled: boolean, limit = LIVE_INPUT_CHOICE_LIMIT): LiveInputChoices {
	const { [key]: _previous, ...rest } = choices;
	const entries = [...Object.entries(rest), [key, enabled] as const];
	return Object.fromEntries(entries.slice(Math.max(0, entries.length - limit)));
}

/** 保存されていた値を読む。形の崩れたものは捨てる。 */
export function parseLiveInputChoices(raw: string | null): LiveInputChoices {
	if (raw === null) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}
		return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
	} catch {
		return {};
	}
}

interface LiveInputChoiceStore {
	readonly choices: LiveInputChoices;
	/** 利用者が切り替えた。 */
	choose(key: string, enabled: boolean): void;
	/** 保存済みの選択を読み込む（最初に使う画面が呼ぶ。2回目以降は何もしない）。 */
	load(): void;
}

let loadStarted = false;
let loaded = false;

function persist(choices: LiveInputChoices): void {
	secureKeyStore.setItem(STORAGE_KEY, JSON.stringify(choices)).catch(err => console.warn('[liveInput] failed to save the choice', err));
}

export const useTerminalLiveInputChoices = create<LiveInputChoiceStore>((set, get) => ({
	choices: {},
	choose(key, enabled) {
		const next = withLiveInputChoice(get().choices, key, enabled);
		set({ choices: next });
		// 読み込む前に書くと、保存されていた他のターミナルの選択を消してしまう。読み込んだあとで重ねて書く。
		if (loaded) {
			persist(next);
		} else {
			get().load();
		}
	},
	load() {
		if (loadStarted) {
			return;
		}
		loadStarted = true;
		secureKeyStore.getItem(STORAGE_KEY).then(raw => {
			// 読み込む前に切り替えた分は、読み込んだものより新しいので上に重ねる。
			const current = get().choices;
			const merged = Object.entries(current).reduce<LiveInputChoices>((acc, [key, enabled]) => withLiveInputChoice(acc, key, enabled), parseLiveInputChoices(raw));
			loaded = true;
			set({ choices: merged });
			if (Object.keys(current).length > 0) {
				persist(merged);
			}
		}).catch(err => {
			// 端末のロック中などで読めなかった。次に画面を開いたときにもう一度読む。
			loadStarted = false;
			console.warn('[liveInput] failed to load choices', err);
		});
	},
}));
