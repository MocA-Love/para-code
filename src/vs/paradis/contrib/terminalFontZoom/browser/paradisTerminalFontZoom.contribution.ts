/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルにフォーカスがあるときだけ ⌘= / ⌘− / ⌘0 をそのターミナル単体の文字サイズ変更にする（Q41 B / TM21）。
//
// - ターミナル以外にフォーカスがあるときは、今まで通りウィンドウ全体の拡大・縮小（workbench.action.zoomIn 等）。
//   キーバインドは `terminalFocus` 条件付きで weight を1つ上げ、そのときだけ優先させる。
// - 差分（px）はターミナルごとに持つ（terminalRenderer/browser/paradisTerminalFontZoom.ts）。
//   エディタエリアの各タブ・パネルの 2D グリッドの各ペインはそれぞれ別の xterm なので独立する。
// - リロード後も残すため、shell integration の nonce（リロードや pty の再接続を跨いで変わらない、
//   workspaceSwitch/browser/paradisTerminalEditorPark.ts と同じ同一性）をキーに WORKSPACE storage へ保存する。
//   ターミナルを閉じたら（アプリの終了・リロード中を除く）消す。

import { Dimension, getWindow } from '../../../../base/browser/dom.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { paradisTerminalIdentityNonce } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalConfigurationService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import type { XtermTerminal } from '../../../../workbench/contrib/terminal/browser/xterm/xtermTerminal.js';
import { DEFAULT_COMMANDS_TO_SKIP_SHELL } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { TerminalContextKeys } from '../../../../workbench/contrib/terminal/common/terminalContextKey.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { paradisGetTerminalFontZoom, paradisSetTerminalFontZoom, paradisZoomedFontSize } from '../../terminalRenderer/browser/paradisTerminalFontZoom.js';

export const enum ParadisTerminalFontZoomCommandId {
	ZoomIn = 'paradis.terminal.fontZoomIn',
	ZoomOut = 'paradis.terminal.fontZoomOut',
	ZoomReset = 'paradis.terminal.fontZoomReset',
}

const PARADIS_TERMINAL_FONT_ZOOM_STORAGE_KEY = 'paradis.terminal.fontZoom';
/** 保存する件数の上限。古いものから捨てる（閉じ損ねた記録が溜まり続けないように）。 */
const PARADIS_TERMINAL_FONT_ZOOM_MAX_ENTRIES = 200;

// ターミナルにフォーカスがあっても、キーをシェルへ送らずコマンドとして扱わせる。
// upstream の既定リストへ起動時に追記するだけで、terminal.ts は変更しない
// （TerminalConfigurationService はこの配列からスキップ集合を作る）。
for (const id of [ParadisTerminalFontZoomCommandId.ZoomIn, ParadisTerminalFontZoomCommandId.ZoomOut, ParadisTerminalFontZoomCommandId.ZoomReset]) {
	if (!DEFAULT_COMMANDS_TO_SKIP_SHELL.includes(id)) {
		DEFAULT_COMMANDS_TO_SKIP_SHELL.push(id);
	}
}

/**
 * 次の差分を求める。文字サイズが上限・下限に張り付いて変わらないときは今の差分のまま返す
 * （押し続けても差分だけが膨らみ、戻すときに何回も押す羽目にならないように）。
 */
export function paradisNextTerminalFontZoom(baseFontSize: number, current: number, step: 1 | -1 | 0): number {
	if (step === 0) {
		return 0;
	}
	const next = current + step;
	return paradisZoomedFontSize(baseFontSize, next) === paradisZoomedFontSize(baseFontSize, current) ? current : next;
}

/** nonce → 差分（px）の記録を storage の JSON として読み書きする。 */
export function paradisReadTerminalFontZoomMemory(raw: string | undefined): Map<string, number> {
	const result = new Map<string, number>();
	if (!raw) {
		return result;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (Array.isArray(entry) && entry.length === 2) {
					const nonce = paradisTerminalIdentityNonce(entry[0]);
					const delta = entry[1];
					if (nonce && typeof delta === 'number' && Number.isInteger(delta) && delta !== 0) {
						result.set(nonce, delta);
					}
				}
			}
		}
	} catch {
		// 壊れた記録は捨てて空から始める
	}
	return result;
}

/** 記録を更新して保存用の JSON を返す。空になったら undefined。 */
export function paradisUpdateTerminalFontZoomMemory(memory: Map<string, number>, nonce: string, delta: number): string | undefined {
	memory.delete(nonce);
	if (delta !== 0) {
		memory.set(nonce, delta);
	}
	while (memory.size > PARADIS_TERMINAL_FONT_ZOOM_MAX_ENTRIES) {
		const oldest = memory.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		memory.delete(oldest);
	}
	return memory.size ? JSON.stringify([...memory]) : undefined;
}

function rememberTerminalFontZoom(storageService: IStorageService, instance: ITerminalInstance, delta: number): void {
	const nonce = paradisTerminalIdentityNonce(instance.shellIntegrationNonce);
	if (!nonce) {
		return;
	}
	const memory = paradisReadTerminalFontZoomMemory(storageService.get(PARADIS_TERMINAL_FONT_ZOOM_STORAGE_KEY, StorageScope.WORKSPACE));
	if ((memory.get(nonce) ?? 0) === delta) {
		return;
	}
	const serialized = paradisUpdateTerminalFontZoomMemory(memory, nonce, delta);
	if (serialized === undefined) {
		storageService.remove(PARADIS_TERMINAL_FONT_ZOOM_STORAGE_KEY, StorageScope.WORKSPACE);
	} else {
		storageService.store(PARADIS_TERMINAL_FONT_ZOOM_STORAGE_KEY, serialized, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

/**
 * 差分を記録して、そのターミナルの文字サイズと行数・列数を今すぐ当て直す。
 * upstream の `_initDimensions` と同じく、ターミナルを入れている要素の大きさで列数・行数を計算し直させる。
 */
function applyTerminalFontZoom(instance: ITerminalInstance, xterm: XtermTerminal, delta: number): void {
	paradisSetTerminalFontZoom(xterm, delta);
	xterm.raw.options.fontSize = xterm.getFont().fontSize;
	const container = instance.domElement.parentElement;
	if (!container || !instance.isVisible) {
		return;
	}
	const style = getWindow(container).getComputedStyle(container);
	const width = parseInt(style.width);
	const height = parseInt(style.height);
	if (width > 0 && height > 0) {
		instance.layout(new Dimension(width, height));
	}
}

function focusedTerminal(terminalService: ITerminalService): ITerminalInstance | undefined {
	return terminalService.instances.find(instance => instance.hasFocus) ?? terminalService.activeInstance;
}

abstract class ParadisTerminalFontZoomAction extends Action2 {
	protected abstract readonly step: 1 | -1 | 0;

	override run(accessor: ServicesAccessor): void {
		const terminalService = accessor.get(ITerminalService);
		const storageService = accessor.get(IStorageService);
		const terminalConfigurationService = accessor.get(ITerminalConfigurationService);
		const instance = focusedTerminal(terminalService);
		const xterm = instance?.xterm;
		if (!instance || !xterm) {
			return;
		}
		const current = paradisGetTerminalFontZoom(xterm);
		const base = terminalConfigurationService.getFont(getWindow(instance.domElement), undefined, true).fontSize;
		const next = paradisNextTerminalFontZoom(base, current, this.step);
		if (next === current) {
			return;
		}
		applyTerminalFontZoom(instance, xterm, next);
		rememberTerminalFontZoom(storageService, instance, next);
	}
}

registerAction2(class extends ParadisTerminalFontZoomAction {
	protected readonly step = 1;
	constructor() {
		super({
			id: ParadisTerminalFontZoomCommandId.ZoomIn,
			title: localize2('paradis.terminal.fontZoomIn', "このターミナルの文字を大きくする"),
			f1: true,
			precondition: TerminalContextKeys.isOpen,
			keybinding: {
				when: TerminalContextKeys.focus,
				weight: KeybindingWeight.WorkbenchContrib + 1,
				primary: KeyMod.CtrlCmd | KeyCode.Equal,
				secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Equal, KeyMod.CtrlCmd | KeyCode.NumpadAdd],
			},
		});
	}
});

registerAction2(class extends ParadisTerminalFontZoomAction {
	protected readonly step = -1;
	constructor() {
		super({
			id: ParadisTerminalFontZoomCommandId.ZoomOut,
			title: localize2('paradis.terminal.fontZoomOut', "このターミナルの文字を小さくする"),
			f1: true,
			precondition: TerminalContextKeys.isOpen,
			keybinding: {
				when: TerminalContextKeys.focus,
				weight: KeybindingWeight.WorkbenchContrib + 1,
				primary: KeyMod.CtrlCmd | KeyCode.Minus,
				secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Minus, KeyMod.CtrlCmd | KeyCode.NumpadSubtract],
			},
		});
	}
});

registerAction2(class extends ParadisTerminalFontZoomAction {
	protected readonly step = 0;
	constructor() {
		super({
			id: ParadisTerminalFontZoomCommandId.ZoomReset,
			title: localize2('paradis.terminal.fontZoomReset', "このターミナルの文字サイズを元に戻す"),
			f1: true,
			precondition: TerminalContextKeys.isOpen,
			keybinding: {
				when: TerminalContextKeys.focus,
				weight: KeybindingWeight.WorkbenchContrib + 1,
				primary: KeyMod.CtrlCmd | KeyCode.Digit0,
				secondary: [KeyMod.CtrlCmd | KeyCode.Numpad0],
			},
		});
	}
});

/** リロード後に文字サイズの差分を戻し、閉じたターミナルの記録を消す。 */
class ParadisTerminalFontZoomRestoreContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'paradis.terminalFontZoom.restore';

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@IStorageService private readonly storageService: IStorageService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
	) {
		super();
		for (const instance of this.terminalService.instances) {
			this.restore(instance);
		}
		this._register(this.terminalService.onDidCreateInstance(instance => this.restore(instance)));
		this._register(this.terminalService.onDidDisposeInstance(instance => {
			// 終了・リロードで畳まれるターミナルは、次の起動で同じ nonce のまま戻ってくるので残す
			if (!this.lifecycleService.willShutdown) {
				rememberTerminalFontZoom(this.storageService, instance, 0);
			}
		}));
	}

	private async restore(instance: ITerminalInstance): Promise<void> {
		const nonce = paradisTerminalIdentityNonce(instance.shellIntegrationNonce);
		if (!nonce) {
			return;
		}
		const delta = paradisReadTerminalFontZoomMemory(this.storageService.get(PARADIS_TERMINAL_FONT_ZOOM_STORAGE_KEY, StorageScope.WORKSPACE)).get(nonce);
		if (!delta) {
			return;
		}
		const xterm = await instance.xtermReadyPromise;
		if (!xterm || instance.isDisposed || paradisGetTerminalFontZoom(xterm) !== 0) {
			return;
		}
		applyTerminalFontZoom(instance, xterm, delta);
	}
}

registerWorkbenchContribution2(ParadisTerminalFontZoomRestoreContribution.ID, ParadisTerminalFontZoomRestoreContribution, WorkbenchPhase.AfterRestored);
