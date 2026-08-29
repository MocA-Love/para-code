/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IWebviewManagerService = createDecorator<IWebviewManagerService>('webviewManagerService');

export interface WebviewWebContentsId {
	readonly webContentsId: number;
}

export interface WebviewWindowId {
	readonly windowId: number;
}

export interface FindInFrameOptions {
	readonly forward?: boolean;
	readonly findNext?: boolean;
	readonly matchCase?: boolean;
}

export interface FoundInFrameResult {
	readonly requestId: number;
	readonly activeMatchOrdinal: number;
	readonly matches: number;
	readonly finalUpdate: boolean;
}

export interface IWebviewManagerService {
	_serviceBrand: unknown;

	readonly onFoundInFrame: Event<FoundInFrameResult>;

	setIgnoreMenuShortcuts(id: WebviewWebContentsId | WebviewWindowId, enabled: boolean): Promise<void>;

	// PARA-PATCH: report whether the find actually ran. `WebFrameMain.findInFrame` only exists in the
	// Electron build Microsoft ships; on stock Electron it is missing, so the call silently did nothing.
	// Returning the outcome lets ElectronWebviewElement fall back to the browser (window.find) path.
	findInFrame(windowId: WebviewWindowId, frameName: string, text: string, options: FindInFrameOptions): Promise<boolean>;

	// PARA-PATCH: same as findInFrame — report whether the stop actually ran.
	stopFindInFrame(windowId: WebviewWindowId, frameName: string, options: { keepSelection?: boolean }): Promise<boolean>;
}
