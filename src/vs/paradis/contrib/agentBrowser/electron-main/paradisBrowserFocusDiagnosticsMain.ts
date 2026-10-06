/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのフォーカス診断の main 側の配線。判定は common/paradisBrowserFocusDiagnostics.ts。
// ここは BrowserView・ウィンドウのイベントを拾って記録係へ渡し、記録係の出力を Sentry へ流すだけ。

import * as electron from 'electron';
import type { BrowserView } from '../../../../platform/browserView/electron-main/browserView.js';
import type { IBrowserViewMainService } from '../../../../platform/browserView/electron-main/browserViewMainService.js';
import { paraSetBrowserViewFocusRequestListener } from '../../../../platform/browserView/electron-main/paraBrowserViewFocusRequest.js';
import { addParadisDiagnosticBreadcrumb, captureParadisDiagnosticMessage } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisBrowserDiagnosticsSink, ParadisBrowserDiagnosticsRecorder, paradisBrowserDiagnosticHost } from '../common/paradisBrowserFocusDiagnostics.js';

/** 利用者のポインタ操作として数える input-event の種類。マウスの移動は数えない。 */
const POINTER_DOWN_TYPES: ReadonlySet<string> = new Set(['mouseDown', 'pointerDown', 'touchStart', 'gestureTapDown']);

const sentrySink: IParadisBrowserDiagnosticsSink = {
	breadcrumb: (category, message, data) => addParadisDiagnosticBreadcrumb(category, message, data),
	capture: (operation, tags, data) => captureParadisDiagnosticMessage(
		'agent-browser',
		operation,
		tags,
		{ name: operation === 'refocus-after-leave' ? 'para.browser_focus' : 'para.browser_input', data },
		'warning',
	),
};

/** ビューの URL をホスト名へ畳む。読めなければ `none`。 */
export function paradisBrowserViewDiagnosticHost(view: BrowserView): string {
	try {
		return view.webContents.isDestroyed() ? 'none' : paradisBrowserDiagnosticHost(view.webContents.getURL());
	} catch {
		return 'none';
	}
}

/**
 * main に 1 つ。ParadisCdpTargetService が持ち、エージェントの入力の印もここへ渡す。
 */
export class ParadisBrowserFocusDiagnosticsMain {

	readonly recorder: ParadisBrowserDiagnosticsRecorder;
	private readonly attachedWindows = new WeakSet<electron.BrowserWindow>();

	constructor(
		private readonly browserViewMainService: IBrowserViewMainService,
		sink: IParadisBrowserDiagnosticsSink = sentrySink,
	) {
		this.recorder = new ParadisBrowserDiagnosticsRecorder(sink);
		paraSetBrowserViewFocusRequestListener((view, origin) => this.recorder.noteFocusRequest(view, origin));
		browserViewMainService.onDidCreateBrowserView(event => this.attachView(event.info.id));
		try {
			for (const window of electron.BrowserWindow.getAllWindows()) {
				this.attachWindow(window);
			}
			electron.app.on('browser-window-created', (_event, window) => this.attachWindow(window));
		} catch {
			// ウィンドウを拾えなくても、フォーカスの出どころが少し粗くなるだけ。
		}
	}

	private attachView(viewId: string): void {
		let view: BrowserView | undefined;
		try {
			view = this.browserViewMainService.tryGetBrowserView(viewId);
		} catch {
			return;
		}
		if (!view || view.webContents.isDestroyed()) {
			return;
		}
		const target = view;
		const webContents = target.webContents;
		const onInput = (_event: unknown, input: { readonly type: string }) => {
			if (POINTER_DOWN_TYPES.has(input.type)) {
				this.recorder.notePointer(target);
			}
		};
		webContents.on('input-event', onInput);
		const focusListener = target.onDidChangeFocus(({ focused }) => {
			this.recorder.focusChanged(target, focused, paradisBrowserViewDiagnosticHost(target));
		});
		const closeListener = target.onDidClose(() => {
			focusListener.dispose();
			closeListener.dispose();
			try {
				webContents.off('input-event', onInput);
			} catch {
				// 既に破棄済み。
			}
			this.recorder.viewClosed(target);
		});
	}

	private attachWindow(window: electron.BrowserWindow): void {
		if (this.attachedWindows.has(window) || window.isDestroyed()) {
			return;
		}
		this.attachedWindows.add(window);
		const webContents = window.webContents;
		const onInput = (_event: unknown, input: { readonly type: string }) => {
			if (POINTER_DOWN_TYPES.has(input.type)) {
				this.recorder.notePointer(undefined);
			}
		};
		const onFocus = () => this.recorder.noteWindowActivation();
		webContents.on('input-event', onInput);
		window.on('focus', onFocus);
		window.once('closed', () => {
			try {
				webContents.off('input-event', onInput);
			} catch {
				// 既に破棄済み。
			}
		});
	}
}

/**
 * 本物の BrowserViewMainService のときだけ作る（テストの偽物には `onDidCreateBrowserView` が無い）。
 */
export function paradisCreateBrowserFocusDiagnostics(browserViewMainService: IBrowserViewMainService): ParadisBrowserFocusDiagnosticsMain | undefined {
	if (typeof (browserViewMainService as Partial<IBrowserViewMainService>).onDidCreateBrowserView !== 'function') {
		return undefined;
	}
	try {
		return new ParadisBrowserFocusDiagnosticsMain(browserViewMainService);
	} catch {
		return undefined;
	}
}
