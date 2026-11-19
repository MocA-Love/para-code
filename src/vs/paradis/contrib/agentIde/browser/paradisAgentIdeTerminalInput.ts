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
import { paradisInteractiveAgentCommand, paradisIsInteractiveAntigravityCommand } from '../../mobileRelay/common/paradisAgentCliCommand.js';
import type { IParadisTerminalCommandEvidence } from '../../mobileRelay/common/paradisMobileAgentResume.js';

type TerminalLike = Pick<ITerminalInstance, 'capabilities' | 'xterm'>;

/**
 * 前面でエージェントが動いているか。シェル統合の「実行中のコマンド」で判断する。
 * シェル統合が無いターミナルでは確かめようがないので、素のシェルとして扱う（安全側）。
 * hook が届いたことがあるかで代えると、エージェントが終わった後のシェルもエージェント扱いになり、
 * 偽の hook でも立てられてしまう。
 */
export function paradisTerminalRunsAgent(instance: TerminalLike): boolean {
	const executing = instance.capabilities.get(TerminalCapability.CommandDetection)?.executingCommand;
	return executing !== undefined && paradisInteractiveAgentCommand(executing) !== undefined;
}

/**
 * 前面で Antigravity CLI（`agy`）が対話の画面を開いているか（{@link paradisTerminalRunsAgent} と同じく、シェル統合が
 * 無ければ false）。agy は {@link paradisTerminalRunsAgent} の種別に入れていないので、別に見る。
 */
export function paradisTerminalRunsAntigravity(instance: TerminalLike): boolean {
	const executing = instance.capabilities.get(TerminalCapability.CommandDetection)?.executingCommand;
	return executing !== undefined && paradisIsInteractiveAntigravityCommand(executing);
}

/**
 * シェル統合が記録している、終わったコマンド（終わった時刻と終了コード）と実行中のコマンド。Antigravity CLI が終わったか・
 * 前面が同じ会話かの判定（paradisMobileAgentResume.ts）に渡す。シェル統合が無ければ undefined。
 */
export function paradisTerminalCommandEvidence(instance: Pick<ITerminalInstance, 'capabilities'>): IParadisTerminalCommandEvidence | undefined {
	const detection = instance.capabilities.get(TerminalCapability.CommandDetection);
	return detection === undefined ? undefined : {
		// `timestamp` はコマンドが終わった時刻（再読み込みで戻したコマンドも、保存したときの値のまま）
		finished: detection.commands.map(command => ({ at: command.timestamp, exitCode: command.exitCode })),
		executing: detection.executingCommand,
	};
}

/** 複数行をそのまま貼り付けてよいか（行ごとに実行される心配が無いか）。 */
export function paradisCanPasteMultiline(instance: TerminalLike): boolean {
	return instance.xterm?.raw.modes.bracketedPasteMode === true && paradisTerminalRunsAgent(instance);
}
