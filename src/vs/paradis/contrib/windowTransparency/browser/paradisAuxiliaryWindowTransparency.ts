/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// auxiliary window (Agent Live Window 等、メインウィンドウとは別の BrowserWindow として開くウィンドウ)
// をウィンドウ透過 (paradis-transparent) に対応させるための共有ヘルパー。
//
// aux window は windowImpl.ts の BrowserWindow 生成経路を通らない (別経路: IAuxiliaryWindowService.open()
// が `IAuxiliaryWindowOpenOptions.transparent` を通じて `window.open` の features 経由でネイティブ透過を
// 要求する。upstream に既存のオプションのため main プロセス側の追加パッチは不要)。
//
// renderer 側では applyHTML の trackAttributes(mainContainer, auxContainer, ['class']) により、
// aux window のコンテナ要素はメインウィンドウの class (`paradis-transparent` を含む) を自動でミラーする。
// そのためクラス付与そのものは不要で、ここで必要なのは (1) ウィンドウを開くかどうかの事前判定と
// (2) 別 document のため伝播しないインラインの `--paradis-transparency-opacity` を aux コンテナへ
// 個別に設定することだけ。

import { isMacintosh } from '../../../../base/common/platform.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { clampParadisTransparencyOpacity, PARADIS_TRANSPARENCY_OPACITY_KEY, PARADIS_TRANSPARENT_CLASS } from '../common/paradisTransparency.js';

const OPACITY_CUSTOM_PROPERTY = '--paradis-transparency-opacity';

/**
 * この aux window をネイティブ透過で開くべきか。
 *
 * メインウィンドウの実透過状態 (`.monaco-workbench.paradis-transparent`) を唯一の真実として参照する
 * (fork内の既存前例: paradisTerminalTransparency.ts の isParadisTransparentActive と同じ考え方。
 * aux window は同一 renderer プロセスの別 BrowserWindow で、環境設定 (`environmentService.window.*`) は
 * 常にメインウィンドウのものを指すため使えない)。
 *
 * この aux window (Agent Live Window) は `nativeTitlebar: true` でネイティブタイトルバーを要求して
 * 開かれる。`transparent: true` と組み合わせられるのは macOS だけ (透過にすると信号ボタンの背後の
 * 帯だけ hidden タイトルバーへ切り替え、信号ボタン自体は macOS が引き続き描画するので DOM 側の
 * 帯を透過対応 CSS で塗れる — paradisAgentLiveWindowService.ts 参照)。それ以外の OS では有効化しない:
 * - Windows は `transparent: true` にフレームレス (frame: false) が前提で、ネイティブタイトルバーとは
 *   そもそも両立しない。
 * - Linux は hidden タイトルバーにすると `frame: false` になり OS のウィンドウ枠ごと消えるが、この
 *   ウィンドウは (メインウィンドウと違い) 閉じる/最小化/最大化を自前描画する custom titlebar を
 *   持たないため、置き換えの手段が無いままウィンドウ操作ボタンが丸ごと失われる。
 */
export function paradisIsAuxiliaryWindowTransparencyActive(layoutService: IWorkbenchLayoutService): boolean {
	if (!isMacintosh) {
		return false;
	}
	return layoutService.mainContainer.classList.contains(PARADIS_TRANSPARENT_CLASS);
}

/**
 * aux window のコンテナへ `--paradis-transparency-opacity` を設定し、以後のスライダー変更にも
 * 追随させる。呼び出し側は返り値の disposable を、その aux window のライフサイクル (閉じたとき) に
 * 合わせて破棄すること。
 */
export function paradisApplyAuxiliaryWindowTransparency(container: HTMLElement, configurationService: IConfigurationService): IDisposable {
	const store = new DisposableStore();
	const sync = () => {
		const opacity = clampParadisTransparencyOpacity(configurationService.getValue<number>(PARADIS_TRANSPARENCY_OPACITY_KEY));
		container.style.setProperty(OPACITY_CUSTOM_PROPERTY, `${Math.round(opacity * 100)}%`);
	};
	sync();
	store.add(configurationService.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(PARADIS_TRANSPARENCY_OPACITY_KEY)) {
			sync();
		}
	}));
	store.add({ dispose: () => container.style.removeProperty(OPACITY_CUSTOM_PROPERTY) });
	return store;
}
