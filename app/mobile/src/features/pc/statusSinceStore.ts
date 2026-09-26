// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';
import { useAppStore } from '../../appState.js';
import { nextStatusSince, type StatusSinceMap } from './statusSince.js';

/**
 * 行の経過時間の元（状態が変わった時刻）を、アプリが動いている間ずっと見張るストア。
 * 判定は純関数の `nextStatusSince`。PC を切り替えたら記録を捨てる（別の PC のターミナルなので）。
 *
 * 画面を開いたときから見張り始めると、それまでの変化を取りこぼすので、ホームと PC の画面の
 * モジュールを読み込んだ時点で `startStatusSinceTracking()` を呼ぶ（何度呼んでも1回だけ始まる）。
 */
export const useStatusSince = create<{ readonly map: StatusSinceMap }>()(() => ({ map: new Map() }));

let started = false;

export function startStatusSinceTracking(): void {
	if (started) {
		return;
	}
	started = true;
	let pcId: string | undefined;
	let terminals: unknown;
	const apply = (state: ReturnType<typeof useAppStore.getState>) => {
		const nextTerminals = state.workspace?.terminals;
		if (state.activePcId !== pcId) {
			pcId = state.activePcId;
			terminals = nextTerminals;
			useStatusSince.setState({ map: nextStatusSince(new Map(), nextTerminals ?? [], Date.now()) });
			return;
		}
		// 切断などで一時的に一覧が無いときは記録を保つ（戻ってきたときに全部「初めて見た」にしない）。
		if (nextTerminals === undefined || nextTerminals === terminals) {
			return;
		}
		terminals = nextTerminals;
		const current = useStatusSince.getState().map;
		const next = nextStatusSince(current, nextTerminals, Date.now());
		if (next !== current) {
			useStatusSince.setState({ map: next });
		}
	};
	apply(useAppStore.getState());
	useAppStore.subscribe(apply);
}
