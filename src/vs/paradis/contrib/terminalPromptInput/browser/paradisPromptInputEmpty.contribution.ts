/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルを作った時点から、プロンプトが出た直後の入力欄の値（基準）を追う（`paradisTrackPromptInputBaseline`）。
// 判定は `paradisPromptInputEmpty.ts` の `paradisIsAtEmptyPrompt` から読む。

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { ITerminalContribution } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../../workbench/contrib/terminal/browser/terminalExtensions.js';
import { paradisTrackPromptInputBaseline } from './paradisPromptInputEmpty.js';

/** ターミナルごとに、プロンプトが出た直後の入力欄の値を覚える。 */
class ParadisPromptInputBaselineContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'para.promptInputBaseline';

	private readonly _tracking = this._register(new MutableDisposable());

	constructor(ctx: ITerminalContributionContext) {
		super();
		const capabilities = ctx.instance.capabilities;
		this._register(capabilities.onDidAddCommandDetectionCapability(e => this._tracking.value = paradisTrackPromptInputBaseline(e)));
		this._register(capabilities.onDidRemoveCommandDetectionCapability(() => this._tracking.clear()));
		const commandDetection = capabilities.get(TerminalCapability.CommandDetection);
		if (commandDetection) {
			this._tracking.value = paradisTrackPromptInputBaseline(commandDetection);
		}
	}
}
registerTerminalContribution(ParadisPromptInputBaselineContribution.ID, ParadisPromptInputBaselineContribution);
