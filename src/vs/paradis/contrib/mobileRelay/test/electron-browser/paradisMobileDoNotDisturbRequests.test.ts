/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IParadisNotificationsSettingsService } from '../../../notifications/browser/paradisNotificationsSettings.js';
import { ParadisMobileDoNotDisturbOpLedger } from '../../common/paradisMobileDoNotDisturb.js';
import { ParadisMobileDoNotDisturbSettings, paradisCreateMobileDoNotDisturbSetHandler } from '../../electron-browser/paradisMobileDoNotDisturbRequests.js';
import { IParadisMobileRequest, IParadisMobileRequestContext, IParadisMobileRequestHost, paradisDispatchMobileRequest } from '../../electron-browser/paradisMobileRequestHandlers.js';

class FakeSettings implements ParadisMobileDoNotDisturbSettings {
	enabled = false;
	until: number | undefined;
	readonly writes: Array<[boolean, number | undefined]> = [];
	getDoNotDisturb() {
		return { enabled: this.enabled, until: this.enabled ? this.until : undefined };
	}
	setDoNotDisturb(enabled: boolean, until: number | undefined): void {
		this.writes.push([enabled, until]);
		this.enabled = enabled;
		this.until = enabled ? until : undefined;
	}
}

const NOW = 1_800_000_000_000;

suite('ParadisMobileDoNotDisturbRequests', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function run(settings: FakeSettings, requests: ReadonlyArray<{ readonly mobileId: string | undefined; readonly body: Record<string, unknown> }>): unknown[] {
		const handler = paradisCreateMobileDoNotDisturbSetHandler(() => settings, new ParadisMobileDoNotDisturbOpLedger(), () => NOW);
		const replies: unknown[] = [];
		for (const { mobileId, body } of requests) {
			const context = { channel: 'fs', mobileId, root: undefined, reply: (reply: object) => replies.push(reply) } as unknown as IParadisMobileRequestContext;
			handler.handle({} as ServicesAccessor, { id: 'r', ...body } as IParadisMobileRequest, context);
		}
		return replies;
	}

	test('入れる・同じ操作の送り直しは適用しない・切る', () => {
		const settings = new FakeSettings();
		const replies = run(settings, [
			{ mobileId: 'phone', body: { t: 'dndSet', opId: 'op-1', enabled: true, duration: 'hours1' } },
			{ mobileId: 'phone', body: { t: 'dndSet', opId: 'op-1', enabled: true, duration: 'hours1' } },
			{ mobileId: 'phone', body: { t: 'dndSet', opId: 'op-2', enabled: true, duration: 'manual' } },
			{ mobileId: 'phone', body: { t: 'dndSet', opId: 'op-3', enabled: false } },
			// 別の端末の同じ opId は別の操作
			{ mobileId: 'ipad', body: { t: 'dndSet', opId: 'op-1', enabled: true, duration: 'minutes30' } },
		]);
		assert.deepStrictEqual({ replies, writes: settings.writes }, {
			replies: [
				{ t: 'dndSet', state: { enabled: true, until: NOW + 60 * 60 * 1000 } },
				{ t: 'dndSet', state: { enabled: true, until: NOW + 60 * 60 * 1000 }, duplicate: true },
				{ t: 'dndSet', state: { enabled: true } },
				{ t: 'dndSet', state: { enabled: false } },
				{ t: 'dndSet', state: { enabled: true, until: NOW + 30 * 60 * 1000 } },
			],
			writes: [[true, NOW + 60 * 60 * 1000], [true, undefined], [false, undefined], [true, NOW + 30 * 60 * 1000]],
		});
	});

	test('形の合わない要求・知らない期限・送り手の分からない要求は断り、何も変えない', () => {
		const settings = new FakeSettings();
		const replies = run(settings, [
			{ mobileId: 'phone', body: { t: 'dndSet', opId: 'op-1', enabled: true, duration: 'hours2' } },
			{ mobileId: 'phone', body: { t: 'dndSet', opId: 'op-1', enabled: true } },
			{ mobileId: 'phone', body: { t: 'dndSet', enabled: false } },
			{ mobileId: 'phone', body: { t: 'dndSet', opId: 'op-1', enabled: 'yes' } },
			{ mobileId: undefined, body: { t: 'dndSet', opId: 'op-1', enabled: false } },
		]);
		assert.deepStrictEqual({ replies, writes: settings.writes }, {
			replies: [
				{ error: 'invalid do-not-disturb request', code: 'invalid' },
				{ error: 'invalid do-not-disturb request', code: 'invalid' },
				{ error: 'invalid do-not-disturb request', code: 'invalid' },
				{ error: 'invalid do-not-disturb request', code: 'invalid' },
				{ error: 'unknown device', code: 'forbidden' },
			],
			writes: [],
		});
	});

	test('登録表から届き、応答は要求の id へ返る', () => {
		const settings = new FakeSettings();
		const sent: string[] = [];
		const host: IParadisMobileRequestHost = {
			invokeFunction: fn => fn({ get: (id: unknown) => { assert.strictEqual(id, IParadisNotificationsSettingsService); return settings; } } as unknown as ServicesAccessor),
			resolveRoot: () => URI.file('/repo'),
			runGit: async () => ({ code: 0, stdout: '', stderr: '' }),
			resolvePath: async () => undefined,
			getMobileCapabilities: async () => undefined,
			getMobileWireVersion: async () => undefined,
			send: (_channel, mobileId, payload) => sent.push(`${mobileId}:${new TextDecoder().decode(payload)}`),
		};
		const handled = paradisDispatchMobileRequest('fs', { t: 'dndSet', id: 'r1', opId: 'op-1', enabled: false }, 'phone', host);
		assert.deepStrictEqual({ handled, sent }, { handled: true, sent: ['phone:{"t":"dndSet","state":{"enabled":false},"id":"r1"}'] });
	});
});
