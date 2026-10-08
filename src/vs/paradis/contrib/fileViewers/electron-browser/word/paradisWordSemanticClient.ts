/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process の Word 解析を呼ぶ。バイト列は VSBuffer のまま渡す（base64 にしない。
// IPC は VSBuffer をそのまま運べるので、変換の時間と一時的な倍のメモリを使わずに済む）。

import { VSBuffer } from '../../../../../base/common/buffer.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { PARADIS_WORD_SEMANTIC_CHANNEL, type IParadisWordAnalysisResult, type IParadisWordComparisonResult } from '../../common/word/paradisWordSemanticSummary.js';

export function analyzeParadisWordDocument(sharedProcessService: ISharedProcessService, bytes: Uint8Array, token: CancellationToken): Promise<IParadisWordAnalysisResult> {
	return sharedProcessService.getChannel(PARADIS_WORD_SEMANTIC_CHANNEL).call<IParadisWordAnalysisResult>('analyze', [VSBuffer.wrap(bytes)], token);
}

export function compareParadisWordDocuments(sharedProcessService: ISharedProcessService, original: Uint8Array, modified: Uint8Array, token: CancellationToken): Promise<IParadisWordComparisonResult> {
	return sharedProcessService.getChannel(PARADIS_WORD_SEMANTIC_CHANNEL).call<IParadisWordComparisonResult>('compare', [VSBuffer.wrap(original), VSBuffer.wrap(modified)], token);
}
