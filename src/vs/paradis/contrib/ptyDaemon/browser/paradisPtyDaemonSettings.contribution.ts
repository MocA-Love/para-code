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
import { PARADIS_PTY_DAEMON_ENABLED, PARADIS_PTY_DAEMON_KEEP_ALIVE_ON_CLOSE, PARADIS_PTY_HOST_DAEMON_ENABLED } from '../common/paradisPtyDaemonSettingKey.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis.terminal',
	order: 100,
	type: 'object',
	title: localize('paradis.terminal.title', "Para Code Terminal"),
	properties: {
		[PARADIS_PTY_DAEMON_ENABLED]: {
			type: 'boolean',
			default: false,
			// APPLICATION スコープ: ターミナルのプロセスを持つのは main プロセスなので、
			// ウィンドウやワークスペースごとに切り替えられる設定にはできない。
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.terminal.daemon.enabled', "ターミナルを Para Code の外の常駐プロセスで動かします。有効にすると、ウィンドウを閉じても Para Code を終了しても、実行中のコマンドやエージェントはそのまま動き続け、次に開いたときに元の画面のまま繋ぎ直せます。\n\n変更は Para Code の再起動後に反映されます。PC を再起動すると常駐も終了します。残したターミナルは、Para Code を終了したあと24時間どのウィンドウからも開かれなければ終了します（Para Code が起動している間は、開いていなくても残ります）。"),
			tags: ['experimental'],
		},
		[PARADIS_PTY_HOST_DAEMON_ENABLED]: {
			type: 'boolean',
			default: false,
			// MACHINE スコープ: **この設定だけは接続先(REH)にも読み手が居る**
			// (`paradisRemotePtyHost.ts`)。しかも読むのは接続先のマシン設定で、こちらの
			// ユーザー設定ではない。APPLICATION のままだと設定画面から接続先側へ書く手立てが
			// 無く、「SSH 先でも同じように動きます」と書いてある機能を、接続先の
			// settings.json を手で開く以外に有効にできない。
			// MACHINE はワークスペースからの上書きを許さない点は APPLICATION と同じなので、
			// 「ターミナルのプロセスを持つのはマシンごとの1つ」という前提は保たれる。
			scope: ConfigurationScope.MACHINE,
			markdownDescription: localize('paradis.terminal.daemon.reattachAcrossUpdates', "ターミナルを常駐プロセスで動かし、**Para Code を更新しても繋ぎ直せる**ようにします。SSH 先でも同じように動きます。\n\n{0} との違いは、更新したときの振る舞いだけです。あちらは更新すると新しい常駐に切り替わり、それまでのターミナルは古い常駐に取り残されます。\n\nまた、閉じている間もコマンドは止まらずに走り切ります（そのぶん、長く走ると古い出力から消えることがあります。消えた場合は画面にその旨が出ます）。\n\n変更は Para Code の再起動後に反映されます。", `\`#${PARADIS_PTY_DAEMON_ENABLED}#\``),
			tags: ['experimental'],
		},
		[PARADIS_PTY_DAEMON_KEEP_ALIVE_ON_CLOSE]: {
			type: 'string',
			enum: ['ask', 'always', 'never'],
			default: 'ask',
			scope: ConfigurationScope.APPLICATION,
			enumDescriptions: [
				localize('paradis.terminal.daemon.keepAliveOnClose.ask', "閉じるたびに尋ねます。"),
				localize('paradis.terminal.daemon.keepAliveOnClose.always', "尋ねずに残します。"),
				localize('paradis.terminal.daemon.keepAliveOnClose.never', "尋ねずに終了します（常駐を使わないのと同じ結果になります）。"),
			],
			markdownDescription: localize('paradis.terminal.daemon.keepAliveOnClose', "ウィンドウを閉じるときに、実行中のターミナルを常駐へ残すかどうかです。{0} または「更新をまたいで繋ぎ直す」が有効なときに意味を持ちます。\n\nPara Code を終了するときは尋ねません（開いているウィンドウの数だけダイアログが並ぶため）。覚えている選択があればそれに従い、無ければ残します。\n\n残したターミナルは、Para Code を終了したあと24時間どのウィンドウからも開かれなければ終了します（Para Code が起動している間は、開いていなくても残ります）。", `\`#${PARADIS_PTY_DAEMON_ENABLED}#\``),
		},
	},
});
