/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から、HTML プレビューを配るローカルサーバへフォルダーを載せるクライアントヘルパー。

import { URI } from '../../../../base/common/uri.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { PARADIS_HTML_PREVIEW_CHANNEL } from '../common/paradisHtmlPreview.js';

/**
 * `directory` をローカルサーバに載せ、その中身を指す base URL（末尾は `/`）を返す。
 * 同じフォルダーなら何度呼んでも同じ URL が返る。
 */
export function paradisMountHtmlPreviewDirectory(sharedProcessService: ISharedProcessService, directory: URI): Promise<string> {
	return sharedProcessService.getChannel(PARADIS_HTML_PREVIEW_CHANNEL).call<string>('mount', [directory.fsPath]);
}
