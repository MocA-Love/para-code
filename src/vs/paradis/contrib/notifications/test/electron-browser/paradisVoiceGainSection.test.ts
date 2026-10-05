/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Event } from '../../../../../base/common/event.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IParadisAivisSettings, IParadisNotificationsSettingsService } from '../../browser/paradisNotificationsSettings.js';
import { IParadisVoiceGainList, ParadisVoiceGainsResult } from '../../common/paradisVoiceGains.js';
import { paradisClearVoiceTuningCaches } from '../../electron-browser/paradisVoiceGainsCache.js';
import { ParadisVoiceGainSection } from '../../electron-browser/paradisVoiceGainSection.js';

async function flush(): Promise<void> {
	for (let index = 0; index < 30; index++) {
		await Promise.resolve();
	}
}

suite('Paradis voice gain section', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => paradisClearVoiceTuningCaches());
	teardown(() => paradisClearVoiceTuningCaches());

	function render(result: ParadisVoiceGainsResult<IParadisVoiceGainList>, calls: string[] = []): HTMLElement {
		const container = mainWindow.document.implementation.createHTMLDocument('gain section').createElement('div');
		const channel: IChannel = {
			call<T>(command: string, arg?: unknown): Promise<T> {
				calls.push(`${command} ${JSON.stringify(arg ?? null)}`);
				return Promise.resolve((command === 'list' ? result : { status: 'ok', value: true }) as T);
			},
			listen<T>(): Event<T> { return Event.None; },
		};
		const sharedProcess = { getChannel: () => channel } as unknown as ISharedProcessService;
		const settings = {
			getAivisSettings: () => ({ elevenLabsApiKey: '' }) as IParadisAivisSettings,
			getCustomAivisModelPresets: () => [],
		} as unknown as IParadisNotificationsSettingsService;
		const dialog = { confirm: async () => ({ confirmed: true }) } as unknown as IDialogService;
		const notifications = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as INotificationService;
		store.add(new ParadisVoiceGainSection(container, sharedProcess, settings, dialog, {} as IFileDialogService, notifications));
		return container;
	}

	function rows(container: HTMLElement): string[][] {
		return Array.from(container.querySelectorAll('tbody tr')).map(row => Array.from(row.querySelectorAll('td')).slice(0, 4).map(cell => cell.textContent ?? ''));
	}

	test('lists the rows with names, progress and the learning badge, and resets a row after confirming', async () => {
		const calls: string[] = [];
		const container = render({
			status: 'ok', value: {
				target: -20, learnWindow: 9, minLearnSeconds: 2.5, entries: [
					{ key: 'aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default', provider: 'aivis', voice: 'a670e6b8-0852-45b2-8704-1bc9862f2fe6', model: 'default', gainDb: 4.5, sampleCount: 9, updatedAt: 2 },
					{ key: 'elevenlabs:abcdefghijklmnop:eleven_v4_turbo', provider: 'elevenlabs', voice: 'abcdefghijklmnop', model: 'eleven_v4_turbo', gainDb: -11.7, sampleCount: 3, updatedAt: 1 },
					{ key: 'elevenlabs:initialvoice:eleven_v3', provider: 'elevenlabs', voice: 'initialvoice', model: 'eleven_v3', gainDb: -2, sampleCount: 0, updatedAt: undefined },
				],
			},
		}, calls);
		await flush();
		const listed = rows(container);
		const resetDisabled = Array.from(container.querySelectorAll<HTMLButtonElement>('tbody tr button')).map(button => button.disabled);
		container.querySelector<HTMLButtonElement>('tbody tr button')?.click();
		await flush();

		assert.deepStrictEqual({ listed, resetDisabled, calls }, {
			listed: [
				['花音 (Aivis)', '—', '+4.5 dB', '9/9'],
				['abcdefghij…', 'eleven_v4_turbo', '-11.7 dB', '3/9 学習中'],
				// 一度も測っていない行は「初期値」と出し、やり直しは押せない
				['initialvoi…', 'eleven_v3', '-2.0 dB', '初期値'],
			],
			resetDisabled: [false, false, true],
			calls: ['list null', 'reset ["aivis:a670e6b8-0852-45b2-8704-1bc9862f2fe6:default"]', 'list null'],
		});
	});

	test('asks for aivis-mcp 2.5.4 when the installed one is older', async () => {
		const container = render({ status: 'unsupported', version: '2.5.3' });
		await flush();
		assert.deepStrictEqual({
			message: container.querySelector('.pns-empty')?.textContent,
			table: container.querySelectorAll('table').length,
		}, {
			message: 'aivis-mcp 2.5.4 以上が要ります（この PC の aivis-mcp は 2.5.3 です）',
			table: 0,
		});
	});
});
