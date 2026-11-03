/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { paradisWindowTransparencyDefault } from '../../../../platform/window/common/paradisWindowTransparency.js';

// Paradis独自設定の集約セクション。将来的にこのセクションへ他のParadis独自設定も追加していく想定のため、
// title/id は共通の 'paradis' とし、各機能はプロパティのプレフィックス（例: paradis.window.*）で区別する。
const paradisConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...paradisConfigurationNodeBase,
	properties: {
		'paradis.window.transparency.enabled': {
			type: 'boolean',
			// 既定は macOS・Linux でオン、Windows でオフ。mainプロセス側の生成時判定 (windowImpl.ts の PARA-PATCH) は
			// このレジストリ既定値が見えないため、両方が同じ paradisWindowTransparencyDefault を使う。
			default: paradisWindowTransparencyDefault(),
			// APPLICATIONスコープ: ネイティブウィンドウの生成時フラグはmainプロセスがdefaultプロファイルの
			// user settings.json だけを読んで決めるため、Workspace/プロファイルスコープでの上書きを許すと
			// mainとレンダラで値が食い違い「クラスは付くが透けない」状態になる。
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.window.transparency.enabled', "オンにすると、エディタ・サイドバー・パネル・タイトルバーの地が透けてデスクトップが見えます。メニュー・ホバー・通知・ダイアログは透けません。統合ターミナルの地も透けます。Windows で `#window.titleBarStyle#` が `native` のときは、Electron の制約で透けません。Windows でオンにすると、Win+矢印や画面の端へのドラッグでのスナップと、縁をつかんでのリサイズが効かなくなります（Windows では既定でオフです）。切り替えはアプリを再起動すると効きます（ウィンドウの再読み込みでは効きません）。")
		},
		'paradis.window.transparency.opacity': {
			type: 'number',
			default: 0.9,
			minimum: 0.3,
			maximum: 1,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize('paradis.window.transparency.opacity', "{0} が有効なときのワークベンチ背景の不透明度を制御します。`0.3`〜`1` の任意の小数（例: `0.95`）を指定でき、`1` に近いほど不透明になります。背景のみが対象なので文字の読みやすさは保たれます。変更はリロード不要で即座に反映されます。", '`#paradis.window.transparency.enabled#`')
		}
	}
});
