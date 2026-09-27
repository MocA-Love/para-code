/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// IDE 操作ツール（O1）がターミナルへ文字を送るときの判定。
//  - 前面で Claude Code / Codex が動いているか（素のシェルか）
//  - 複数行を貼り付けてよいか。フェーズ5のコマンドプリセット（`paradisPresetService` の
//    `_insertAgentPrompt`）と同じ規則: 貼り付けの囲み（bracketed paste）が有効で、しかも
//    シェル統合で前面のコマンドがエージェントだと確かめられたときだけ。xterm の貼り付けモードの
//    記録は最後に出た `ESC[?2004h/l` でしかなく、エージェントが後始末をせずに落ちると立ったままになる

import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import type { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisInteractiveAgentCommand } from '../../mobileRelay/common/paradisAgentCliCommand.js';

type TerminalLike = Pick<ITerminalInstance, 'capabilities' | 'xterm'>;

/**
 * 前面でエージェントが動いているか。シェル統合があれば前面のコマンドで判断する。
 * シェル統合が無いターミナル（接続先や統合の無いシェル）では、hook が届いたことがあるかで代える。
 */
export function paradisTerminalRunsAgent(instance: TerminalLike, hookEverFired: boolean): boolean {
	const detection = instance.capabilities.get(TerminalCapability.CommandDetection);
	if (detection === undefined) {
		return hookEverFired;
	}
	const executing = detection.executingCommand;
	return executing !== undefined && paradisInteractiveAgentCommand(executing) !== undefined;
}

/** 複数行をそのまま貼り付けてよいか（行ごとに実行される心配が無いか）。 */
export function paradisCanPasteMultiline(instance: TerminalLike): boolean {
	const detection = instance.capabilities.get(TerminalCapability.CommandDetection);
	const executing = detection?.executingCommand;
	return instance.xterm?.raw.modes.bracketedPasteMode === true
		&& executing !== undefined
		&& paradisInteractiveAgentCommand(executing) !== undefined;
}
