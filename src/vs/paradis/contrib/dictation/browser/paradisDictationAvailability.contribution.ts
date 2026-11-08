/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// upstream 内蔵の音声入力（ディクテーション）の既定の有効・無効を、Para の認識エンジンが動く OS に合わせる。
//
// upstream の認識の部品（Foundry Local）はパッケージングで削られ、初回に `product.json` の `dictationRuntime` の
// URL から取ってくる前提になっている。Para Code はこの値を書かない（Q92 で断った。`para-release.yml` の
// `dictation_runtime`、NOTES.md 参照）。代わりに認識の中身を Para の実装に差し替えてある
// （../electron-browser/paradisLocalTranscriptionService.ts。いまは macOS 26 以上の Mac の音声認識だけ）。
//
// Mac は upstream の既定（`dictation.enabled: true`）のままにする。macOS 26 より古い Mac では差し替え先が
// 「使えない」と答えるので、upstream のマイクは出ない（Para のチャット表示のマイクが案内を出す）。
// Windows・Linux は認識の中身がまだ無いので、既定値だけを false にする（upstream のチャット・エディタ・
// ターミナルの入口とモデルの取り込みコマンドは、どれもこの設定で閉じる）。既定値の層なので、settings.json で
// 自分で true にした人はそのまま使える。upstream のファイルは触らない。

import { isMacintosh } from '../../../../base/common/platform.js';
import { IProductConfiguration } from '../../../../base/common/product.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

export const PARADIS_DICTATION_ENABLED_SETTING = 'dictation.enabled';

/** このビルドで音声入力の既定値を上書きする内容。部品の取得先があるか、Mac なら何もしない。 */
export function paradisDictationDefaultOverrides(productConfiguration: Pick<IProductConfiguration, 'dictationRuntime'>, macintosh: boolean): Record<string, unknown> | undefined {
	return productConfiguration.dictationRuntime || macintosh ? undefined : { [PARADIS_DICTATION_ENABLED_SETTING]: false };
}

const overrides = paradisDictationDefaultOverrides(product, isMacintosh);
if (overrides) {
	Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{ overrides }]);
}
