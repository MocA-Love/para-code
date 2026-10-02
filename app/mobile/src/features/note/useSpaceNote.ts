// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../appState.js';
import { usePcCapability } from '../../hooks/usePcCapability.js';
import { writeClipboardText } from '../../nativeClipboard.js';
import { useParaToast } from '../../paraToast.js';
import { trimSpaceNoteTrailingEmptyTask } from '../../spaceNote.js';
import type { SpaceNoteResult } from '../../store.js';
import { NOTE_CAS_CAPABILITY, replaceNoteChange, spaceNoteConflictKind, spaceNoteConflictMessage, spaceNoteKeepsDraft, spaceNoteMissingBase, spaceNoteSetOptions, type SpaceNoteChange, type SpaceNoteConflictKind } from './spaceNoteSave.js';

/** 保存 1 回の結果。 */
export type SpaceNoteCommitOutcome = 'saved' | 'conflict' | 'failed';

/** 保存の結果。`text` と `opLine` は PC が書いた（または書かなかった）ときの応答（送らなかった・失敗したときは無い）。 */
export interface SpaceNoteCommitResult {
	readonly outcome: SpaceNoteCommitOutcome;
	readonly text?: string;
	readonly opLine?: number;
}

/** 送った保存の応答をすべて受けた後の本文と、その本文の版（版を比べられない PC・まだ読めていないときは undefined）。 */
export interface SpaceNoteSnapshot {
	readonly wsId: string | undefined;
	readonly text: string;
	readonly version: number | undefined;
}

/**
 * メモの読み書きの失敗（画面に出す一文）。PC から届いた本文をそのまま出さない。
 * `conflict*` は PC で先に書き換えられていて保存しなかったとき（最新は読み込み済み）。
 */
export type SpaceNoteError = 'load' | 'save' | 'full' | { readonly conflict: SpaceNoteConflictKind };

export interface SpaceNoteController {
	/** 読み書きしているスペース（要求を出せないときは undefined）。 */
	readonly wsId: string | undefined;
	/** いまの本文（楽観更新を含む）。 */
	readonly text: string;
	readonly loading: boolean;
	/** 保存を送って応答を待っている間。 */
	readonly busy: boolean;
	readonly error: SpaceNoteError | undefined;
	setError(error: SpaceNoteError | undefined): void;
	/**
	 * 本文を差し替えて保存する（楽観更新。失敗したら `previous` へ戻す）。PC で先に書き換えられていて
	 * 書かれなかったら、PC の最新を読み込み `conflict*` を出す（`spaceNoteSave.ts`）。
	 * 結果は PC の応答を受けてから返す（`saved` は PC が書いた。後から送った保存に追い越されて、この応答を画面に
	 * 出さなかったときも書いたことに変わりはない。`conflict` / `failed` は書かれていない）。
	 */
	commit(change: SpaceNoteChange): Promise<SpaceNoteCommitResult>;
	/**
	 * 編集中の書きかけを預ける（undefined で取り下げ）。画面を離れたときに、まだ保存していない
	 * 書きかけがあれば保存する（PC 側のメモ欄がフォーカスを外したときに保存するのと揃える）。
	 */
	holdDraft(draft: string | undefined): void;
	/** 読み込みに失敗したあとに読み直す。 */
	reload(): void;
	/**
	 * 送った保存の応答をすべて受けた後の本文（PC の最新）。「元に戻す」のように、いまの本文から次の全文を作る操作は
	 * これを待ってから作る（応答の前に作ると、PC が当てた書き足しを知らない全文を送ってしまう）。
	 */
	settledSnapshot(): Promise<SpaceNoteSnapshot>;
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
	/**
	 * 最後に PC から受け取ったメモの版（`note.cas.v1` より前の PC なら undefined）。全文の保存に付ける。
	 * どのスペースの版かも持つ（スペースを切り替えた後に、前のスペースの応答で上書きしないため）。
	 */
	const versionRef = useRef<{ readonly wsId: string; version: number | undefined } | undefined>(undefined);
	/**
	 * 保存を1本ずつ送る列。切り替え・追加の応答で版が進む前に全文の保存を送ると、古い版を付けて送ることになり
	 * 書かれない（自分の保存どうしで食い違う）ので、前の保存の応答を待ってから次を送り、送る直前の版を付ける。
	 */
	const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
	const enqueueSave = useCallback((task: () => Promise<void>) => {
		const run = saveQueueRef.current.then(task, task);
		saveQueueRef.current = run.catch(() => undefined);
		return run;
	}, []);
	const pcHasCas = usePcCapability(NOTE_CAS_CAPABILITY);
	const pcHasCasRef = useRef(pcHasCas);
	pcHasCasRef.current = pcHasCas;

	useEffect(() => {
		if (wsId === undefined) {
			return undefined;
		}
		const generation = ++generationRef.current;
		setLoading(true);
		setError(undefined);
		// 前のスペース（または読み直す前）の保存の応答はもう画面へ反映しない（`current()` が偽になる）ので、
		// その応答で外すはずだった「保存中」もここで外す（外さないと、閉じるまでメモを操作できない）。
		setBusy(false);
		versionRef.current = { wsId, version: undefined };
		useAppStore.getState().noteGet(wsId)
			.then(result => {
				if (generation === generationRef.current) {
					setText(result.text ?? '');
					// 版と本文を同じ応答から組で進める（settledSnapshot() が描き直しを待たずに同じ組を読めるように）
					textRef.current = result.text ?? '';
					if (versionRef.current?.wsId === wsId) {
						versionRef.current.version = result.updatedAt;
					}
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
				// 画面はもう無いので、PC で先に書き換えられていたら書きかけをクリップボードへ逃がして知らせる。
				// 版は離れる時点のこのスペースのもの（スペースが変わった後に読んだ別のスペースの版は使わない）
				const change = replaceNoteChange(trimmed);
				const version = versionRef.current?.wsId === wsId ? versionRef.current.version : undefined;
				void enqueueSave(async () => {
					// 版を比べられる PC なのに版がまだ無い（読み直しの途中）なら送らない（無条件の上書きで PC の変更を消さない）
					const result = spaceNoteMissingBase(change, version, pcHasCasRef.current)
						? { conflict: true }
						: await useAppStore.getState().noteSet(wsId, trimmed, spaceNoteSetOptions(change, version, pcHasCasRef.current)).catch(() => undefined);
					if (result?.conflict === true) {
						const copied = await writeClipboardText(trimmed);
						useParaToast.getState().show({ key: 'space-note-conflict', text: 'メモを保存しませんでした', sub: spaceNoteConflictMessage(spaceNoteConflictKind(change, copied)), icon: 'alert-circle', tone: 'warn' }, 6_000);
					}
				});
			}
		};
	}, [wsId, reloadCount, enqueueSave]);

	const commit = useCallback((change: SpaceNoteChange): Promise<SpaceNoteCommitResult> => {
		if (wsId === undefined) {
			return Promise.resolve({ outcome: 'failed' });
		}
		let outcome: SpaceNoteCommitResult = { outcome: 'failed' };
		const { next } = change;
		const previous = textRef.current;
		const generation = generationRef.current;
		const sequence = ++saveSequenceRef.current;
		setText(next);
		textRef.current = next;
		setBusy(true);
		setError(undefined);
		const current = () => generation === generationRef.current && sequence === saveSequenceRef.current;
		// 送るのは前の保存の応答を受けてから（その時点の版を付ける）
		return enqueueSave(() => {
			const version = versionRef.current?.wsId === wsId ? versionRef.current.version : undefined;
			// 版を比べられる PC なのに版が無い全文の書き換え（読み直しの途中など）は送らない。PC で更新されていたのと
			// 同じ扱いにして最新を読み直す（版なしで送ると無条件に上書きされ、PC の変更を消す）
			const missingBase = spaceNoteMissingBase(change, version, pcHasCas);
			const send: Promise<SpaceNoteResult> = missingBase
				? Promise.resolve({ ws: wsId, text: previous, conflict: true })
				: useAppStore.getState().noteSet(wsId, next, spaceNoteSetOptions(change, version, pcHasCas));
			return send.then(async (result: SpaceNoteResult) => {
				if (missingBase) {
					setReloadCount(count => count + 1);
				}
				if (versionRef.current?.wsId === wsId) {
					// 後から送った保存の応答より先に届いた応答でも、版は PC のその時点の最新なので控える
					versionRef.current.version = result.updatedAt;
				}
				outcome = { outcome: result.conflict === true ? 'conflict' : 'saved', text: result.text, ...(result.opLine !== undefined ? { opLine: result.opLine } : {}) };
				if (!current()) {
					return;
				}
				setText(result.text ?? next);
				// settledSnapshot() が描き直しを待たずに最新を読めるよう、控えもすぐ進める
				textRef.current = result.text ?? next;
				if (result.conflict === true) {
					// 全文の書き換えが書かれなかったら、書きかけは画面から消えるのでクリップボードへ逃がす（「元に戻す」は書きかけではないので逃がさない）
					const copied = spaceNoteKeepsDraft(change) && await writeClipboardText(next);
					if (current()) {
						setError({ conflict: spaceNoteConflictKind(change, copied) });
					}
				}
			})
			.catch(() => {
				outcome = { outcome: 'failed' };
				if (current()) {
					// 保存できなかったので楽観更新を戻す（チェックが付いたまま残らないように）。
					setText(previous);
					textRef.current = previous;
					setError('save');
				}
			})
			.finally(() => {
				if (current()) {
					setBusy(false);
				}
			});
		}).then(() => outcome, () => outcome);
	}, [wsId, pcHasCas, enqueueSave]);

	const holdDraft = useCallback((draft: string | undefined) => {
		draftRef.current = draft;
	}, []);

	const reload = useCallback(() => setReloadCount(count => count + 1), []);

	// 本文と版は同じ時点（送った保存の応答をすべて受けた後）のものを組にして返す。全文を作る側はこの版を `base` に付ける
	const settledSnapshot = useCallback(() => saveQueueRef.current.then((): SpaceNoteSnapshot => {
		const held = versionRef.current;
		return { wsId: held?.wsId, text: textRef.current, version: held !== undefined && held.wsId === wsId ? held.version : undefined };
	}), [wsId]);

	return { wsId, text, loading: wsId === undefined || loading, busy, error, setError, commit, holdDraft, reload, settledSnapshot };
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
		default:
			return spaceNoteConflictMessage(error.conflict);
	}
}
