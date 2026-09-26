// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../appState.js';
import { trimSpaceNoteTrailingEmptyTask } from '../../spaceNote.js';

/** メモの読み書きの失敗（画面に出す一文）。PC から届いた本文をそのまま出さない。 */
export type SpaceNoteError = 'load' | 'save' | 'full';

export interface SpaceNoteController {
	/** いまの本文（楽観更新を含む）。 */
	readonly text: string;
	readonly loading: boolean;
	/** 保存を送って応答を待っている間。 */
	readonly busy: boolean;
	readonly error: SpaceNoteError | undefined;
	setError(error: SpaceNoteError | undefined): void;
	/** 本文を差し替えて保存する（楽観更新。失敗したら `previous` へ戻す）。 */
	commit(next: string): void;
	/**
	 * 編集中の書きかけを預ける（undefined で取り下げ）。画面を離れたときに、まだ保存していない
	 * 書きかけがあれば保存する（PC 側のメモ欄がフォーカスを外したときに保存するのと揃える）。
	 */
	holdDraft(draft: string | undefined): void;
	/** 読み込みに失敗したあとに読み直す。 */
	reload(): void;
}

/**
 * スペースのメモの読み込みと保存（旧画面 `legacy-screens/space-note.tsx` の処理を画面から切り出したもの）。
 *
 * - 開いたとき・スペースが変わったときに読み込む。応答が返る前にスペースが変わったら古い応答は捨てる
 * - 保存は楽観更新。連打したときは最後に送った保存の応答だけを反映する（先の応答で巻き戻さない）
 * - 画面を離れたとき（戻る・スワイプ）に編集中の書きかけがあれば保存する
 *
 * `wsId` は要求を出せるときだけ渡す（`useCodeSpace().wsId`。PC の切り替え中などは undefined）。
 */
export function useSpaceNote(wsId: string | undefined): SpaceNoteController {
	const [text, setText] = useState('');
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<SpaceNoteError | undefined>(undefined);
	const [reloadCount, setReloadCount] = useState(0);
	/** 応答が返る前にスペースが変わった・画面を離れた場合に、古い応答を捨てるための世代。 */
	const generationRef = useRef(0);
	/** 保存の送信順。最後の送信の応答だけを反映する。 */
	const saveSequenceRef = useRef(0);
	/** 編集中の書きかけ。 */
	const draftRef = useRef<string | undefined>(undefined);
	/** 離れるときの比較に使う、いまの本文の控え。 */
	const textRef = useRef('');
	textRef.current = text;

	useEffect(() => {
		if (wsId === undefined) {
			return undefined;
		}
		const generation = ++generationRef.current;
		setLoading(true);
		setError(undefined);
		useAppStore.getState().noteGet(wsId)
			.then(result => {
				if (generation === generationRef.current) {
					setText(result.text ?? '');
				}
			})
			.catch(() => {
				if (generation === generationRef.current) {
					setError('load');
				}
			})
			.finally(() => {
				if (generation === generationRef.current) {
					setLoading(false);
				}
			});
		return () => {
			// 離れる（またはスペースが変わる）: 書きかけがあれば、離れる前のスペースへ保存する。
			// 書きかけは持ち越さない（切り替え先のスペースへ前のスペースの本文を書き込まないように）。
			generationRef.current++;
			const draft = draftRef.current;
			draftRef.current = undefined;
			if (draft === undefined) {
				return;
			}
			const trimmed = trimSpaceNoteTrailingEmptyTask(draft);
			if (trimmed !== textRef.current) {
				void useAppStore.getState().noteSet(wsId, trimmed).catch(() => undefined);
			}
		};
	}, [wsId, reloadCount]);

	const commit = useCallback((next: string) => {
		if (wsId === undefined) {
			return;
		}
		const previous = textRef.current;
		const generation = generationRef.current;
		const sequence = ++saveSequenceRef.current;
		setText(next);
		setBusy(true);
		setError(undefined);
		const current = () => generation === generationRef.current && sequence === saveSequenceRef.current;
		useAppStore.getState().noteSet(wsId, next)
			.then(result => {
				if (current()) {
					setText(result.text ?? next);
				}
			})
			.catch(() => {
				if (current()) {
					// 保存できなかったので楽観更新を戻す（チェックが付いたまま残らないように）。
					setText(previous);
					setError('save');
				}
			})
			.finally(() => {
				if (current()) {
					setBusy(false);
				}
			});
	}, [wsId]);

	const holdDraft = useCallback((draft: string | undefined) => {
		draftRef.current = draft;
	}, []);

	const reload = useCallback(() => setReloadCount(count => count + 1), []);

	return { text, loading: wsId === undefined || loading, busy, error, setError, commit, holdDraft, reload };
}

/** 失敗の一文。 */
export function spaceNoteErrorMessage(error: SpaceNoteError): string {
	switch (error) {
		case 'load':
			return 'メモを読み込めませんでした。PC との接続を確かめてください。';
		case 'save':
			return 'メモを保存できませんでした。変更は元に戻しました。';
		case 'full':
			return 'メモが上限に達しているため追加できません。';
	}
}
