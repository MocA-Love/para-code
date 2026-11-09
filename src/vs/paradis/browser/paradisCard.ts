/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// UI キットの段 4（Q600）のカードと表の見た目のクラス（CSS は media/paradisCard.css）。
//
// 包んでいる本家のファイル: 無し。表は本家の Table（tableWidget.ts）を使わない。使用量の「最近のセッション」は行を
// 押すと内訳の行が開く作りで、行の高さを決め打ちにする本家の Table の仮想化と合わないため。表は `<table>` のまま
// クラスだけを当てる。

import './media/paradisCard.css';

/** カード（中の面）。 */
export const PARADIS_CARD_CLASS = 'paradis-card';
/** カードの小さいラベル・大きい数・補足。 */
export const PARADIS_CARD_LABEL_CLASS = 'paradis-card-label';
export const PARADIS_CARD_VALUE_CLASS = 'paradis-card-value';
export const PARADIS_CARD_NOTE_CLASS = 'paradis-card-note';
/** 表（`<table>`）。数の列のセルには `num` を付ける。 */
export const PARADIS_TABLE_CLASS = 'paradis-table';
