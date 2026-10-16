/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { timeout } from '../../../base/common/async.js';

/** How long to wait before looking for a webview frame a second time. */
const PARADIS_WEBVIEW_FRAME_RETRY_MS = 100;

/**
 * Finds the frame of a webview for a find request, looking once more after a short wait when it is
 * not there yet (the frame can be replaced while the webview reloads, and an auxiliary window can
 * briefly resolve to the wrong window).
 *
 * A frame that is still missing is not the same as an Electron build without `findInFrame`: only that
 * find fails, so callers report it apart from the missing API (see `IWebviewManagerService.findInFrame`).
 */
export async function paradisFindWebviewFrame<T>(lookup: () => T | undefined, retryMs = PARADIS_WEBVIEW_FRAME_RETRY_MS): Promise<T | undefined> {
	const frame = lookup();
	if (frame !== undefined) {
		return frame;
	}
	await timeout(retryMs);
	return lookup();
}
