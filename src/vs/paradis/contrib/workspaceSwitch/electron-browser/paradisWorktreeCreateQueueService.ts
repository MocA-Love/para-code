/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 作成キューのサービスの識別子と形だけを置く。実体（paradisWorktreeCreateQueue.ts）は作成の流れ
// （paradisWorktreeHeadlessCreate.ts）を読み、そちらはダイアログ（paradisCreateWorktreeDialog.ts）を読むので、
// ダイアログが実体のファイルから識別子を読むと 3 つのファイルが循環する。ダイアログはここから読む。

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { IParadisHeadlessWorktreeRequest } from './paradisWorktreeHeadlessCreate.js';

export const IParadisWorktreeCreateQueueService = createDecorator<IParadisWorktreeCreateQueueService>('paradisWorktreeCreateQueueService');

/** バックグラウンド作成キュー。enqueue は即座に戻り、進行状況は通知/ステータスバー/ビューに出る。 */
export interface IParadisWorktreeCreateQueueService {
	readonly _serviceBrand: undefined;
	enqueue(request: IParadisHeadlessWorktreeRequest): void;
}
