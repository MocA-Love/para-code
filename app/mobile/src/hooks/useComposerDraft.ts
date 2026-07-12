// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../appState.js';

/**
 * コンポーザーの下書きを画面アンマウント後も保持するフック（LINE風の入力保持）。
 * key（エージェント/ターミナル単位の一意ID。pinKeyForTerminal で得るキー等）ごとに
 * メモリ上のストアへ退避し、同じkeyの画面へ戻ったとき復元する。keyが違えば別の
 * 下書きになるため、他のエージェントの入力欄に混ざることはない。
 *
 * IME（日本語変換）を壊さないため、TextInput自体はローカルstate制御のまま扱い、
 * ストア→入力欄への書き戻しは「マウント時」と「対象key切替時」だけに限定する
 * （入力1文字ごとにvalueを外部から差し替えると変換中の文字列が崩れるため）。
 * 入力毎の退避は onChangeText 経由の update でストアへ書き込む。
 *
 * @returns [value, update（入力欄のonChangeTextに渡す）, clear（送信後などに下書きを消す）]
 */
export function useComposerDraft(key: string | undefined): [string, (text: string) => void, () => void] {
	const [value, setValue] = useState(() => (key !== undefined ? useAppStore.getState().agentDrafts[key] ?? '' : ''));
	const loadedKeyRef = useRef(key);
	useEffect(() => {
		if (loadedKeyRef.current === key) {
			return;
		}
		loadedKeyRef.current = key;
		setValue(key !== undefined ? useAppStore.getState().agentDrafts[key] ?? '' : '');
	}, [key]);
	const update = useCallback((text: string) => {
		setValue(text);
		if (key !== undefined) {
			useAppStore.getState().setAgentDraft(key, text);
		}
	}, [key]);
	const clear = useCallback(() => {
		setValue('');
		if (key !== undefined) {
			useAppStore.getState().clearAgentDraft(key);
		}
	}, [key]);
	return [value, update, clear];
}
