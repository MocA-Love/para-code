/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { PARADIS_MOBILE_CODEX_DAEMON_STREAMING_KEY, PARADIS_MOBILE_DEFAULT_RELAY_URL, PARADIS_MOBILE_ENABLED_KEY, PARADIS_MOBILE_PC_NAME_KEY, PARADIS_MOBILE_RELAY_URL_KEY } from '../common/paradisMobileRelay.js';

const paradisConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...paradisConfigurationNodeBase,
	properties: {
		[PARADIS_MOBILE_ENABLED_KEY]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.mobile.enabled', "Para Code Mobile（iOS アプリ）からの遠隔操作を有効にします。ペアリング済みのデバイスがある場合、起動時に自動的にリレーへ接続します。ペアリングは「Para Code: モバイルデバイスを接続」コマンドから行います。")
		},
		[PARADIS_MOBILE_RELAY_URL_KEY]: {
			type: 'string',
			default: PARADIS_MOBILE_DEFAULT_RELAY_URL,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.mobile.relayUrl', "Para Code Mobile が使用するリレーサーバーの WebSocket URL です。セルフホストする場合に変更します。通常は変更する必要はありません。")
		},
		[PARADIS_MOBILE_PC_NAME_KEY]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.mobile.pcName', "Para Code Mobile のPC一覧に表示される、このPCの名前です。空のままにするとこのマシンのホスト名を使います。複数のPCとペアリングしているときに見分けやすい名前を付けてください。")
		},
		[PARADIS_MOBILE_CODEX_DAEMON_STREAMING_KEY]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.mobile.agent.codexDaemonStreaming', "Codexのライブ連携: 生成中の文字・子エージェント・ツールの出力・モデル一覧・次のターンの設定を、Para Code Mobileへその場で送ります。有効にすると、Codexを開いたターミナル1つにつき裏方のプロセスがもう1つ立ち上がり、その下でツール連携（MCP）のプロセス群も丸ごと起動し直されるため、メモリと起動時間がターミナルの数だけ増えます。無効のあいだCodexは素のまま動き、モバイルへは少し遅れて届きます（モバイルからモデルと思考の深さは変えられません）。この設定は新しく開いたターミナルから効きます。{0} が無効なときは何も起動しません。", `\`${PARADIS_MOBILE_ENABLED_KEY}\``)
		}
	}
});
