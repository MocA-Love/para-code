/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// upstream 内蔵の音声入力（ディクテーション）を、動かせないビルドでは既定で無効にする。
//
// 音声入力のネイティブ部品はパッケージングで削られ、初回に `product.json` の `dictationRuntime` の
// URL から取ってくる前提になっている。Para Code はライセンスの確認が済むまでこの値を書かない
// （`para-release.yml` の `dictation_runtime`、NOTES.md 参照）。値が無いのに upstream の既定
// （`dictation.enabled: true`）のままだと、マイクのボタン・コマンド・キーが出て、押すと約 775MB の
// 音声認識モデルを落とした後、部品が無いので失敗する。
//
// そこで `dictationRuntime` が無いビルドでは、設定の既定値だけを false にする（upstream の
// チャット・エディタ・ターミナルの入口とモデルの取り込みコマンドは、どれもこの設定で閉じる）。
// 既定値の層なので、settings.json で自分で true にした人はそのまま使える。upstream のファイルは触らない。

import { IProductConfiguration } from '../../../../base/common/product.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

export const PARADIS_DICTATION_ENABLED_SETTING = 'dictation.enabled';

/** このビルドで音声入力の既定値を上書きする内容。部品の取得先があれば何もしない。 */
export function paradisDictationDefaultOverrides(productConfiguration: Pick<IProductConfiguration, 'dictationRuntime'>): Record<string, unknown> | undefined {
	return productConfiguration.dictationRuntime ? undefined : { [PARADIS_DICTATION_ENABLED_SETTING]: false };
}

const overrides = paradisDictationDefaultOverrides(product);
if (overrides) {
	Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{ overrides }]);
}
