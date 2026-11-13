/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextViewDelegate, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IPreferencesService } from '../../../../../workbench/services/preferences/common/preferences.js';
import { IParadisDialogService } from '../../../confirmDialog/browser/paradisDialogService.js';
import { IParadisPtyDaemonStatus, IParadisPtyDaemonStatusService } from '../../common/paradisPtyDaemonStatus.js';
import { PARADIS_LOCAL_DAEMON_SCOPE } from '../../common/paradisPtyDaemonScope.js';
import { ParadisPtyDaemonPopover } from '../../electron-browser/paradisPtyDaemonPopover.js';

const STATUS: IParadisPtyDaemonStatus = {
	enabled: true,
	running: true,
	pid: 100,
	buildId: 'abcdef1234567890',
	startedAt: Date.now(),
	terminalCount: 3,
	spaces: [{ name: 'para-code', count: 3 }],
	foreign: [],
};

suite('ParadisPtyDaemonPopover', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let workbench: HTMLElement;
	let container: HTMLElement;
	let anchor: HTMLElement;
	let outside: HTMLElement;

	setup(() => {
		workbench = mainWindow.document.createElement('div');
		workbench.className = 'monaco-workbench';
		mainWindow.document.body.appendChild(workbench);
		container = workbench.appendChild(mainWindow.document.createElement('div'));
		anchor = workbench.appendChild(mainWindow.document.createElement('button'));
		outside = workbench.appendChild(mainWindow.document.createElement('div'));
	});

	teardown(() => {
		workbench.remove();
	});

	/** 本家の ContextView と同じ順の偽物: onHide を呼んでから箱を隠し、描いたものを捨てる。 */
	function open(onClose: (popover: ParadisPtyDaemonPopover) => void): ParadisPtyDaemonPopover {
		let delegate: IContextViewDelegate | undefined;
		let rendered: { dispose(): void } | null = null;
		const contextViewService = {
			showContextView: (d: IContextViewDelegate) => {
				delegate = d;
				rendered = d.render(container);
				return { close: () => { } };
			},
			hideContextView: () => {
				delegate?.onHide?.();
				container.replaceChildren();
				rendered?.dispose();
				rendered = null;
			},
			layout: () => { },
		} as unknown as IContextViewService;
		const popover: ParadisPtyDaemonPopover = store.add(new ParadisPtyDaemonPopover(anchor, {
			status: STATUS,
			scope: PARADIS_LOCAL_DAEMON_SCOPE,
			service: {} as IParadisPtyDaemonStatusService,
			onClose: () => onClose(popover),
			onDidAct: () => { },
		}, contextViewService, {} as IParadisDialogService, {} as IPreferencesService, {} as INotificationService));
		return popover;
	}

	test('opens in the kit pop-up with kit buttons; pressing the status bar item does not close it, pressing outside does', () => {
		let closed = 0;
		open(popover => {
			closed++;
			popover.dispose();
		});
		const box = container.querySelector<HTMLElement>('.paradis-popover')!;
		const opened = {
			role: box.getAttribute('role'),
			label: box.getAttribute('aria-label'),
			head: box.querySelector('.paradis-popover-head')?.textContent,
			total: box.querySelector('.ppd-statusline .ppd-total')?.textContent,
			buttons: [...box.querySelectorAll('.paradis-button')].map(button => [button.textContent, button.classList.contains('paradis-button-small')]),
		};
		anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		const afterAnchor = closed;
		outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		assert.deepStrictEqual({ opened, afterAnchor, closed, removed: container.childElementCount }, {
			opened: {
				role: 'dialog',
				label: '常駐ターミナル',
				head: '常駐ターミナル',
				total: '3本',
				buttons: [['再起動', false], ['停止', false], ['設定', true]],
			},
			afterAnchor: 0,
			closed: 1,
			removed: 0,
		});
	});

	test('redrawing for a new uptime keeps the keyboard focus on the same button', () => {
		const popover = open(p => p.dispose());
		const buttonLabeled = (label: string) => [...container.querySelectorAll<HTMLElement>('.paradis-button')].find(button => button.textContent === label)!;
		buttonLabeled('停止').focus();
		// 稼働時間の文字列だけが変わる（描き直しが起きる）
		popover.update({ ...STATUS, startedAt: STATUS.startedAt! - 2 * 60 * 60 * 1000 });
		const focused = mainWindow.document.activeElement as HTMLElement | null;
		assert.deepStrictEqual({ focusedLabel: focused?.textContent, connected: focused?.isConnected }, {
			focusedLabel: '停止',
			connected: true,
		});
	});

	test('Escape closes it once and gives the focus back to the status bar item', () => {
		let closed = 0;
		open(popover => {
			closed++;
			popover.dispose();
		});
		const box = container.querySelector<HTMLElement>('.paradis-popover')!;
		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
		assert.deepStrictEqual({ closed, removed: container.childElementCount, focusBack: mainWindow.document.activeElement === anchor }, {
			closed: 1,
			removed: 0,
			focusBack: true,
		});
	});
});
