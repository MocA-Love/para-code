/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量の領域（paradisUsageArea.ts）の各パネルが満たす共通の形。
//
// もともと各機能はそれぞれ独立した EditorPane (タブ) だった。描画本体を EditorPane から切り離してこの
// インターフェースに合わせた「セクション」クラスへ移し、いまは統合のモーダルの使用量の領域だけが包む。
// 幅と可視状態はホスト（領域）から明示的に渡す。

import { IDisposable } from '../../../../base/common/lifecycle.js';

export interface IParadisUsageSection extends IDisposable {
	/** このセクションの中身全体。ホストは任意の親へ挿すだけでよい。 */
	readonly element: HTMLElement;
	/**
	 * データを取り直して描き直す。`bypassCache` はクライアント側のキャッシュを
	 * 無視して取得元まで問い合わせる (更新ボタン用)。
	 */
	refresh(bypassCache?: boolean): Promise<void>;
	/**
	 * 使える幅が変わったことを伝える。SVG チャートは幅を実測できない場所でも
	 * 描けるよう、ここで渡された値を使って組み立てる。
	 */
	layout(width: number): void;
	/**
	 * 見えているかどうかを伝える。隠れている間はポーリングや warm lease を止める
	 * (見えていないパネルのために CLI を回し続けない)。
	 */
	setVisible(visible: boolean): void;
}
