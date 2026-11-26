/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisMcpOwningWindowRequest, IParadisMcpToolCallContext, ParadisMcpCallerKind } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import { ParadisHumanAskService } from '../../../humanAsk/node/paradisHumanAskChannel.js';
import { EMPTY_PARADIS_BOT_ITEMS_STATE, IParadisBotItemsState } from '../../common/paradisBotItems.js';
import { EMPTY_PARADIS_BOTS_STATE, IParadisBot, IParadisBotsState } from '../../common/paradisBots.js';
import { paradisApplyBotChange } from '../../common/paradisBotManageTools.js';
import { ParadisBotManageToolProvider } from '../../node/paradisBotManageToolProvider.js';
import { ParadisBotsService } from '../../node/paradisBotsService.js';
import { IParadisBotsJsonFile } from '../../node/paradisBotsStore.js';

class MemoryFile<T> implements IParadisBotsJsonFile<T> {
	constructor(public state: T) { }
	async read() {
		return { state: this.state };
	}
	async write(state: T) {
		this.state = state;
	}
}

suite('Paradis bot manage tools', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function harness() {
		let ids = 0;
		const service = store.add(new ParadisBotsService(new MemoryFile<IParadisBotsState>(EMPTY_PARADIS_BOTS_STATE), new MemoryFile<IParadisBotItemsState>(EMPTY_PARADIS_BOT_ITEMS_STATE), store.add(new ParadisHumanAskService()), new NullLogService(), { now: () => 1000, uuid: () => `id${++ids}` }));
		const settings = { allow: true, bots: true };
		const provider = new ParadisBotManageToolProvider(service, { actionsEnabled: () => settings.allow, botsEnabled: () => settings.bots });
		const windowCalls: string[] = [];
		const windowArgs: unknown[][] = [];
		const context = (caller: ParadisMcpCallerKind): IParadisMcpToolCallContext => ({
			callOwningWindow: async <T>(request: IParadisMcpOwningWindowRequest) => {
				windowCalls.push(`${request.channelName}.${request.method} ${JSON.stringify(request.args)}`);
				windowArgs.push(request.args);
				return { ok: true, value: (request.method === 'start' ? { ok: true, data: { state: 'started' } } : { ok: true, data: { requested: true } }) as T };
			},
			getPaneAgentStatus: () => undefined,
			getUnconfirmedRelease: () => undefined,
			hasAgentHookHistory: () => false,
			classifyCaller: async () => caller,
		});
		const call = async (name: string, args: unknown = {}, caller: ParadisMcpCallerKind = 'pane', pane = 'pane-user'): Promise<Record<string, unknown>> => {
			const result = await provider.callTool(pane, name, args, undefined, context(caller)) as { content: { text: string }[]; isError?: boolean };
			return result.isError ? { error: result.content[0].text.slice(0, 60) } : JSON.parse(result.content[0].text);
		};
		return { service, settings, call, windowCalls, windowArgs };
	}

	test('作る・変える・止める・起動と削除はウィンドウへ。顔は選べる名前だけ、権限とエージェントは受けない', async () => {
		const h = harness();
		const created = await h.call('create_bot', { name: 'レビュー係', role: 'PR を読んで危ない変更を挙げる。', agent: 'codex', model: 'gpt-6.2-sol', face_color: 'violet', pinned: true });
		const id = String(created.id);
		assert.deepStrictEqual({
			created,
			withPermission: await h.call('create_bot', { name: 'B', agent: 'claude', permission: 'skip-permissions' }),
			badFace: await h.call('create_bot', { name: 'B', agent: 'claude', face_shape: 'star' }),
			withRole: await h.call('update_bot', { bot: id, unknown: 1 }),
			updated: await h.call('update_bot', { bot: id, name: 'Reviewer', face_shape: 'hex', model: null, paused: true }),
			listed: await h.call('list_bots'),
			stopped: await h.call('stop_bot', { bot: id }),
			unknown: await h.call('start_bot', { bot: 'nope' }),
			started: await h.call('start_bot', { bot: id }),
			removal: await h.call('remove_bot', { bot: id }),
			windowCalls: h.windowCalls,
			// 削除は利用者の確認を待つので、まだ台帳にある
			stillThere: h.service.getBot(id)?.name,
		}, {
			created: { id: 'id1', name: 'レビュー係', agent: 'codex', model: 'gpt-6.2-sol', face_color: 'violet', face_shape: 'blob', paused: false, pinned: true, activity: 'stopped', needs_user: 0, open_items: 0 },
			withPermission: { error: 'create_bot takes only these arguments: name, role, agent, mo' },
			badFace: { error: 'create_bot needs "name" (up to 64 characters) and "agent" (c' },
			withRole: { error: 'update_bot takes only these arguments: bot, name, model, eff' },
			updated: { id: 'id1', name: 'Reviewer', agent: 'codex', face_color: 'violet', face_shape: 'hex', paused: true, pinned: true, activity: 'stopped', needs_user: 0, open_items: 0 },
			listed: { bots: [{ id: 'id1', name: 'Reviewer', agent: 'codex', face_color: 'violet', face_shape: 'hex', paused: true, pinned: true, activity: 'stopped', needs_user: 0, open_items: 0 }] },
			stopped: { bot: 'id1', stopped: false },
			unknown: { error: 'There is no bot with that id. Call list_bots for the ids.' },
			started: { bot: 'id1', state: 'started' },
			removal: { bot: 'id1', requested: true, note: 'Para Code asked the user to confirm the removal. The bot is removed only if they agree; call list_bots later to see the result.' },
			windowCalls: ['paradisBotsWindow.start ["pane-user","id1"]', 'paradisBotsWindow.confirmRemove ["pane-user","id1","Reviewer"]'],
			stillThere: 'Reviewer',
		});
	});

	test('設定がオフ・確かめられない接続元・Bot のペインからの書き込みを断る。読むのは通す', async () => {
		const h = harness();
		await h.call('create_bot', { name: 'A', agent: 'claude' });
		// Bot のペインを作る（起動の経路で結び付ける）
		const launchId = h.service.issueLaunch('id1', 'chat');
		assert.ok(launchId !== undefined && h.service.reportLaunch(launchId, 'pane-bot'));
		const fromBot = await Promise.all(['create_bot', 'update_bot', 'start_bot', 'stop_bot', 'remove_bot'].map(name => h.call(name, { bot: 'id1', name: 'X', agent: 'claude' }, 'pane', 'pane-bot')));
		const overTunnel = await h.call('update_bot', { bot: 'id1', pinned: true }, 'tunnel');
		const readOverTunnel = (await h.call('list_bots', {}, 'tunnel')).bots !== undefined;
		const readUnverified = await h.call('list_bots', {}, 'unverified');
		h.settings.allow = false;
		const off = await h.call('update_bot', { bot: 'id1', pinned: true });
		const readWhileOff = (await h.call('list_bots')).bots !== undefined;
		// Bot の機能（試験中）がオフなら、読む道具も断る
		h.settings.bots = false;
		const botsOff = [await h.call('list_bots'), await h.call('create_bot', { name: 'B', agent: 'claude' })];
		assert.deepStrictEqual({ fromBot: fromBot.map(result => result.error), overTunnel, readOverTunnel, readUnverified, off, readWhileOff, botsOff, pinned: h.service.getBot('id1')?.pinned }, {
			fromBot: Array(5).fill('This terminal is a Para Code bot. A bot cannot create, chang'),
			overTunnel: { error: 'Para Code could not confirm that this request comes from a p' },
			readOverTunnel: true,
			readUnverified: { error: 'Para Code could not confirm that this request comes from a p' },
			off: { error: 'Para Code does not allow agents to send input to terminals o' },
			readWhileOff: true,
			botsOff: Array(2).fill({ error: 'Para Code bots are still experimental and turned off. The us' }),
			pinned: false,
		});
	});

	test('エージェント・権限・役割の変更は利用者の確認を通す。ダイアログに出す前後と、権限が広がるか', async () => {
		const h = harness();
		await h.call('create_bot', { name: 'A', agent: 'codex' });
		const asked = await h.call('update_bot', { bot: 'id1', permission: 'bypass', role: '# A\n\nリリースを見張る。', pinned: true });
		await h.call('update_bot', { bot: 'id1', agent: 'claude', permission: 'skip-permissions' });
		assert.deepStrictEqual({
			asked,
			request: h.windowArgs[0][1],
			agentToo: (h.windowArgs[1][1] as { permission: string }).permission,
			calls: h.windowCalls.map(call => call.split(' ')[0]),
			// 確認の前は何も変わらない
			unchanged: [h.service.getBot('id1')?.permissionId, h.service.getBot('id1')?.pinned],
		}, {
			asked: { bot: 'id1', requested: true, note: 'Para Code asked the user to confirm the change. It is applied only if they agree; call list_bots later to see the result.' },
			request: {
				botId: 'id1',
				botName: 'A',
				changes: [{ field: 'permission', to: 'bypass' }, { field: 'pinned', from: 'false', to: 'true' }, { field: 'role', to: '# A\n\nリリースを見張る。' }],
				permission: 'wider',
				patch: { permissionId: 'bypass', pinned: true },
				role: '# A\n\nリリースを見張る。',
			},
			agentToo: 'unknown',
			calls: ['paradisBotsWindow.confirmChange', 'paradisBotsWindow.confirmChange'],
			unchanged: [undefined, false],
		});
	});

	test('確かめた変更を当てる: 台帳の変更の後に役割を書く。台帳に断られたら役割は書かない', async () => {
		const calls: string[] = [];
		const service = {
			updateBot: async (botId: string, patch: object) => {
				calls.push(`update ${botId} ${JSON.stringify(patch)}`);
				return botId === 'locked' ? { ok: false as const, code: 'read_only', message: 'x' } : { ok: true as const, value: {} as IParadisBot };
			},
			writeHomeFile: async (botId: string, path: string, text: string) => {
				calls.push(`write ${botId} ${path} ${text}`);
				return { ok: true as const, value: undefined };
			},
		};
		const applied = await paradisApplyBotChange(service, { botId: 'b1', patch: { permissionId: 'bypass' }, role: '# A' });
		const roleOnly = await paradisApplyBotChange(service, { botId: 'b1', patch: {}, role: '# B' });
		const refused = await paradisApplyBotChange(service, { botId: 'locked', patch: { agent: 'claude' }, role: '# C' });
		assert.deepStrictEqual({ applied, roleOnly, refused, calls }, {
			applied: { ok: true, value: undefined },
			roleOnly: { ok: true, value: undefined },
			refused: { ok: false, code: 'read_only', message: 'x' },
			calls: ['update b1 {"permissionId":"bypass"}', 'write b1 SOUL.md # A', 'write b1 SOUL.md # B', 'update locked {"agent":"claude"}'],
		});
	});
});
