/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { PARADIS_BROWSER_VIEW_PROMPT_BEGIN_CHANNEL as MAIN_BEGIN_CHANNEL, PARADIS_BROWSER_VIEW_PROMPT_END_CHANNEL as MAIN_END_CHANNEL } from '../../common/paradisBrowserViewPrompt.js';

suite('preload-browserView: window.prompt()', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// The preload cannot import at runtime, so it carries its own copy of the channel names.
	test('the preload uses the channels the main process listens on, and anything but a string is null', async function () {
		if (process.versions.electron) {
			// the preload module initializes itself inside Electron
			this.skip();
		}
		const { PARADIS_BROWSER_VIEW_PROMPT_BEGIN_CHANNEL, PARADIS_BROWSER_VIEW_PROMPT_END_CHANNEL, paradisPromptStep } = await import('../../electron-browser/preload-browserView.js');
		assert.deepStrictEqual({
			channels: [PARADIS_BROWSER_VIEW_PROMPT_BEGIN_CHANNEL, PARADIS_BROWSER_VIEW_PROMPT_END_CHANNEL],
			answers: [paradisPromptStep(() => 'typed'), paradisPromptStep(() => ''), paradisPromptStep(() => null), paradisPromptStep(() => undefined), paradisPromptStep(() => 42), paradisPromptStep(() => { throw new Error('no handler'); })],
		}, {
			channels: [MAIN_BEGIN_CHANNEL, MAIN_END_CHANNEL],
			answers: ['typed', '', null, null, null, null],
		});
	});

	test('the page\'s prompt opens the stand-in confirm between the two steps, passes its arguments as the DOM does and returns the answer', async function () {
		if (process.versions.electron) {
			this.skip();
		}
		const { paradisInstallPromptOverride } = await import('../../electron-browser/preload-browserView.js');
		const calls: string[] = [];
		let accept = true;
		const page: Parameters<typeof paradisInstallPromptOverride>[0] = {
			__vscode_helpers: {
				paradisPromptBegin: (message, defaultValue) => { calls.push(`begin ${JSON.stringify([message, defaultValue])}`); return message === 'unavailable' ? null : `shown: ${message}`; },
				paradisPromptEnd: accepted => { calls.push(`end ${accepted}`); return accepted ? 'the answer' : null; },
			},
			confirm: message => { calls.push(`confirm ${message}`); return accept; },
		};
		paradisInstallPromptOverride(page);
		const prompt = page!.prompt as (message?: unknown, defaultValue?: unknown) => string | null;
		const results = [prompt('Name?', 'guest'), prompt(), prompt(12, null)];
		accept = false;
		results.push(prompt('cancelled'), prompt('unavailable'));
		// without the helpers (the bridge was not exposed) the page's prompt is left as it is
		const untouched: Parameters<typeof paradisInstallPromptOverride>[0] = { prompt: 'original', confirm: () => true };
		paradisInstallPromptOverride(untouched);
		assert.deepStrictEqual({ results, calls, name: prompt.name, untouched: untouched!.prompt }, {
			results: ['the answer', 'the answer', 'the answer', null, null],
			calls: [
				'begin ["Name?","guest"]', 'confirm shown: Name?', 'end true',
				'begin ["",""]', 'confirm shown: ', 'end true',
				'begin ["12","null"]', 'confirm shown: 12', 'end true',
				'begin ["cancelled",""]', 'confirm shown: cancelled', 'end false',
				// the main process could not be asked: no dialog, the page gets null
				'begin ["unavailable",""]',
			],
			name: 'prompt',
			untouched: 'original',
		});
	});
});
