/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// git の操作が失敗したときのダイアログ・通知に「AI で直す」を足す（G-02）。押すと失敗の中身を
// Para Code の本体のコマンドへ渡し、本体が今のスペースの Claude Code・Codex へ依頼文を送る
// （src/vs/paradis/contrib/scmAgentFix）。commands.ts の createCommand の catch から呼ぶ。

import { commands, l10n, Uri } from 'vscode';

/** 本体（src/vs/paradis/contrib/scmAgentFix）のコマンド。 */
const PARADIS_FIX_SCM_FAILURE_COMMAND = 'paradis.scmAgentFix.fixFailure';

interface IParadisGitFailure {
	readonly gitArgs?: unknown;
	readonly stderr?: unknown;
	readonly stdout?: unknown;
	readonly gitErrorCode?: unknown;
	readonly message?: unknown;
}

/**
 * 失敗の選択肢に「AI で直す」を足す。知らせだけの種類（空のコミットメッセージなど）には足さない。
 * `root` は失敗した操作のリポジトリ（本体が今のスペースのものか確かめる。分からなければ undefined）。
 */
export function paradisAddAgentFixChoice(choices: Map<string, () => void>, type: 'error' | 'warning' | 'information', err: IParadisGitFailure, root: string | undefined): void {
	if (type === 'information') {
		return;
	}
	const payload = {
		args: Array.isArray(err.gitArgs) ? err.gitArgs.filter(arg => typeof arg === 'string') : [],
		stderr: typeof err.stderr === 'string' ? err.stderr : '',
		stdout: typeof err.stdout === 'string' ? err.stdout : '',
		errorCode: typeof err.gitErrorCode === 'string' ? err.gitErrorCode : undefined,
		message: typeof err.message === 'string' ? err.message : String(err),
		root: root !== undefined ? Uri.file(root).toString() : undefined,
	};
	// allow-any-unicode-next-line
	choices.set(l10n.t('AI で直す'), () => {
		// Web のビルドなど、本体にコマンドが無い環境では何もしない
		commands.executeCommand(PARADIS_FIX_SCM_FAILURE_COMMAND, payload).then(undefined, () => undefined);
	});
}
