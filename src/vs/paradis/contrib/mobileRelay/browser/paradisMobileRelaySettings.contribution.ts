/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { PARADIS_MOBILE_CODEX_DAEMON_STREAMING_KEY, PARADIS_MOBILE_DEFAULT_RELAY_URL, PARADIS_MOBILE_ENABLED_KEY, PARADIS_MOBILE_RELAY_URL_KEY } from '../common/paradisMobileRelay.js';

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
		[PARADIS_MOBILE_CODEX_DAEMON_STREAMING_KEY]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.mobile.agent.codexDaemonStreaming', "実験的: `codex remote-control start` などで既に稼働しているローカル app-server daemonへ読み取りクライアントとして接続し、Codexの生成中テキストとツール出力をPara Code Mobileへリアルタイム表示します。macOS/Linuxのみ対応し、daemonの起動は行いません。複数クライアント購読はCodex側で発展中の機能のため、問題がある場合は無効にしてください。無効時や接続失敗時は従来のhook/transcript同期へ自動的に戻ります。")
		}
	}
});
