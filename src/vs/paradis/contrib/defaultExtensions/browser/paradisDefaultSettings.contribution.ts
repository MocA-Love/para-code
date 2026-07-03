/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

// Para Code が全ユーザーへ配布するデフォルト設定。
// 拡張機能の `contributes.configurationDefaults` と同じ仕組み（設定の "default" レイヤーへの注入）なので、
// ユーザーが settings.json で明示的に上書きしていない項目にのみ効き、各自の上書きを一切妨げない。
// 対象拡張が未インストールの時点で登録されても問題なく、拡張側の設定スキーマ登録時に defaults として合流する。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'workbench.iconTheme': 'material-icon-theme',
		'workbench.colorTheme': 'Houston',
		'sqlite.recordsPerPage': 500,
		'githubPullRequests.createOnPublishBranch': 'never',
		'indentRainbow.colors': [
			'rgba(3, 4, 94,0.15)',
			'rgba(2, 62, 138,0.15)',
			'rgba(0, 119, 182, 0.15)',
			'rgba(0, 150, 199,0.15)',
			'rgba(0, 180, 216,0.15)',
			'rgba(72, 202, 228,0.15)',
			'rgba(144, 224, 239,0.15)',
			'rgba(144, 224, 239,0.1)',
			'rgba(144, 224, 239,0.05)',
			'rgba(144, 224, 239,0.025)'
		],
		'gpgIndicator.enablePassphraseCache': true,
		'gpgIndicator.statusStyle': 'fingerprint'
	}
}]);
