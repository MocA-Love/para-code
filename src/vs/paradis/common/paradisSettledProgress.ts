/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IProgress, IProgressService, IProgressStep } from '../../platform/progress/common/progress.js';

/**
 * `IProgressService.withProgress` と同じだが、`task` の失敗で未処理の rejection を出さない。
 *
 * upstream の通知の進行表示（`progressService.ts` の `withNotificationProgress`）は、渡された promise から
 * 派生させた `.finally()` を捨て、片付けの即時実行 async にも catch が無い。`task` が拒否すると、呼び出し側が
 * 受け止めていても 1 回の失敗で未処理の rejection が 2 本上がり、`onUnexpectedError` から Sentry に載る
 * （PARA-CODE-DESKTOP-NB ほか: 変更の残ったワークツリーの削除で git が断るたびに出ていた）。
 * そこで `task` の結果をいったん受け止め、`withProgress` の外で投げ直す。呼び出し側の catch はそのまま効く。
 */
export async function paradisWithSettledProgress<R>(
	progressService: IProgressService,
	options: Parameters<IProgressService['withProgress']>[0],
	task: (progress: IProgress<IProgressStep>) => Promise<R>,
	onDidCancel?: (choice?: number) => void,
): Promise<R> {
	let outcome: { readonly ok: true; readonly value: R } | { readonly ok: false; readonly error: unknown } | undefined;
	await progressService.withProgress(options, async progress => {
		try {
			outcome = { ok: true, value: await task(progress) };
		} catch (error) {
			outcome = { ok: false, error };
		}
	}, onDidCancel);
	if (outcome === undefined) {
		throw new Error('The progress task did not run');
	}
	if (!outcome.ok) {
		throw outcome.error;
	}
	return outcome.value;
}
