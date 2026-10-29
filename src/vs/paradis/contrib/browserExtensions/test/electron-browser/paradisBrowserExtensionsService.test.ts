/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Event } from '../../../../../base/common/event.js';
import { BrowserViewStorageScope } from '../../../../../platform/browserView/common/browserView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IParadisBrowserProfilesService } from '../../../browserProfiles/electron-browser/paradisBrowserProfilesService.js';
import { IParadisShareExtensions } from '../../common/paradisBrowserExtensions.js';
import { ParadisBrowserExtensionsService, paradisShareFallbackProfile, paradisShareWarningFor, paradisShareWarningUnknown } from '../../electron-browser/paradisBrowserExtensionsService.js';

const extension = (name: string, touchesPages: boolean) => ({ id: 'a'.repeat(32), name, touchesPages });

suite('ParadisBrowserExtensionsService share warning', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('warns only about extensions that can read and write pages', () => {
		const warning = (extensions: Parameters<typeof paradisShareWarningFor>[0]) => {
			const text = paradisShareWarningFor(extensions);
			// 名前の並びだけを取り出して比べる（文の言い回しは訳で変わるため）
			return text === undefined ? undefined : /（(?<names>.*?)）/.exec(text)?.groups?.names;
		};
		assert.deepStrictEqual([
			warning([]),
			warning([extension('Theme', false)]),
			warning([extension('Theme', false), extension('Bitwarden', true)]),
			warning([extension('A', true), extension('B', true), extension('C', true), extension('D', true), extension('E', true)]),
		], [undefined, undefined, 'Bitwarden', 'A、B、C ほか 2 個']);
	});

	test('picks the profile to check for a tab that is not open yet', () => {
		assert.deepStrictEqual([
			paradisShareFallbackProfile(undefined),
			paradisShareFallbackProfile({ scope: BrowserViewStorageScope.Global }),
			paradisShareFallbackProfile({ scope: BrowserViewStorageScope.Workspace }),
			paradisShareFallbackProfile({ scope: BrowserViewStorageScope.Profile, profileId: '0123456789ab' }),
			paradisShareFallbackProfile({ scope: BrowserViewStorageScope.Agent }),
			paradisShareFallbackProfile({ scope: BrowserViewStorageScope.Ephemeral }),
		], ['default', 'default', 'default', 'profile:0123456789ab', undefined, undefined]);
	});

	test('warns when it cannot find out, as long as the setting is on', async () => {
		const create = (answer: () => Promise<IParadisShareExtensions>, setting: boolean, confirmed = false) => {
			const calls: unknown[] = [];
			const service = new ParadisBrowserExtensionsService(
				{ getChannel: () => ({ call: async (_command: string, args: unknown[]) => { calls.push(args); return answer(); }, listen: () => Event.None }) } as unknown as IMainProcessService,
				{ getValue: () => setting } as unknown as IConfigurationService,
				{ getViewSession: () => ({ scope: BrowserViewStorageScope.Profile, profileId: '0123456789ab' }) } as unknown as IParadisBrowserProfilesService,
				{ confirm: async () => ({ confirmed }) } as unknown as IDialogService,
			);
			return { service, calls };
		};
		const filler = { id: 'a'.repeat(32), name: 'Filler', touchesPages: true };
		const failing = create(async () => { throw new Error('gone'); }, true);
		const failingOff = create(async () => { throw new Error('gone'); }, false);
		const inactive = create(async () => ({ active: false, extensions: [filler] }), true);
		const found = create(async () => ({ active: true, extensions: [filler] }), true, false);
		assert.deepStrictEqual({
			failing: await failing.service.getShareWarning({ kind: 'view', viewId: 'view-1' }),
			failingOff: await failingOff.service.getShareWarning({ kind: 'view', viewId: 'view-1' }),
			inactive: await inactive.service.getShareWarning({ kind: 'view', viewId: 'view-1' }),
			// 開いていないタブは、そのタブのプロファイルで有効にしてあるものを main に聞く
			profileQuery: (await found.service.getShareWarning({ kind: 'profile', profileId: 'abcdefabcdef' }), found.calls[0]),
			viewQuery: (await found.service.getShareWarning({ kind: 'view', viewId: 'view-1' }), found.calls[1]),
			confirmedWithWarning: await found.service.confirmShare({ kind: 'view', viewId: 'view-1' }),
			confirmedWithoutWarning: await inactive.service.confirmShare({ kind: 'view', viewId: 'view-1' }),
		}, {
			failing: paradisShareWarningUnknown(),
			failingOff: undefined,
			inactive: undefined,
			profileQuery: [undefined, 'profile:abcdefabcdef'],
			viewQuery: ['view-1', 'profile:0123456789ab'],
			confirmedWithWarning: false,
			confirmedWithoutWarning: true,
		});
	});
});
