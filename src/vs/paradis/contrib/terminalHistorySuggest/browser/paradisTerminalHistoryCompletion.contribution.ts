/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルのシェル実行履歴(全シェル横断で永続化されているコマンド履歴、"Run Recent Command"
// が使っているのと同じデータソース)を、既存のターミナル入力候補ポップアップ(Ctrl+Space /
// quickSuggestions)に候補として追加する。VS Code純正のterminal suggestはPATH上のコマンドや
// ファイルパス補完が中心でシェルの実行履歴そのものは含まないため、その差分を埋める。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { getCommandHistory } from '../../../../workbench/contrib/terminalContrib/history/common/history.js';
import { ITerminalCompletion, TerminalCompletionItemKind } from '../../../../workbench/contrib/terminalContrib/suggest/browser/terminalCompletionItem.js';
import { ITerminalCompletionProvider, ITerminalCompletionService } from '../../../../workbench/contrib/terminalContrib/suggest/browser/terminalCompletionService.js';

const MAX_RESULTS = 20;

class ParadisTerminalHistoryCompletionProvider implements ITerminalCompletionProvider {

	static readonly ID = 'para.terminalHistory';

	id = ParadisTerminalHistoryCompletionProvider.ID;
	triggerCharacters?: string[];

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) { }

	async provideCompletions(value: string, cursorPosition: number, token: CancellationToken): Promise<ITerminalCompletion[] | undefined> {
		const prefix = value.substring(0, cursorPosition);
		if (prefix.trim().length === 0) {
			return undefined;
		}

		const history = this._instantiationService.invokeFunction(getCommandHistory);
		// Most recently used entries are appended last, prefer those first.
		const entries = Array.from(history.entries).reverse();

		const seen = new Set<string>();
		const completions: ITerminalCompletion[] = [];
		for (const [command] of entries) {
			if (completions.length >= MAX_RESULTS) {
				break;
			}
			if (command === prefix || !command.startsWith(prefix) || seen.has(command)) {
				continue;
			}
			seen.add(command);
			completions.push({
				label: command,
				provider: this.id,
				kind: TerminalCompletionItemKind.Method,
				// Opt out of the PowerShell "kind === Method && start === 0 → treat as file" heuristic
				// in TerminalCompletionService, which would escape spaces in multi-word history entries.
				isFileOverride: false,
				detail: localize('para.terminalHistory.detail', "History"),
				replacementRange: [0, cursorPosition]
			});
		}
		return completions;
	}
}

class ParadisTerminalHistoryCompletionContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisTerminalHistoryCompletion';

	constructor(
		@ITerminalCompletionService terminalCompletionService: ITerminalCompletionService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		this._register(terminalCompletionService.registerTerminalCompletionProvider(
			'para',
			ParadisTerminalHistoryCompletionProvider.ID,
			instantiationService.createInstance(ParadisTerminalHistoryCompletionProvider)
		));
	}
}

registerWorkbenchContribution2(ParadisTerminalHistoryCompletionContribution.ID, ParadisTerminalHistoryCompletionContribution, WorkbenchPhase.AfterRestored);
