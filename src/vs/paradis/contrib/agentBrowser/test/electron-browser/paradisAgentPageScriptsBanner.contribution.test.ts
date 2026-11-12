/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextViewDelegate, IContextViewService, IOpenContextView } from '../../../../../platform/contextview/browser/contextView.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IBrowserViewModel } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor } from '../../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IParadisPaneTokenService } from '../../browser/paradisPaneTokenService.js';
import { IParadisAgentPageScriptEntry, IParadisAgentPageScriptsChange } from '../../common/paradisAgentBrowser.js';
import { ParadisAgentPageScriptsBanner } from '../../electron-browser/paradisAgentPageScriptsBanner.contribution.js';

/** Shows one context view at a time inside `element`, closing the previous one first like the real service does. */
class TestContextViewService {
	readonly element = document.createElement('div');
	private current: { readonly delegate: IContextViewDelegate; readonly container: HTMLElement; readonly rendered: IDisposable | undefined } | undefined;

	showContextView(delegate: IContextViewDelegate): IOpenContextView {
		this.hide();
		const container = document.createElement('div');
		this.element.appendChild(container);
		const entry = { delegate, container, rendered: delegate.render(container) };
		this.current = entry;
		return {
			close: () => {
				if (this.current === entry) {
					this.hide();
				}
			}
		};
	}

	getContextViewElement(): HTMLElement {
		return this.element;
	}

	private hide(): void {
		const current = this.current;
		if (!current) {
			return;
		}
		this.current = undefined;
		current.rendered?.dispose();
		current.container.remove();
		current.delegate.onHide?.();
	}
}

function entry(id: string): IParadisAgentPageScriptEntry {
	return { id, label: `script ${id}`, named: true, chars: 10, lines: 1, addedAt: 0, preview: '', sourceKept: true };
}

suite('ParadisAgentPageScriptsBanner', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('moves the focus into the list it opens, keeps it on the same button when a script is added, and closes on Esc from the chip', async () => {
		const root = document.createElement('div');
		document.body.appendChild(root);
		const scriptChanges = store.add(new Emitter<IParadisAgentPageScriptsChange>());
		const modelChanges = store.add(new Emitter<{ model: IBrowserViewModel | undefined; isNew: boolean }>());
		const model = upcastPartial<IBrowserViewModel>({ id: 'view-one' });
		let entries = [entry('s1')];
		const channel = upcastPartial<IChannel>({
			call: async <T>(command: string) => (command === 'listInitScripts' ? entries : 0) as T,
			listen: <T>(event: string) => (event === 'onDidChangeInitScripts' ? scriptChanges.event : Event.None) as Event<T>,
		});
		const contextViewService = new TestContextViewService();
		root.appendChild(contextViewService.element);
		const banner = store.add(new ParadisAgentPageScriptsBanner(
			upcastPartial<BrowserEditor>({ onDidChangeModel: modelChanges.event, model }),
			upcastPartial<IMainProcessService>({ getChannel: () => channel }),
			new NullLogService(),
			upcastPartial<IContextViewService>(contextViewService),
			upcastPartial<IEditorService>({}),
			upcastPartial<IParadisPaneTokenService>({ listPaneTokens: () => [] }),
			NullHoverService,
			upcastPartial<INotificationService>({}),
		));
		const chip = banner.widgets[0].element;
		root.appendChild(chip);
		try {
			modelChanges.fire({ model, isNew: true });
			await timeout(0);
			chip.click();
			const popover = root.querySelector<HTMLElement>('.paradis-page-scripts-details');
			const focusedOnOpen = document.activeElement === popover;

			root.querySelector<HTMLElement>('[data-paradis-focus-key="s1:remove"]')!.focus();
			// The agent adds a script while the list is open
			entries = [entry('s1'), entry('s2')];
			scriptChanges.fire({ viewId: 'view-one', count: 2 });
			await timeout(0);
			const removeButton = root.querySelector<HTMLElement>('[data-paradis-focus-key="s1:remove"]');
			const focusAfterRedraw = document.activeElement === removeButton && root.querySelectorAll('.paradis-page-scripts-details-row').length;

			chip.focus();
			chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
			const openAfterEscape = root.querySelector('.paradis-page-scripts-details') !== null;

			assert.deepStrictEqual({ focusedOnOpen, focusAfterRedraw, openAfterEscape }, { focusedOnOpen: true, focusAfterRedraw: 2, openAfterEscape: false });
		} finally {
			root.remove();
		}
	});
});
