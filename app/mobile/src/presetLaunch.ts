// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Alert } from 'react-native';
import { useAppStore } from './appState.js';
import { useParaToast } from './paraToast.js';
import { presetTerminalCount } from './presets.js';
import type { PresetDef } from './store.js';

/**
 * コマンドプリセットの実行と、その進行トースト。
 *
 * 実行はシート（components/presetSheet.tsx）から始まるが、押した直後にシートは閉じる。
 * エージェント起動（agentLaunch.ts）と同じ理由で、進行と結果は画面の外に置く。
 *
 * プリセットは複数のターミナルを一度に作りうる。**何が起きたかを必ず1文で言う**——
 * 黙ってタブが増えるだけだと、押した操作と画面の変化が結びつかない。
 */

/** 実行後にそのターミナルを開く。増えたものが分からなかった場合は今の選択のままにする。 */
function revealCreatedTerminal(created: readonly string[] | undefined): void {
	const first = created?.[0];
	if (first !== undefined) {
		useAppStore.getState().setSelectedTerminalKey(first);
	}
}

export function runPresetInBackground(request: { ws: string; wsLabel: string; preset: PresetDef }): void {
	const { ws, wsLabel, preset } = request;
	const expected = presetTerminalCount(preset);
	useParaToast.getState().show({
		key: 'preset-run',
		text: `${preset.name} を実行中…`,
		sub: wsLabel,
		icon: 'flash-outline',
		tone: 'info',
		spinner: true,
	});
	useAppStore.getState().presetRun(ws, preset.key, preset.signature).then(result => {
		revealCreatedTerminal(result.created);
		const created = result.created?.length ?? expected;
		useParaToast.getState().show({
			key: 'preset-run',
			text: `${preset.name} を実行しました`,
			sub: created > 1 ? `${wsLabel} · ${created}個のターミナルを作成` : wsLabel,
			icon: 'checkmark-circle',
			tone: 'done',
		}, 2_500);
	}).catch((e: unknown) => {
		useParaToast.getState().show({ key: 'preset-run', text: '実行できませんでした', sub: '', icon: 'alert-circle', tone: 'warn' }, 1_200);
		// PCは実行の直前に定義を読み直して署名を突き合わせる。手元で確認したあとに
		// PC側でコマンドや作業ディレクトリが書き換わっていた場合はここに来る。
		// 「通信に失敗した」と読める文面にすると、内容が変わったことに気づけない。
		const message = String(e instanceof Error ? e.message : e);
		if (message.includes('preset changed')) {
			Alert.alert('プリセットの内容が変わりました', 'PC側で書き換えられたため実行していません。一覧を開き直すと、新しい内容を確認してから実行できます。');
			return;
		}
		Alert.alert('コマンドプリセットを実行できませんでした', message);
	});
}
