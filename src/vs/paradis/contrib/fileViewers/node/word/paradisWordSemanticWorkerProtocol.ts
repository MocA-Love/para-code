/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process ⇔ Word 解析 worker の間でやり取りするメッセージの形。

import type { IParadisWordAnalysisResult, IParadisWordComparisonResult } from '../../common/word/paradisWordSemanticSummary.js';

export type ParadisWordSemanticWorkerRequest =
	| { readonly id: number; readonly op: 'analyze'; readonly bytes: Uint8Array }
	| { readonly id: number; readonly op: 'compare'; readonly original: Uint8Array; readonly modified: Uint8Array }
	| { readonly id: number; readonly op: 'cancel' };

export interface ParadisWordSemanticWorkerReply {
	readonly id: number;
	readonly result: IParadisWordAnalysisResult | IParadisWordComparisonResult;
}
