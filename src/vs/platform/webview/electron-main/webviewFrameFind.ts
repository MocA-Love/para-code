/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { FindInFrameOptions, FoundInFrameResult } from '../common/webviewManagerService.js';

export interface IWebviewFindFrame {
	findInFrame?(text: string, options: FindInFrameOptions): void;
	stopFindInFrame?(option: 'keepSelection' | 'clearSelection'): void;
	on(event: 'found-in-frame', listener: (event: unknown, result: FoundInFrameResult) => void): IWebviewFindFrame;
	removeListener(event: 'found-in-frame', listener: (event: unknown, result: FoundInFrameResult) => void): IWebviewFindFrame;
}

/** Runs the optional Electron frame API and forwards only its terminal result. */
export function findInWebviewFrame(
	frame: IWebviewFindFrame | undefined,
	text: string,
	options: FindInFrameOptions,
	onFinalResult: (result: FoundInFrameResult) => void,
): boolean {
	if (typeof frame?.findInFrame !== 'function') {
		return false;
	}
	frame.findInFrame(text, options);
	const foundInFrameHandler = (_: unknown, result: FoundInFrameResult) => {
		if (result.finalUpdate) {
			onFinalResult(result);
			frame.removeListener('found-in-frame', foundInFrameHandler);
		}
	};
	frame.on('found-in-frame', foundInFrameHandler);
	return true;
}

/** Stops Electron frame find when the running Electron version exposes that API. */
export function stopFindInWebviewFrame(frame: IWebviewFindFrame | undefined, keepSelection: boolean | undefined): boolean {
	if (typeof frame?.stopFindInFrame !== 'function') {
		return false;
	}
	frame.stopFindInFrame(keepSelection ? 'keepSelection' : 'clearSelection');
	return true;
}
