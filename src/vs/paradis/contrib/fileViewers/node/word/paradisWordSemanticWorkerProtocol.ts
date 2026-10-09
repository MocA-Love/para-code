/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process ⇔ Word 解析 worker の間でやり取りするメッセージの形。

import type { IParadisWordAnalysisResult, IParadisWordComparisonResult } from '../../common/word/paradisWordSemanticSummary.js';
import type { IParadisOfficeSemanticWorkerReply, ParadisOfficeSemanticWorkerMessage } from '../office/paradisOfficeSemanticWorkerQueue.js';

/** 1 件の依頼の中身（共通の待ち行列の `run` に載せる）。 */
export type ParadisWordSemanticWorkerRun =
	| { readonly op: 'analyze'; readonly bytes: Uint8Array }
	| { readonly op: 'compare'; readonly original: Uint8Array; readonly modified: Uint8Array };

export type ParadisWordSemanticWorkerResult = IParadisWordAnalysisResult | IParadisWordComparisonResult;

/** shared process → worker。 */
export type ParadisWordSemanticWorkerRequest = ParadisOfficeSemanticWorkerMessage<ParadisWordSemanticWorkerRun>;

/** worker → shared process。 */
export type ParadisWordSemanticWorkerMessage = IParadisOfficeSemanticWorkerReply<ParadisWordSemanticWorkerResult>;
