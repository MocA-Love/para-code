/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スリープ防止の blocker を、掛けたウィンドウに紐付けて main で持つ（common/paradisKeepAwakeBlockers.ts）。
// app.ts の PARA-PATCH から1回だけ呼ばれる。ウィンドウが読み込み直す（再読み込み・renderer が落ちた後の
// 開き直し・別のフォルダを開く）か閉じたら、そのウィンドウが掛けていた blocker を止める。

import { powerSaveBlocker } from 'electron';
import { Event } from '../../../../base/common/event.js';
import { DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ICodeWindow } from '../../../../platform/window/electron-main/window.js';
import { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';
import { PARADIS_KEEP_AWAKE_CHANNEL, ParadisKeepAwakeBlockerRegistry, paradisIsPowerSaveBlockerType } from '../common/paradisKeepAwakeBlockers.js';

export interface IParadisKeepAwakeChannelHost {
	registerChannel(channelName: string, channel: IServerChannel<string>): void;
}

class ParadisKeepAwakeChannel implements IServerChannel<string> {

	constructor(private readonly registry: ParadisKeepAwakeBlockerRegistry) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(ctx: string, command: string, arg?: unknown): Promise<T> {
		const value = Array.isArray(arg) ? arg[0] : undefined;
		switch (command) {
			case 'start':
				if (!paradisIsPowerSaveBlockerType(value)) {
					throw new Error('Invalid power save blocker type');
				}
				return this.registry.start(ctx, value) as T;
			case 'stop':
				return (typeof value === 'number' && this.registry.stop(ctx, value)) as T;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}

/** チャネルを開き、ウィンドウの読み込み直しと閉じるのを見張る。 */
export function paradisRegisterKeepAwake(channelHost: IParadisKeepAwakeChannelHost, windowsMainService: IWindowsMainService): IDisposable {
	const store = new DisposableStore();
	const registry = new ParadisKeepAwakeBlockerRegistry(powerSaveBlocker);
	channelHost.registerChannel(PARADIS_KEEP_AWAKE_CHANNEL, new ParadisKeepAwakeChannel(registry));

	const windowListeners = store.add(new DisposableMap<number>());
	const track = (window: ICodeWindow) => {
		if (windowListeners.has(window.id)) {
			return;
		}
		// renderer の IPC の ctx（vs/platform/ipc/electron-browser/mainProcessService.ts）
		const owner = `window:${window.id}`;
		const listeners = new DisposableStore();
		listeners.add(window.onWillLoad(() => registry.release(owner)));
		listeners.add(Event.any(window.onDidClose, window.onDidDestroy)(() => {
			registry.release(owner);
			windowListeners.deleteAndDispose(window.id);
		}));
		windowListeners.set(window.id, listeners);
	};
	for (const window of windowsMainService.getWindows()) {
		track(window);
	}
	store.add(windowsMainService.onDidOpenWindow(track));
	store.add(toDisposable(() => registry.releaseAll()));
	return store;
}
