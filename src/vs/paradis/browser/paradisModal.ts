/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code のモーダルの箱の大きさの段（S・M・L）。各モーダルが自分の CSS に書いていた幅と高さを、この 3 段に寄せる。
//
// - S（確認・入力）: 幅 480（各モーダルが自分の CSS で 420〜560 の間に変えてよい）、高さは中身なり（上限 88vh）
// - M（文脈の作業）: 幅 880、高さ clamp(520px, 72vh, 820px) で固定（中の切り替えで高さを変えない）
// - L（領域を持つ画面）: 使用量の寸法。幅 clamp(1040px, 78vw, 2000px)、高さ clamp(726px, 88vh, 1400px)
//
// 箱の地・枠・角丸・影もここで揃える。背景の暗幕（backdrop）の見た目は各モーダルのまま。幕には必ず
// {@link PARADIS_MODAL_BACKDROP_CLASS} を付ける（重なりの段と、内蔵ブラウザの裏に隠れない印を兼ねる）。
//
// ## 重なりの段（z-index）の表（Q596・Q594、2026-11-09）
//
// fork の浮く部品の段は、本家の層の隙間にこの表の値だけで置く。値は media/paradisTokens.css の
// `--paradis-z-*` の 1 か所にあり、部品の CSS には 4 以上の数字を書かない（局所の重なりの 1〜3 だけ）。
//
// | 値 | 持ち主 | 中身 |
// |---|---|---|
// | 1〜3 | fork | 部品の中だけの重なり（固定の見出し・行のボタン）。面の外へは出さない |
// | 2500 | 本家 | タイトルバー |
// | 2540 | 本家 | モーダルのエディタ（設定エディタなど） |
// | 2542 `--paradis-z-modal` | fork | fork のモーダルの幕と箱（{@link PARADIS_MODAL_BACKDROP_CLASS}） |
// | 2543 `--paradis-z-modal-nested` | fork | 開いているモーダルの中から開く入れ子の箱（幕に `paradis-modal-backdrop-nested` も付ける） |
// | 2545 | 本家 | 通知のトーストと通知センター |
// | 2546 `--paradis-z-popover` | fork | まだコンテキストビューで出していない小窓（タイトルバーの小窓・内蔵ブラウザのツールバーの一覧・タブのランチャー・プリセットのまとめ・pty の小窓）。印は `paradis-overlay-popover` |
// | 2548 `--paradis-z-scrim` | fork | 予約: 中央のパレットの下の暗い幕（Q593） |
// | 2550 | 本家 | quick input（簡易のファイル選択もここ） |
// | 2575〜 | 本家 | 確認ダイアログ・コンテキストビュー（メニュー・プルダウンの一覧）。2575 + layer |
// | 2576 | 本家 | ホバー |
// | 100000 `--paradis-z-inspect` | fork | 画面全体の一時的な覆い（テーマの色の「画面から拾う」）。どの部品も枠で囲むので最上段。本家の screencast の覆いと同じ値 |
//
// fork のモーダルを本家の層より下に置くので、モーダルの中から開くメニュー・プルダウン・確認・quick input・ホバーは、
// 呼ぶ側で何もしなくても上に出る。`layer` を渡したり、開いている間だけ本家の層を持ち上げたりしない。
// 小窓はモーダルより上の段なので、fork のモーダルが開いたら閉じる（paradisAnchoredPopover.ts の paradisCloseWhenModalOpens）。

import './media/paradisModal.css';

/**
 * fork のモーダルの幕に必ず付ける印。重なりの段（`--paradis-z-modal`、paradisTokens.css）と、内蔵ブラウザの
 * ネイティブのビューがモーダルの前に出ないための印（overlayManager.ts の一覧に登録済み）を兼ねる。
 * 小窓はこの印の付いた要素が作業領域に入ったら閉じる。
 */
export const PARADIS_MODAL_BACKDROP_CLASS = 'paradis-modal-backdrop';

export const enum ParadisModalSize {
	Small = 's',
	Medium = 'm',
	Large = 'l',
}

/**
 * モーダルの箱に付けるクラス。`$('.my-dialog')` の要素に `classList.add(...paradisModalClasses(ParadisModalSize.Medium))` で付ける。
 * 箱は Esc を受けるためにだけフォーカスするので、箱そのものには枠を出さない（`paradis-focus-none`、paradisFocusRing.css）。
 */
export function paradisModalClasses(size: ParadisModalSize): readonly string[] {
	return ['paradis-modal', `paradis-modal-${size}`, 'paradis-focus-none'];
}
