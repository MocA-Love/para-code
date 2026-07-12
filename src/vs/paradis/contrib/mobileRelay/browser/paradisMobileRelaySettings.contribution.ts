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
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.mobile.agent.codexDaemonStreaming', "ローカルのCodex app-server daemonを起動または再利用し、その後に開始したCodexセッションの生成中テキスト・SubAgent・ツール出力・動的モデル一覧・次ターン設定をPara Code Mobileへ連携します。macOS/Linuxのみ対応します。Para Codeは共有daemonを停止しません。問題がある場合は無効にでき、無効時や接続失敗時は従来のhook/transcript同期へ自動的に戻ります。")
		}
	}
});
