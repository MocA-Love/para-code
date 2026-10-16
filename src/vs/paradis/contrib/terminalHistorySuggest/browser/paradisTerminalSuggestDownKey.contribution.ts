/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの補完候補リスト（upstream の terminal suggest）に Para Code が足しているキーと既定値。
//  1. 候補リスト表示中は →キーを AcceptSelectedSuggestion に割り当てる(Superset の「→で選択候補の
//     suffix 入力」相当)。AcceptSelectedSuggestion は DEFAULT_COMMANDS_TO_SKIP_SHELL 登録済みなので
//     この when 成立時は → がシェルへ流れず、zsh-autosuggestions のゴースト確定と競合しない。
//     リスト非表示時の → は従来どおりシェルへ素通し(ゴースト確定/カーソル移動)される
//  2. fork既定値として runOnEnter を 'always' に上書きし、候補の Enter 確定で即実行にする。
//     'always' で即実行するのは Para Code の履歴の候補だけ。パス・フォルダなどほかの候補は入力欄に
//     入れるだけにする(paradisTerminalSuggestRunOnEnter.ts、terminalSuggestAddon.ts の PARA-PATCH 1箇所)
//  3. fork既定値として inlineSuggestion を 'off' に上書きし、シェルのゴーストテキストを候補リストへ
//     取り込まない(ゴースト=シェル、リスト=エディタ側という Superset と同じ役割分担にする)
//
// 以前はここで「入力が空でないときの ↓」で候補リストを開いていたが、シェルの ↑ で呼び出した行も
// 「空でない」と見なされ、遡った後の ↓ が一覧に化けていた(Q372)。↓ は履歴の一覧
// (terminalHistoryPanel、遡り中は開かない)に移し、候補リストは Ctrl+Space で開く。

import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TerminalContextKeys } from '../../../../workbench/contrib/terminal/common/terminalContextKey.js';
import { TerminalSuggestCommandId } from '../../../../workbench/contrib/terminalContrib/suggest/common/terminal.suggest.js';
import { TerminalSuggestSettingId } from '../../../../workbench/contrib/terminalContrib/suggest/common/terminalSuggestConfiguration.js';
import { SimpleSuggestContext } from '../../../../workbench/services/suggest/browser/simpleSuggestWidget.js';

// 候補リスト表示中(かつフォーカスされた候補がある時)は →キーで選択候補を確定する。
// when 節が suggestWidgetVisible を要求するため、リスト非表示時の → はシェルへ流れて
// 従来どおりゴースト確定/カーソル移動として機能する。ユーザーは keybindings.json の
// `-workbench.action.terminal.acceptSelectedSuggestion` で無効化/変更できる。
// 意図的なトレードオフ: リスト表示中は → での行内カーソル右移動ができなくなる(Superset と同じ。
// Esc でリストを閉じれば従来の → に戻る)。
KeybindingsRegistry.registerKeybindingRule({
	id: TerminalSuggestCommandId.AcceptSelectedSuggestion,
	primary: KeyCode.RightArrow,
	weight: KeybindingWeight.WorkbenchContrib + 1,
	when: ContextKeyExpr.and(
		TerminalContextKeys.focus,
		TerminalContextKeys.suggestWidgetVisible,
		SimpleSuggestContext.HasFocusedSuggestion
	)
});

// Para Code の fork 既定値: 履歴の候補を Enter で確定したら即実行する(Superset の Enter=run と同等)。
// パス・フォルダなどほかの候補は 'always' でも入力欄に入れるだけ(paradisResolveRunOnEnter)。
// inlineSuggestion 'off' はシェルのゴーストテキストを候補リストへ取り込まない(役割分担の明確化)。
// 設定の "default" レイヤーへの注入なので、ユーザーが settings.json で明示的に
// 同キーを設定している場合はそちらが優先される。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		[TerminalSuggestSettingId.RunOnEnter]: 'always',
		[TerminalSuggestSettingId.InlineSuggestion]: 'off'
	}
}]);
