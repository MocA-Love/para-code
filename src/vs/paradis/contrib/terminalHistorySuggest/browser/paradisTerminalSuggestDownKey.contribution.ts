/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルのプロンプト入力が非空のとき、↓キーで補完候補リスト(既存のterminal suggestウィジェット)を
// 開けるようにする(Superset同等UX)。実装は3点のみで、upstreamファイルへのPARA-PATCHはゼロ:
//  1. fork独自context key `para.terminalPromptNotEmpty` を per-instance の terminal contribution で
//     promptInputModel から追従させる(ghost text は除外して判定)
//  2. 既存コマンドID TriggerSuggest へ DownArrow の追加キーバインドルールを登録する。
//     既存IDを再利用するのは、TriggerSuggest が DEFAULT_COMMANDS_TO_SKIP_SHELL に登録済みで、
//     この↓キーが xterm/シェルに流れず workbench 側でディスパッチされるため
//     (新規コマンドIDだと upstream の skip-shell リストへの PARA-PATCH が必要になる)。
//     プロンプトが空のときは when 節が不成立になり、↓は従来どおりシェル履歴ナビとして機能する
//  3. fork既定値として runOnEnter を 'always' に上書きし、候補の Enter 確定で即実行にする
//     (terminal.integrated.suggest.enabled は upstream 既定が true のため上書き不要)

import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ICommandDetectionCapability, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { IPromptInputModelState, PromptInputState } from '../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { ITerminalContribution } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../../workbench/contrib/terminal/browser/terminalExtensions.js';
import { TerminalContextKeys } from '../../../../workbench/contrib/terminal/common/terminalContextKey.js';
import { TerminalSuggestCommandId } from '../../../../workbench/contrib/terminalContrib/suggest/common/terminal.suggest.js';
import { TerminalSuggestSettingId } from '../../../../workbench/contrib/terminalContrib/suggest/common/terminalSuggestConfiguration.js';

/**
 * Fork-only context key: whether the active terminal's prompt input (excluding ghost text) is
 * non-empty. Bound per terminal instance via the scoped context key service.
 */
const paradisTerminalPromptNotEmpty = new RawContextKey<boolean>('para.terminalPromptNotEmpty', false, localize('para.terminalPromptNotEmpty', "Whether the terminal prompt input is non-empty (Para Code)"));

/**
 * Tracks the prompt input of a single terminal instance and reflects whether it is non-empty into
 * the {@link paradisTerminalPromptNotEmpty} context key. Instantiated once per terminal with the
 * instance-scoped context key service (same mechanism `terminal.suggest` uses for
 * `suggestWidgetVisible`).
 */
class ParadisTerminalPromptTrackerContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'para.terminalPromptTracker';

	private readonly _promptNotEmptyContextKey: IContextKey<boolean>;
	private readonly _inputListeners = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		ctx: ITerminalContributionContext,
		@IContextKeyService contextKeyService: IContextKeyService
	) {
		super();
		this._promptNotEmptyContextKey = paradisTerminalPromptNotEmpty.bindTo(contextKeyService);

		const capabilities = ctx.instance.capabilities;
		this._register(capabilities.onDidAddCommandDetectionCapability(e => this._attach(e)));
		this._register(capabilities.onDidRemoveCommandDetectionCapability(() => {
			this._inputListeners.clear();
			this._promptNotEmptyContextKey.set(false);
		}));
		const commandDetection = capabilities.get(TerminalCapability.CommandDetection);
		if (commandDetection) {
			this._attach(commandDetection);
		}
	}

	private _attach(commandDetection: ICommandDetectionCapability): void {
		const model = commandDetection.promptInputModel;
		const store = new DisposableStore();
		store.add(model.onDidStartInput(e => this._update(e)));
		store.add(model.onDidChangeInput(e => this._update(e)));
		// コマンド実行が始まったら必ず false へ(実行中の↓を奪わない)
		store.add(model.onDidFinishInput(() => this._promptNotEmptyContextKey.set(false)));
		this._inputListeners.value = store;
		if (model.state === PromptInputState.Execute) {
			this._promptNotEmptyContextKey.set(false);
		} else {
			this._update(model);
		}
	}

	private _update(state: IPromptInputModelState): void {
		// ghost text(シェルのautosuggest表示)は実入力ではないので切り落として判定する
		const value = state.ghostTextIndex === -1 ? state.value : state.value.substring(0, state.ghostTextIndex);
		this._promptNotEmptyContextKey.set(value.trim().length > 0);
	}
}
registerTerminalContribution(ParadisTerminalPromptTrackerContribution.ID, ParadisTerminalPromptTrackerContribution);

// ↓キーで候補リストを開く。既存の SelectNextSuggestion(when: suggestWidgetVisible)とは
// when 節が排他なので競合しない。ユーザーは keybindings.json の
// `-workbench.action.terminal.triggerSuggest` で無効化/変更できる。
KeybindingsRegistry.registerKeybindingRule({
	id: TerminalSuggestCommandId.TriggerSuggest,
	primary: KeyCode.DownArrow,
	weight: KeybindingWeight.WorkbenchContrib + 1,
	when: ContextKeyExpr.and(
		TerminalContextKeys.focus,
		TerminalContextKeys.suggestWidgetVisible.negate(),
		paradisTerminalPromptNotEmpty,
		TerminalContextKeys.altBufferActive.negate(),
		TerminalContextKeys.terminalShellIntegrationEnabled,
		ContextKeyExpr.equals(`config.${TerminalSuggestSettingId.Enabled}`, true)
	)
});

// Para Code の fork 既定値: 候補を Enter で確定したら即実行する(Superset の Enter=run と同等)。
// 設定の "default" レイヤーへの注入なので、ユーザーが settings.json で明示的に
// terminal.integrated.suggest.runOnEnter を設定している場合はそちらが優先される。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		[TerminalSuggestSettingId.RunOnEnter]: 'always'
	}
}]);
