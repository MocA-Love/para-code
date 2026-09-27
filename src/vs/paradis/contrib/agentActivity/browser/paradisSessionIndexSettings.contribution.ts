/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話の全文索引の設定スキーマ。スキーマの登録だけなので web / desktop 共通で読み込む。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	PARADIS_SESSION_INDEX_DEFAULT_RETENTION_DAYS,
	PARADIS_SESSION_INDEX_SETTING_ENABLED,
	PARADIS_SESSION_INDEX_SETTING_INCLUDE_TOOL_OUTPUT,
	PARADIS_SESSION_INDEX_SETTING_RETENTION_DAYS,
} from '../common/paradisSessionIndex.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_SESSION_INDEX_SETTING_ENABLED]: {
			type: 'boolean',
			default: true,
			// 索引は手元のマシンの userData に1つだけ作る。ワークスペースごとに変えられると意味が通らない。
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.sessionIndex.enabled', "セッション履歴で会話の全文を検索できるよう、会話ログの全文を検索用に Para Code 内へ保存します。会話に貼った秘密情報もコピーされます。オフにすると保存した索引は消えます。"),
		},
		[PARADIS_SESSION_INDEX_SETTING_RETENTION_DAYS]: {
			type: 'number',
			default: PARADIS_SESSION_INDEX_DEFAULT_RETENTION_DAYS,
			minimum: 1,
			maximum: 3650,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.sessionIndex.retentionDays', "全文索引に入れる会話の日数です。最後の更新がこれより前の会話は索引から外し、従来の検索（会話の先頭と末尾だけを見る）で探します。"),
		},
		[PARADIS_SESSION_INDEX_SETTING_INCLUDE_TOOL_OUTPUT]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.sessionIndex.includeToolOutput', "コマンドの実行結果などツールの出力も全文索引に入れます。検索できる範囲は広がりますが、索引が大きくなり、出力に含まれた秘密情報も残ります。"),
		},
	},
});
