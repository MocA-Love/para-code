/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { DomEmitter } from '../../../../base/browser/event.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';

/**
 * Para Code のウィンドウが表に出ているか（最小化されておらず、フォーカスが Para Code にある）。Workspaces ビューは
 * 表に出ていない間、差分の取り直しを止める。
 *
 * デスクトップではネイティブのウィンドウのフォーカスで決める実装（electron-browser の
 * paradisWorkspacesNativeWindowActivity.ts）がこの登録を上書きする。ここにあるのは Web 向けの実装。
 */
export const IParadisWorkspacesWindowActivity = createDecorator<IParadisWorkspacesWindowActivity>('paradisWorkspacesWindowActivity');

export interface IParadisWorkspacesWindowActivity {
	readonly _serviceBrand: undefined;
	readonly isActive: boolean;
	readonly onDidChange: Event<void>;
}

/** ウィンドウの document の見え方だけを読む最小の形（テストで差し替える）。 */
export interface IParadisWindowVisibility {
	readonly hidden: boolean;
	readonly onDidChange: Event<unknown>;
}

type ParadisWindowActivityHost = Pick<IHostService, 'hasFocus' | 'onDidChangeFocus'>;

/** Web 向けの判定。document が見えていて、`IHostService.hasFocus` が true なら表に出ているとみなす。 */
export class ParadisWorkspacesWindowActivity extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private active: boolean;

	constructor(
		private readonly hostService: ParadisWindowActivityHost,
		private readonly visibility: IParadisWindowVisibility,
	) {
		super();
		this.active = this.compute();
		this._register(hostService.onDidChangeFocus(() => this.update()));
		this._register(visibility.onDidChange(() => this.update()));
	}

	get isActive(): boolean {
		return this.active;
	}

	private compute(): boolean {
		return !this.visibility.hidden && this.hostService.hasFocus;
	}

	private update(): void {
		const active = this.compute();
		if (this.active !== active) {
			this.active = active;
			this._onDidChange.fire();
		}
	}
}

class ParadisBrowserWorkspacesWindowActivityService extends ParadisWorkspacesWindowActivity implements IParadisWorkspacesWindowActivity {
	declare readonly _serviceBrand: undefined;

	constructor(@IHostService hostService: IHostService) {
		const visibilityChange = new DomEmitter(mainWindow.document, 'visibilitychange');
		super(hostService, {
			get hidden() { return mainWindow.document.hidden; },
			onDidChange: visibilityChange.event,
		});
		this._register(visibilityChange);
	}
}

registerSingleton(IParadisWorkspacesWindowActivity, ParadisBrowserWorkspacesWindowActivityService, InstantiationType.Delayed);
