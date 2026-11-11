/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの色の役目（段 0、Q596）。部品の CSS は本家の色のキーを直接読まず、ここの役目の名前（CSS では
// `--vscode-paradis-*`）だけを読む。既定値はどれも本家のキーから作るので、テーマ（Houston・Light 2026 など）を
// 替えると元のキーが替わり、部品の CSS は変わらない。利用者の workbench.colorCustomizations もそのまま効く。
// 本家がキーの名前を変えたときは、ここの参照だけを付け替える。
//
// 色を足したら build/lib/stylelint/vscode-known-variables.json の "colors" にも `--vscode-paradis-*` を足す。

import { localize } from '../../nls.js';
import { ColorTransformType, registerColor } from '../../platform/theme/common/colorUtils.js';

// 面
registerColor('paradis.canvas', 'editor.background', localize('paradis.color.canvas', "Para Code の部品: 一番下の地（エディタの地）。"));
registerColor('paradis.surface', 'sideBar.background', localize('paradis.color.surface', "Para Code の部品: ペインやナビの面。"));
registerColor('paradis.raised', { op: ColorTransformType.Mix, color: 'editor.background', with: 'sideBar.background', ratio: 0.55 }, localize('paradis.color.raised', "Para Code の部品: カードの面。"));
registerColor('paradis.overlay', { op: ColorTransformType.Mix, color: 'sideBar.background', with: 'editorWidget.background', ratio: 0.3 }, localize('paradis.color.overlay', "Para Code の部品: ダイアログとパレットの面。"));
registerColor('paradis.popup', 'menu.background', localize('paradis.color.popup', "Para Code の部品: メニュー・ポップアップ・トーストの面。"));
registerColor('paradis.sunken', { op: ColorTransformType.Mix, color: 'editor.background', with: 'input.background', ratio: 0.3 }, localize('paradis.color.sunken', "Para Code の部品: 入力欄の中の面。"));
registerColor('paradis.fillHover', 'list.hoverBackground', localize('paradis.color.fillHover', "Para Code の部品: ポインタを重ねた行やボタンの塗り。"));
// 選んでいる地には、どの部品も textStrong（と textMuted）の文字を重ねる。本家の menu.selectionBackground は白い
// menu.selectionForeground と組む濃い青（Light Modern・Light+・Dark Modern）で、その上の textStrong は 1.0〜2.8:1 しか
// なかった。本家でも普通の文字色と組む list.inactiveSelectionBackground にする。hc の 2 つはこの色を持たない（hc-light は
// ポインタの塗りと同じ値）ので、本家の hc が選んだ印に使う contrastActiveBorder を薄くして塗る。
// Houston・Dark 2026・Light 2026 は、テーマの水色の薄い地を paradisDefaultSettings.contribution.ts で残す。
registerColor('paradis.fillSelected', {
	dark: 'list.inactiveSelectionBackground',
	light: 'list.inactiveSelectionBackground',
	hcDark: { op: ColorTransformType.Opacity, value: 'contrastActiveBorder', opacity: 0.3 },
	hcLight: { op: ColorTransformType.Opacity, value: 'contrastActiveBorder', opacity: 0.25 },
}, localize('paradis.color.fillSelected', "Para Code の部品: 選んでいる行の塗り。"));
registerColor('paradis.fillNeutral', 'button.secondaryBackground', localize('paradis.color.fillNeutral', "Para Code の部品: 副のボタンの塗り。"));
registerColor('paradis.scrim', '#00000080', localize('paradis.color.scrim', "Para Code の部品: モーダルの下の暗い幕。"));
// 見出しの帯。sideBarSectionHeader.background はサイドバーの地と同じ色にしているテーマが多く（Dark 2026・Light 2026・Dark Modern・
// Light Modern、Dark+ 系は透明）帯が見えないので、地に文字の色を少し混ぜて作る。Houston は見出しの面の色（#343841）を
// paradisDefaultSettings.contribution.ts のテーマごとの上書きで入れる。
registerColor('paradis.band', { op: ColorTransformType.Mix, color: 'sideBar.background', with: 'foreground', ratio: 0.07 }, localize('paradis.color.band', "Para Code の部品: 一覧の中の見出しの帯の面。"));

// 文字
registerColor('paradis.text', 'foreground', localize('paradis.color.text', "Para Code の部品: 本文の文字。"));
registerColor('paradis.textStrong', 'input.foreground', localize('paradis.color.textStrong', "Para Code の部品: 見出しと入力の文字。"));
registerColor('paradis.textMuted', 'descriptionForeground', localize('paradis.color.textMuted', "Para Code の部品: 補助の文字。"));
registerColor('paradis.textFaint', 'input.placeholderForeground', localize('paradis.color.textFaint', "Para Code の部品: ヒントやキーの薄い文字。"));

// 線
registerColor('paradis.lineSubtle', 'widget.border', localize('paradis.color.lineSubtle', "Para Code の部品: 面の境の線。"));
registerColor('paradis.line', 'input.border', localize('paradis.color.line', "Para Code の部品: 入力欄の枠。"));
registerColor('paradis.lineButton', 'button.secondaryBorder', localize('paradis.color.lineButton', "Para Code の部品: 副のボタンの枠。塗りの無いテーマでも副のボタンと素のボタンを見分けられるようにする。"));
registerColor('paradis.lineStrong', 'checkbox.border', localize('paradis.color.lineStrong', "Para Code の部品: ポインタを重ねたときやチェックの枠。"));
registerColor('paradis.guide', 'tree.indentGuidesStroke', localize('paradis.color.guide', "Para Code の部品: 一覧の入れ子の範囲を示す細い罫線。"));

// 意味の色
registerColor('paradis.accent', 'progressBar.background', localize('paradis.color.accent', "Para Code の部品: アクセント。"));
registerColor('paradis.primary', 'button.background', localize('paradis.color.primary', "Para Code の部品: 主のボタン。"));
registerColor('paradis.primaryHover', 'button.hoverBackground', localize('paradis.color.primaryHover', "Para Code の部品: ポインタを重ねた主のボタン。"));
registerColor('paradis.primaryForeground', 'button.foreground', localize('paradis.color.primaryForeground', "Para Code の部品: 主のボタンの文字。"));
// フォーカスの枠の色はこの 1 つだけを通す（paradisFocusRing.css）。色を替えるときは既定値のここだけを直す。
registerColor('paradis.focus', 'focusBorder', localize('paradis.color.focus', "Para Code の部品: キーボードのフォーカスの枠。"));
// 押しても出る灰色の枠（案 C）: 文字の入力欄・検索欄・リストの行。既定は本家の補助の文字の色で、Houston と Light 2026 の
// 正確な値（#7d8394・#8a8f99）は paradisDefaultSettings.contribution.ts のテーマごとの上書きで入れる。ハイコントラストは本家の枠のまま。
registerColor('paradis.focusSubtle', { dark: 'descriptionForeground', light: 'descriptionForeground', hcDark: 'focusBorder', hcLight: 'focusBorder' }, localize('paradis.color.focusSubtle', "Para Code の部品: 文字の入力欄・検索欄・リストの行のフォーカスの枠（マウスで押したときも出る）。"));
registerColor('paradis.danger', 'errorForeground', localize('paradis.color.danger', "Para Code の部品: 危険・失敗。"));
registerColor('paradis.warning', 'editorWarning.foreground', localize('paradis.color.warning', "Para Code の部品: 警告・要対応。"));
registerColor('paradis.success', 'testing.iconPassed', localize('paradis.color.success', "Para Code の部品: 成功。"));
