/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 起動したときの繋ぎ直しの結果を、Sentry の span の属性にする（送るのは
// `electron-browser/paradisReattachDiagnostics.contribution.ts`）。

import { IParadisReattachTally } from '../../../../platform/terminal/common/paradisReattachTally.js';
import { ParadisSpanAttributes } from '../../sentry/common/paradisSentryDiagnostics.js';

/**
 * 送る中身。送る価値が無ければ undefined（2 つ目以降のウィンドウで、起こし直しも無かったとき）。
 */
export function paradisReattachSpanAttributes(tally: IParadisReattachTally | undefined): ParadisSpanAttributes | undefined {
	if (!tally || (!tally.firstTake && tally.revived === 0)) {
		return undefined;
	}
	return {
		safe_first_take: tally.firstTake,
		safe_reachable: tally.reachable,
		safe_adopted: tally.adopted,
		safe_left_behind: tally.leftBehind,
		safe_revived: tally.revived,
		safe_revived_unclaimed: tally.revivedUnclaimed,
	};
}
