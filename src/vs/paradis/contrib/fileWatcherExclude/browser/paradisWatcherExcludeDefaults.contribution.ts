/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { PARADIS_NODE_MODULES_WATCHER_EXCLUDE, PARADIS_VENV_WATCHER_EXCLUDE } from '../../../../platform/files/common/paradisWatcherExcludes.js';

// files.watcherExclude の既定に、依存パッケージと Python 仮想環境の中身を足す。
// SSH 先の REH で node_modules の中まで監視して inotify の監視数と fileWatcher のメモリが膨らんだため。
// オブジェクトの設定なので、本家の既定（.git/objects/** など）と合わさる（configurationRegistry の mergeDefaultConfigurationsForConfigurationProperty）。
// 合わさるのは本家のスキーマが先に登録されているとき。workbench.common.main.ts は files.contribution を paradis より先に読み込む。
// node_modules のキーは TS 拡張の完全一致の判定に合わせてこの形のまま。parcel へは parcelWatcher.ts でルート相対の形に直して渡す（paradisWatcherExcludes.ts）。
// default レイヤーなので、ユーザーが settings.json で false にすれば監視に戻せる。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'files.watcherExclude': {
			[PARADIS_NODE_MODULES_WATCHER_EXCLUDE]: true,
			[PARADIS_VENV_WATCHER_EXCLUDE]: true
		}
	}
}]);
