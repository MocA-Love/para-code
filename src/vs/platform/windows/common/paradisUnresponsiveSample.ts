/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// window が固まったときに upstream（windowImpl.ts の stopCollectingJScallStacks）が作る UnresponsiveSampleError に、
// そのスタックが何回取れたかを添える。エラー自体はスタックと window の ID しか持たないので、Sentry へ送る側
// （paradis/contrib/sentry/electron-main/paradisWindowHangReporter.ts）はここから読む。

/** 1 つのスタックの取れ方。 */
export interface IParadisUnresponsiveSample {
	/** このスタックが取れた回数。 */
	readonly samples: number;
	/** 固まっていた間に取るはずだった回数（取る期間 ÷ 間隔。既定は 15）。 */
	readonly expectedSamples: number;
	/** 固まった window の ID。 */
	readonly windowId: number;
}

const samples = new WeakMap<object, IParadisUnresponsiveSample>();

/** upstream が作ったエラーに、取れ方を添える（windowImpl.ts の PARA-PATCH から呼ぶ）。 */
export function markParadisUnresponsiveSample(error: object, samplesCount: number, expectedSamples: number, windowId: number): void {
	samples.set(error, { samples: samplesCount, expectedSamples, windowId });
}

/** 添えた取れ方。添えていなければ undefined。 */
export function getParadisUnresponsiveSample(error: unknown): IParadisUnresponsiveSample | undefined {
	return typeof error === 'object' && error !== null ? samples.get(error) : undefined;
}
