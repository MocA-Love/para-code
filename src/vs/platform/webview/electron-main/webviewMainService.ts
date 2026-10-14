/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WebContents, webContents, WebFrameMain } from 'electron';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { hasKey } from '../../../base/common/types.js';
import { FindInFrameOptions, FoundInFrameResult, IWebviewManagerService, WebviewWebContentsId, WebviewWindowId } from '../common/webviewManagerService.js';
import { WebviewProtocolProvider } from './webviewProtocolProvider.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { IFileService } from '../../files/common/files.js';

export class WebviewMainService extends Disposable implements IWebviewManagerService {

	declare readonly _serviceBrand: undefined;

	private readonly _onFoundInFrame = this._register(new Emitter<FoundInFrameResult>());
	public readonly onFoundInFrame = this._onFoundInFrame.event;

	constructor(
		@IFileService fileService: IFileService,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
	) {
		super();
		this._register(new WebviewProtocolProvider(fileService));
	}

	public async setIgnoreMenuShortcuts(id: WebviewWebContentsId | WebviewWindowId, enabled: boolean): Promise<void> {
		const contents = this.getWebContents(id);
		if (!contents.isDestroyed()) {
			contents.setIgnoreMenuShortcuts(enabled);
		}
	}

	private getWebContents(id: WebviewWebContentsId | WebviewWindowId): WebContents {
		let contents: WebContents | undefined;

		if (hasKey(id, { windowId: true })) {
			const { windowId } = id;
			const window = this.windowsMainService.getWindowById(windowId);
			if (!window?.win) {
				throw new Error(`Invalid windowId: ${windowId}`);
			}
			contents = window.win.webContents;
		} else {
			const { webContentsId } = id;
			contents = webContents.fromId(webContentsId);
			if (!contents) {
				throw new Error(`Invalid webContentsId: ${webContentsId}`);
			}
		}

		return contents;
	}

	// PARA-PATCH: returns `false` when this Electron build has no `findInFrame`, so the caller can
	// fall back to the browser find path instead of silently searching nothing.
	public async findInFrame(id: WebviewWebContentsId | WebviewWindowId, frameName: string, text: string, options: { findNext?: boolean; forward?: boolean }): Promise<boolean> {
		// PARA-PATCH: a missing frame (auxiliary windows resolve the wrong window id) means the find did
		// not run either, so report it like a missing API instead of rejecting into the void.
		const initialFrame = this.tryGetFrameByName(id, frameName);
		if (!initialFrame) {
			return false;
		}

		type WebFrameMainWithFindSupport = WebFrameMain & {
			findInFrame?(text: string, findOptions: FindInFrameOptions): void;
			on(event: 'found-in-frame', listener: Function): WebFrameMain;
			removeListener(event: 'found-in-frame', listener: Function): WebFrameMain;
		};
		const frame = initialFrame as unknown as WebFrameMainWithFindSupport;
		if (typeof frame.findInFrame === 'function') {
			frame.findInFrame(text, {
				findNext: options.findNext,
				forward: options.forward,
			});
			const foundInFrameHandler = (_: unknown, result: FoundInFrameResult) => {
				if (result.finalUpdate) {
					this._onFoundInFrame.fire(result);
					frame.removeListener('found-in-frame', foundInFrameHandler);
				}
			};
			frame.on('found-in-frame', foundInFrameHandler);
			return true;
		}
		return false;
	}

	// PARA-PATCH: see findInFrame — report whether this Electron build could stop the find.
	public async stopFindInFrame(id: WebviewWebContentsId | WebviewWindowId, frameName: string, options: { keepSelection?: boolean }): Promise<boolean> {
		// PARA-PATCH: see findInFrame.
		const initialFrame = this.tryGetFrameByName(id, frameName);
		if (!initialFrame) {
			return false;
		}

		type WebFrameMainWithFindSupport = WebFrameMain & {
			stopFindInFrame?(stopOption: 'keepSelection' | 'clearSelection'): void;
		};

		const frame = initialFrame as unknown as WebFrameMainWithFindSupport;
		if (typeof frame.stopFindInFrame === 'function') {
			frame.stopFindInFrame(options.keepSelection ? 'keepSelection' : 'clearSelection');
			return true;
		}
		return false;
	}

	// PARA-PATCH: non-throwing variant used by the find calls above.
	private tryGetFrameByName(id: WebviewWebContentsId | WebviewWindowId, frameName: string): WebFrameMain | undefined {
		try {
			return this.getFrameByName(id, frameName);
		} catch {
			return undefined;
		}
	}

	private getFrameByName(id: WebviewWebContentsId | WebviewWindowId, frameName: string): WebFrameMain {
		const frame = this.getWebContents(id).mainFrame.framesInSubtree.find(frame => {
			return frame.name === frameName;
		});
		if (!frame) {
			throw new Error(`Unknown frame: ${frameName}`);
		}
		return frame;
	}
}
