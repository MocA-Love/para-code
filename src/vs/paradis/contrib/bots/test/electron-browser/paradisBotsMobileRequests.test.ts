/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IParadisMobileRequest, IParadisMobileRequestContext } from '../../../mobileRelay/electron-browser/paradisMobileRequestHandlers.js';
import { IParadisBotSummary, IParadisBotsService, PARADIS_BOTS_ENABLED_SETTING } from '../../common/paradisBotsApi.js';
import { paradisCreateMobileBotHandler, PARADIS_MOBILE_BOT_HANDLERS } from '../../electron-browser/paradisBotsMobileRequests.js';

const BOT: IParadisBotSummary = {
	id: 'bot-1', name: 'リリース係', folder: 'release', agent: 'claude', paused: false, pinned: false, faceColor: 'blue', faceShape: 'drop',
	createdAt: 1, updatedAt: 1, needsYou: 0, openItems: 0, openSuggestions: 0, activity: 'idle', lastActivityAt: 1,
};

suite('Paradis bots mobile requests', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(enabled = true) {
		const calls: string[] = [];
		const files = new Map<string, string>([['MEMORY.md', '# Memory\n']]);
		const bots = {
			snapshot: { revision: 1, readOnly: false, bots: [BOT] },
			readHomeFile: async (_bot: string, path: string) => ({ ok: true, value: files.get(path) }),
			writeHomeFile: async (_bot: string, path: string, text: string) => { calls.push(`write ${path}`); files.set(path, text); return { ok: true, value: undefined }; },
			updateBot: async (_bot: string, patch: object) => { calls.push(`update ${JSON.stringify(patch)}`); return { ok: true, value: BOT }; },
			requestStop: async () => { calls.push('stop'); return true; },
		} as unknown as IParadisBotsService;
		const services = new Map<unknown, unknown>([
			[IConfigurationService, new TestConfigurationService({ [PARADIS_BOTS_ENABLED_SETTING]: enabled })],
			[IParadisBotsService, bots],
			[ICommandService, { executeCommand: async (id: string, arg: string) => { calls.push(`command ${id} ${arg}`); } }],
		]);
		const accessor = { get: (id: unknown) => services.get(id) } as unknown as ServicesAccessor;
		const replies: object[] = [];
		const context = { mobileId: 'phone', reply: (body: object) => replies.push(body) } as unknown as IParadisMobileRequestContext;
		const send = async (kind: string, body: Record<string, unknown>) => {
			await paradisCreateMobileBotHandler(kind, PARADIS_MOBILE_BOT_HANDLERS[kind]).handle(accessor, { t: kind, id: 'r', ...body } as IParadisMobileRequest, context);
		};
		return { send, replies, calls, files };
	}

	test('設定がオフならどの要求も断る', async () => {
		const { send, replies } = setup(false);
		await send('botOpen', { botId: 'bot-1' });
		assert.deepStrictEqual(replies, [{ error: 'bots are turned off on this PC', code: 'disabled' }]);
	});

	test('権限の変更は PC と同じ本文で確かめさせ、確かめた後だけ当てる。同じ opId は 2 回当てない', async () => {
		const { send, replies, calls } = setup();
		await send('botUpdate', { botId: 'bot-1', changes: { permission: 'skip-permissions' } });
		await send('botUpdate', { botId: 'bot-1', changes: { permission: 'skip-permissions' }, confirmed: true, opId: 'op-1' });
		await send('botUpdate', { botId: 'bot-1', changes: { permission: 'skip-permissions' }, confirmed: true, opId: 'op-1' });
		await send('botUpdate', { botId: 'bot-1', changes: { paused: true }, opId: 'op-2' });
		const preview = replies[0] as { needsConfirmation?: boolean; detail?: string; permission?: string };
		assert.deepStrictEqual([
			[preview.needsConfirmation, preview.permission, preview.detail?.includes('依頼'), preview.detail?.includes('skip-permissions')],
			replies.slice(1),
			calls,
		], [
			[true, 'wider', false, true],
			[{ t: 'botUpdate', applied: true }, { duplicate: true }, { t: 'botUpdate', applied: true }],
			['update {"permissionId":"skip-permissions"}', 'update {"paused":true}', 'stop'],
		]);
	});

	test('記憶は開いた後に書き換わっていたら上書きせず、SOUL.md は書かせない', async () => {
		const { send, replies, calls, files } = setup();
		files.set('MEMORY.md', '# Memory\n- Bot が足した行\n');
		await send('botFile', { botId: 'bot-1', path: 'MEMORY.md', text: '自分の編集', base: '# Memory\n', opId: 'w1' });
		await send('botFile', { botId: 'bot-1', path: 'SOUL.md', text: '書き換え', base: '', opId: 'w2' });
		await send('botFile', { botId: 'bot-1', path: '../secret', opId: 'w3' });
		await send('botOpen', { botId: 'bot-1' });
		assert.deepStrictEqual([replies, calls], [[
			{ t: 'botFile', path: 'MEMORY.md', text: '# Memory\n- Bot が足した行\n', conflict: true },
			{ error: 'SOUL.md cannot be written from the phone', code: 'invalid' },
			{ error: 'botFile reads SOUL.md or MEMORY.md', code: 'invalid' },
			{ t: 'botOpen', ok: true },
		], ['command paradis.bots.open bot-1']]);
	});
});
