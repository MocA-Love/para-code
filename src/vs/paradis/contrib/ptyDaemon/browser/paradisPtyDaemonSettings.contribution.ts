/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの設定。設定画面に出すためだけのファイルで、読むのは main プロセス側。

import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis.terminal',
	order: 100,
	type: 'object',
	title: localize('paradis.terminal.title', "Para Code Terminal"),
	properties: {
		'paradis.terminal.daemon.enabled': {
			type: 'boolean',
			default: false,
			// APPLICATION スコープ: ターミナルのプロセスを持つのは main プロセスなので、
			// ウィンドウやワークスペースごとに切り替えられる設定にはできない。
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.terminal.daemon.enabled', "ターミナルを Para Code の外の常駐プロセスで動かします。有効にすると、ウィンドウを閉じても Para Code を終了しても、実行中のコマンドやエージェントはそのまま動き続け、次に開いたときに元の画面のまま繋ぎ直せます。\n\n変更は Para Code の再起動後に反映されます。PC を再起動すると常駐も終了します。"),
			tags: ['experimental'],
		},
	},
});
