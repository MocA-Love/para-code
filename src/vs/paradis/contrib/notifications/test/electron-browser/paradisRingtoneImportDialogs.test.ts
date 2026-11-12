/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IParadisYouTubeDownloadResult } from '../../common/paradisNotifications.js';
import { openParadisMyinstantsImportDialog } from '../../electron-browser/paradisMyinstantsImportDialog.js';
import { openParadisYouTubeImportDialog } from '../../electron-browser/paradisYouTubeImportDialog.js';
import { paradisOpenAnotherModal } from '../../../paradisSettings/test/browser/paradisModalTestUtils.js';

type CallHandler = (command: string, args: unknown[] | undefined) => Promise<unknown>;

function accessorFor(root: HTMLElement, handler: CallHandler): ServicesAccessor {
	const services = new Map<unknown, unknown>([
		[ILayoutService, upcastPartial<ILayoutService>({ activeContainer: root })],
		[ISharedProcessService, upcastPartial<ISharedProcessService>({
			getChannel: () => ({ call: (command: string, args?: unknown[]) => handler(command, args), listen: () => { throw new Error('not used'); } }) as never,
		})],
		[IOpenerService, upcastPartial<IOpenerService>({})],
	]);
	return upcastPartial<ServicesAccessor>({ get: (id => services.get(id)) as ServicesAccessor['get'] });
}

function pressEscape(target: HTMLElement): void {
	target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
}

function pressEnter(target: HTMLElement, composing: boolean): void {
	target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: composing ? 229 : 13, isComposing: composing, bubbles: true }));
}

const DOWNLOADED: IParadisYouTubeDownloadResult = { tempId: 'temp-1', info: { title: 'Video', thumbnailUrl: '', durationSeconds: 20 } };

suite('Paradis ringtone import dialogs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: HTMLElement;
	setup(() => {
		root = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(root);
	});
	teardown(() => {
		root.remove();
	});

	const footButton = (primary: boolean) => [...root.querySelectorAll<HTMLButtonElement>('.paradis-modal-foot button')].find(button => button.classList.contains('paradis-button-primary') === primary)!;

	test('YouTube: closing while the audio is still downloading removes the temp audio that arrives afterwards', async () => {
		const download = new DeferredPromise<IParadisYouTubeDownloadResult>();
		const cleaned: unknown[] = [];
		openParadisYouTubeImportDialog(accessorFor(root, async (command, args) => {
			switch (command) {
				case 'checkYtDlp': return { missing: [] };
				case 'downloadYouTubeAudio': return download.p;
				case 'cleanupTempAudio': cleaned.push(args?.[0]); return undefined;
			}
			return undefined;
		}), () => { });
		root.querySelector<HTMLInputElement>('.pns-field input')!.value = 'https://www.youtube.com/watch?v=abc';
		footButton(true).click();
		pressEscape(root.querySelector<HTMLElement>('.paradis-notif-nested-dialog')!);
		const closed = root.children.length === 0;
		download.complete(DOWNLOADED);
		await timeout(0);
		assert.deepStrictEqual({ closed, cleaned }, { closed: true, cleaned: ['temp-1'] });
	});

	test('YouTube: the box stays open while importing, and a forced close removes the source only after the import settles', async () => {
		const render = new DeferredPromise<unknown>();
		const cleaned: unknown[] = [];
		let imported = 0;
		openParadisYouTubeImportDialog(accessorFor(root, async (command, args) => {
			switch (command) {
				case 'checkYtDlp': return { missing: [] };
				case 'downloadYouTubeAudio': return DOWNLOADED;
				case 'readTempAudioFile': return null;
				case 'renderClip': return render.p;
				case 'cleanupTempAudio': cleaned.push(args?.[0]); return undefined;
			}
			return undefined;
		}), () => imported++);
		root.querySelector<HTMLInputElement>('.pns-field input')!.value = 'https://www.youtube.com/watch?v=abc';
		footButton(true).click();
		await timeout(0);
		footButton(true).click(); // import
		const dialog = root.querySelector<HTMLElement>('.paradis-notif-nested-dialog')!;
		pressEscape(dialog);
		root.querySelector<HTMLButtonElement>('.paradis-modal-head button')!.click();
		const backdrop = root.firstElementChild as HTMLElement;
		backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		footButton(false).click(); // cancel
		const openWhileImporting = root.children.length === 1;
		// Another modal closes every box in the window, including this one
		const other = paradisOpenAnotherModal();
		const cleanedBeforeSettled = [...cleaned];
		render.complete(undefined);
		await timeout(0);
		other.dispose();
		assert.deepStrictEqual({ openWhileImporting, closed: root.children.length === 0, cleanedBeforeSettled, cleaned, imported }, {
			openWhileImporting: true,
			closed: true,
			cleanedBeforeSettled: [],
			cleaned: ['temp-1'],
			imported: 1,
		});
	});

	test('YouTube and Myinstants: the Enter that commits a Japanese conversion does not load or save', async () => {
		const calls: string[] = [];
		const handler: CallHandler = async command => {
			calls.push(command);
			switch (command) {
				case 'checkYtDlp': return { missing: [] };
				case 'downloadYouTubeAudio': return new DeferredPromise<never>().p;
				case 'downloadMyinstantsAudio': return { ok: true, tempId: 'temp-2', fileName: 'a.mp3', sourceUrl: 'https://www.myinstants.com/media/sounds/a.mp3', sizeBytes: 10, suggestedName: 'a' };
				case 'getCustomRingtoneInfo': return null;
				case 'readTempAudioFile': return null;
				case 'importMyinstantsAudio': return undefined;
			}
			return undefined;
		};

		openParadisYouTubeImportDialog(accessorFor(root, handler), () => { });
		const youTubeUrl = root.querySelector<HTMLInputElement>('.pns-field input')!;
		youTubeUrl.value = 'https://www.youtube.com/watch?v=abc';
		pressEnter(youTubeUrl, true);
		const youTubeAfterComposing = calls.includes('downloadYouTubeAudio');
		pressEnter(youTubeUrl, false);
		const youTubeAfterEnter = calls.includes('downloadYouTubeAudio');
		pressEscape(root.querySelector<HTMLElement>('.paradis-notif-nested-dialog')!);

		calls.length = 0;
		openParadisMyinstantsImportDialog(accessorFor(root, handler), 50, () => { });
		const miUrl = root.querySelector<HTMLInputElement>('.pns-field input')!;
		miUrl.value = 'https://www.myinstants.com/media/sounds/a.mp3';
		pressEnter(miUrl, true);
		const myinstantsLoadAfterComposing = calls.includes('downloadMyinstantsAudio');
		pressEnter(miUrl, false);
		await timeout(0);
		const nameInput = [...root.querySelectorAll<HTMLInputElement>('.pns-field input')][1];
		pressEnter(nameInput, true);
		const myinstantsSaveAfterComposing = calls.includes('importMyinstantsAudio');
		pressEnter(nameInput, false);
		await timeout(0);
		const myinstantsSaveAfterEnter = calls.includes('importMyinstantsAudio');

		assert.deepStrictEqual({ youTubeAfterComposing, youTubeAfterEnter, myinstantsLoadAfterComposing, myinstantsSaveAfterComposing, myinstantsSaveAfterEnter, leftOpen: root.children.length }, {
			youTubeAfterComposing: false,
			youTubeAfterEnter: true,
			myinstantsLoadAfterComposing: false,
			myinstantsSaveAfterComposing: false,
			myinstantsSaveAfterEnter: true,
			leftOpen: 0,
		});
	});
});
