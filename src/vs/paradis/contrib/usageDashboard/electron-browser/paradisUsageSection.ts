/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量ダッシュボード (ccusage / GitHub API / rtk) の各パネルが満たす共通の形。
//
// もともと3機能はそれぞれ独立した EditorPane (タブ) だったが、統合ダイアログからも
// 同じ中身を出せるよう、描画本体を EditorPane から切り離してこのインターフェースに
// 合わせた「セクション」クラスへ移した。EditorPane 側はセクションを1つ内包するだけの
// 薄いラッパになっていて、両方の入口が同じコードを通る。
//
// ホスト (タブ / ダイアログ) が違っても扱いを変えなくて済むよう、幅と可視状態は
// ホストから明示的に渡す。EditorPane の layout()/setEditorVisible() や、ダイアログの
// ResizeObserver / タブ切り替えがそれぞれの経路でここへ流し込む。

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
