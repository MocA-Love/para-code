/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { renderParadisViewerState } from '../../browser/paradisViewerState.js';
import { paradisViewerWebviewFailureHtml, paradisViewerWebviewFailureScript, paradisViewerWebviewStatusHtml } from '../../common/paradisViewerWebviewState.js';

suite('ParadisViewerState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('loading shows only the progress line and keeps the text for screen readers', () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		try {
			const state = renderParadisViewerState(container, 'loading', 'Loading');
			const status = container.querySelector<HTMLElement>('.paradis-viewer-state-status')!;
			const shown = {
				progress: !!container.querySelector('.paradis-viewer-state .monaco-progress-container'),
				status: [status.getAttribute('role'), status.textContent, status.getBoundingClientRect().width <= 1],
				icon: container.querySelector('.paradis-viewer-state-icon'),
			};
			state.dispose();
			deepStrictEqual({ shown, afterDispose: container.childElementCount }, {
				shown: { progress: true, status: ['status', 'Loading', true], icon: null },
				afterDispose: 0,
			});
		} finally {
			container.remove();
		}
	});

	test('a failure shows the icon, the label, the detail and a primary then secondary button', () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		try {
			const ran: string[] = [];
			const state = renderParadisViewerState(container, 'error', 'Cannot show the sheet.', [
				{ label: 'Retry', run: () => ran.push('retry') },
				{ label: 'Open in App', run: () => ran.push('open') },
			], 'More detail');
			const buttons = [...container.querySelectorAll<HTMLElement>('.paradis-viewer-state-buttons .monaco-button')];
			buttons.forEach(button => button.click());
			const shown = {
				role: container.querySelector('.paradis-viewer-state')?.getAttribute('role'),
				icon: !!container.querySelector('.paradis-viewer-state-icon .codicon-error'),
				label: container.querySelector('.paradis-viewer-state-label')?.textContent,
				detail: container.querySelector('.paradis-viewer-state-detail')?.textContent,
				buttons: buttons.map(button => [button.textContent, button.classList.contains('paradis-button-primary'), button.classList.contains('paradis-button-secondary')]),
				ran,
			};
			state.dispose();
			deepStrictEqual(shown, {
				role: 'alert',
				icon: true,
				label: 'Cannot show the sheet.',
				detail: 'More detail',
				buttons: [['Retry', true, false], ['Open in App', false, true]],
				ran: ['retry', 'open'],
			});
		} finally {
			container.remove();
		}
	});

	test('the webview states escape the message and fill the reason into the template', () => {
		const html = paradisViewerWebviewFailureHtml('<b>broken</b>');
		const script = paradisViewerWebviewFailureScript('Cannot show: {0}');
		deepStrictEqual({
			escaped: html.includes('&lt;b&gt;broken&lt;/b&gt;') && !html.includes('<b>broken'),
			loading: paradisViewerWebviewStatusHtml().startsWith('<div id="status" class="loading" role="status">'),
			template: script.includes('"Cannot show: {0}"') && script.includes(`replace('{0}', () => reason)`),
			scriptEscaped: !paradisViewerWebviewFailureScript('</script><b>{0}').includes('</script>'),
			doneRole: (() => {
				const container = mainWindow.document.createElement('div');
				const state = renderParadisViewerState(container, 'done', 'No changes');
				const role = container.querySelector('.paradis-viewer-state')?.getAttribute('role');
				state.dispose();
				return role;
			})(),
		}, { escaped: true, loading: true, template: true, scriptEscaped: true, doneRole: 'status' });
	});
});
