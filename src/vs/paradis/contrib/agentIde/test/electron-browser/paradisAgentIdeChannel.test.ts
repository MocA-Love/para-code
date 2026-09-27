/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ITerminalEditorService, ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentModelCatalogService } from '../../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { ParadisAgentStatus } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { PARADIS_DEFAULT_AGENT_COMMANDS } from '../../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING, PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING, ParadisAgentIdeResult } from '../../common/paradisAgentIde.js';
import { ParadisAgentIdeChannel, paradisAgentIdeTerminalId } from '../../electron-browser/paradisAgentIdeChannel.js';

const REPOSITORY = { id: 'repo-1', name: 'para-code', uri: URI.file('/repo') };
const WORKTREE = { repositoryId: 'repo-1', name: 'feature', uri: URI.file('/repo-worktrees/feature') };
const WORKTREE_KEY = `worktree:${WORKTREE.uri.toString()}`;
const NEW_WORKTREE_URI = URI.file('/repo-worktrees/child');
const NEW_WORKTREE_KEY = `worktree:${NEW_WORKTREE_URI.toString()}`;

interface IFakeTerminal {
	readonly instanceId: number;
	readonly token: string;
	readonly space: string;
	readonly sent: { text: string; bracketed: boolean | undefined }[];
	status?: ParadisAgentStatus;
	bracketedPaste: boolean;
	disposed: boolean;
}

suite('ParadisAgentIdeChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { actionsEnabled?: boolean; scope?: 'space' | 'window' } = {}) {
		const terminals: IFakeTerminal[] = [];
		const instances = new Map<number, ITerminalInstance>();
		const add = (instanceId: number, space: string, status?: ParadisAgentStatus) => {
			const fake: IFakeTerminal = { instanceId, token: `token-${instanceId}`, space, sent: [], status, bracketedPaste: true, disposed: false };
			terminals.push(fake);
			instances.set(instanceId, upcastPartial<ITerminalInstance>({
				instanceId,
				title: `Terminal ${instanceId}`,
				get isDisposed() { return fake.disposed; },
				xterm: {
					raw: {
						buffer: { active: { length: 2, getLine: (y: number) => ({ isWrapped: false, translateToString: () => `line ${y}` }) } },
						get modes() { return { bracketedPasteMode: fake.bracketedPaste, applicationCursorKeysMode: false }; },
					},
				} as unknown as ITerminalInstance['xterm'],
				sendText: async (text: string, _execute: boolean, bracketed?: boolean) => { fake.sent.push({ text, bracketed }); },
				dispose: () => { fake.disposed = true; },
			}));
			return fake;
		};
		const live = () => terminals.filter(terminal => !terminal.disposed);
		const configuration = new TestConfigurationService({
			[PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING]: options.actionsEnabled ?? true,
			[PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING]: options.scope ?? 'space',
		});
		const commands: unknown[][] = [];
		const launched: { stateKey: string }[] = [];
		const channel = new ParadisAgentIdeChannel(
			upcastPartial<IParadisPaneTokenService>({
				getTokenForInstance: (instanceId: number) => live().find(terminal => terminal.instanceId === instanceId)?.token,
				getInstanceForToken: (token: string) => live().find(terminal => terminal.token === token)?.instanceId,
			}),
			upcastPartial<ITerminalService>({
				get instances() { return live().map(terminal => instances.get(terminal.instanceId)!); },
				safeDisposeTerminal: async (instance: ITerminalInstance) => instance.dispose(),
			}),
			upcastPartial<ITerminalGroupService>({ paradisParkedGroups: [] }),
			upcastPartial<ITerminalEditorService>({}),
			upcastPartial<IParadisTerminalScopeService>({
				isSharedPanelTerminal: () => false,
				getStateKeyForInstance: (instanceId: number) => terminals.find(terminal => terminal.instanceId === instanceId)?.space,
				resolveScope: () => ({ kind: 'pending' }),
			}),
			upcastPartial<IParadisWorkspaceSwitchService>({ repositories: [REPOSITORY], activeStateKey: REPOSITORY.id }),
			upcastPartial<IParadisWorktreeService>({ getWorktrees: () => [WORKTREE] }),
			upcastPartial<IParadisAgentStatusStore>({
				getInstanceStatus: (instanceId: number) => terminals.find(terminal => terminal.instanceId === instanceId)?.status,
				isAgentInstance: () => false,
			}),
			upcastPartial<IParadisAgentModelCatalogService>({ getAgentTemplates: () => PARADIS_DEFAULT_AGENT_COMMANDS }),
			configuration,
			upcastPartial<ICommandService>({ executeCommand: async (...args: unknown[]) => { commands.push(args); return undefined; } }),
			upcastPartial<IInstantiationService>({
				invokeFunction: (async (_fn: unknown, request: { stateKey?: string; repositoryId?: string }) => {
					if (request.repositoryId !== undefined) {
						// worktree の作成フロー: 新しいスペースにエージェントを起動したことにする
						const created = add(20, NEW_WORKTREE_KEY);
						return { name: 'child', branch: 'child', worktree: { repositoryId: request.repositoryId, name: 'child', uri: NEW_WORKTREE_URI }, agent: { instanceId: created.instanceId, paneToken: created.token } };
					}
					launched.push({ stateKey: request.stateKey! });
					const created = add(10 + launched.length, request.stateKey!);
					return { instanceId: created.instanceId, paneToken: created.token };
				}) as unknown as IInstantiationService['invokeFunction'],
			}),
			new NullLogService(),
		);
		const caller = add(1, REPOSITORY.id);
		const sameSpace = add(2, REPOSITORY.id);
		const otherSpace = add(3, WORKTREE_KEY);
		return { channel, caller, sameSpace, otherSpace, add, commands, launched };
	}

	const id = (terminal: IFakeTerminal) => paradisAgentIdeTerminalId(terminal.token);
	const outcome = (result: ParadisAgentIdeResult) => result.ok ? 'ok' : result.error;

	test('ids are stable and do not contain the pane token', () => {
		assert.deepStrictEqual(
			{ stable: paradisAgentIdeTerminalId('secret') === paradisAgentIdeTerminalId('secret'), shape: /^t_[0-9a-f]{12}$/.test(paradisAgentIdeTerminalId('secret')), leaks: paradisAgentIdeTerminalId('secret').includes('secret') },
			{ stable: true, shape: true, leaks: false },
		);
	});

	test('list_terminals marks self and only offers the same space for sending', async () => {
		const { channel, caller } = setup();
		const result = await channel.run(caller.token, { op: 'listTerminals' });
		assert.ok(result.ok);
		const rows = (result.data as { terminals: { id: string; space: string; self?: boolean; can_send: boolean }[] }).terminals;
		assert.deepStrictEqual(rows.map(row => ({ space: row.space, self: row.self === true, can_send: row.can_send })), [
			{ space: REPOSITORY.id, self: true, can_send: false },
			{ space: REPOSITORY.id, self: false, can_send: true },
			{ space: WORKTREE_KEY, self: false, can_send: false },
		]);
		assert.ok(!JSON.stringify(result.data).includes('token-'));
	});

	test('sending: same space ok, other space / self / permission refused', async () => {
		const { channel, caller, sameSpace, otherSpace, add } = setup();
		const waiting = add(4, REPOSITORY.id, 'permission');
		const results = [
			outcome(await channel.run(caller.token, { op: 'sendInput', terminal: id(sameSpace), text: 'ls', pressEnter: false })),
			outcome(await channel.run(caller.token, { op: 'sendInput', terminal: id(otherSpace), text: 'ls', pressEnter: false })).startsWith('That terminal is in a different space'),
			outcome(await channel.run(caller.token, { op: 'sendInput', terminal: id(caller), text: 'ls', pressEnter: false })).startsWith('That is your own terminal'),
			outcome(await channel.run(caller.token, { op: 'sendKey', terminal: id(waiting), key: 'enter' })).includes('waiting for the user'),
		];
		assert.deepStrictEqual({ results, sent: sameSpace.sent, otherSent: otherSpace.sent.length, waitingSent: waiting.sent.length }, {
			results: ['ok', true, true, true],
			sent: [{ text: 'ls', bracketed: true }],
			otherSent: 0,
			waitingSent: 0,
		});
	});

	test('window scope reaches other spaces', async () => {
		const { channel, caller, otherSpace } = setup({ scope: 'window' });
		assert.strictEqual(outcome(await channel.run(caller.token, { op: 'sendKey', terminal: id(otherSpace), key: 'ctrl_c' })), 'ok');
	});

	test('actions off: the window refuses writes too', async () => {
		const { channel, caller, sameSpace } = setup({ actionsEnabled: false });
		assert.deepStrictEqual([
			(await channel.run(caller.token, { op: 'readTerminal', terminal: id(sameSpace), lines: 10 })).ok,
			(await channel.run(caller.token, { op: 'sendInput', terminal: id(sameSpace), text: 'ls', pressEnter: true })).ok,
		], [true, false]);
	});

	test('multi-line text is refused where it would run line by line', async () => {
		const { channel, caller, sameSpace } = setup();
		sameSpace.bracketedPaste = false;
		const result = await channel.run(caller.token, { op: 'sendInput', terminal: id(sameSpace), text: 'a\nb', pressEnter: false });
		assert.deepStrictEqual({ ok: result.ok, sent: sameSpace.sent.length }, { ok: false, sent: 0 });
	});

	test('launching into another space is refused; launched terminals can be closed only by the agent that launched them', async () => {
		const { channel, caller, sameSpace } = setup();
		const outOfScope = await channel.run(caller.token, { op: 'launchAgent', agent: 'claude', space: WORKTREE_KEY });
		const launched = await channel.run(caller.token, { op: 'launchAgent', agent: 'claude' });
		assert.ok(launched.ok);
		const child = (launched.data as { terminal: string }).terminal;
		const results = [
			outcome(outOfScope).startsWith('That space is not yours'),
			outcome(await channel.run(caller.token, { op: 'sendInput', terminal: child, text: 'next task', pressEnter: false })),
			outcome(await channel.run(caller.token, { op: 'closeTerminal', terminal: id(sameSpace) })).startsWith('You can only close'),
			outcome(await channel.run(caller.token, { op: 'closeTerminal', terminal: child })),
			(await channel.run(sameSpace.token, { op: 'closeTerminal', terminal: child })).ok,
		];
		assert.deepStrictEqual(results, [true, 'ok', true, 'ok', false]);
	});

	test('a space the caller created is reachable even with the space scope', async () => {
		const { channel, caller, otherSpace } = setup();
		const created = await channel.run(caller.token, { op: 'createSpace', prompt: 'fix the login bug', agent: 'claude' });
		assert.ok(created.ok);
		const data = created.data as { space: string; agent_terminal: string };
		assert.deepStrictEqual([
			data.space,
			outcome(await channel.run(caller.token, { op: 'sendInput', terminal: data.agent_terminal, text: 'status?', pressEnter: false })),
			(await channel.run(caller.token, { op: 'sendInput', terminal: id(otherSpace), text: 'x', pressEnter: false })).ok,
		], [NEW_WORKTREE_KEY, 'ok', false]);
	});

	test('remove_space only asks for spaces the caller created, through the confirming command', async () => {
		const { channel, caller, commands } = setup();
		const result = await channel.run(caller.token, { op: 'removeSpace', space: WORKTREE_KEY });
		assert.deepStrictEqual({ ok: result.ok, commands: commands.length }, { ok: false, commands: 0 });
	});
});
