/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process の aivis ミュート実行チャネルを呼ぶだけの薄いクライアント。
// aivis はこのマシンに入っているツールなので、SSH 接続中でも常に shared process へ聞く。

import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisAivisMuteBridgeService, PARADIS_AIVIS_MUTE_BRIDGE_CHANNEL } from '../common/paradisAivisMuteBridge.js';

export class ParadisAivisMuteBridgeClient implements IParadisAivisMuteBridgeService {

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
	) { }

	async sync(enabled: boolean, remainingMs: number | undefined): Promise<void> {
		await this.sharedProcessService.getChannel(PARADIS_AIVIS_MUTE_BRIDGE_CHANNEL).call<void>('sync', [enabled, remainingMs]);
	}
}
