/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotification, INotificationService } from '../../../../../platform/notification/common/notification.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ITerminalEditorService, ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { ParadisAgentStatus } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisPaneTokenService } from '../../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentModelCatalogService } from '../../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { IParadisDialogService } from '../../../confirmDialog/browser/paradisDialogService.js';
import { IParadisSpaceSectionsService } from '../../../workspaceSwitch/common/paradisSpaceSections.js';
import { IParadisWorkspaceSectionsService } from '../../../workspaceSwitch/common/paradisWorkspaceSections.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { PARADIS_DEFAULT_AGENT_COMMANDS } from '../../../workspaceSwitch/common/paradisWorktreeCreate.js';
import {
	PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING,
	PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING,
	PARADIS_AGENT_IDE_ALLOW_SHELL_COMMANDS_SETTING,
	PARADIS_AGENT_IDE_READ_OTHER_SPACES_SETTING,
	ParadisAgentIdeRequest,
	ParadisAgentIdeResult,
} from '../../common/paradisAgentIde.js';
import { ParadisAgentIdeChannel, paradisAgentIdeTerminalId } from '../../electron-browser/paradisAgentIdeChannel.js';

const REPOSITORY = { id: 'repo-1', name: 'para-code', uri: URI.file('/repo') };
const WORKTREE = { repositoryId: 'repo-1', name: 'feature', uri: URI.file('/repo-worktrees/feature') };
const WORKTREE_KEY = `worktree:${WORKTREE.uri.toString()}`;
const OTHER_REPOSITORY = { id: 'repo-2', name: 'other', uri: URI.file('/other') };
const OTHER_WORKTREE = { repositoryId: 'repo-2', name: 'review', uri: URI.file('/other-worktrees/review') };
const OTHER_WORKTREE_KEY = `worktree:${OTHER_WORKTREE.uri.toString()}`;
const NEW_WORKTREE_URI = URI.file('/repo-worktrees/child');
const NEW_WORKTREE_KEY = `worktree:${NEW_WORKTREE_URI.toString()}`;

interface IFakeTerminal {
	readonly instanceId: number;
	readonly token: string;
	readonly space: string;
	readonly sent: { text: string; bracketed: boolean | undefined }[];
	status?: ParadisAgentStatus;
	/** 前面で動いているコマンド（エージェントなら 'claude'）。 */
	executing: string | undefined;
	bracketedPaste: boolean;
	/** Text shown on the second screen line (default `line <n>`). */
	screenText?: string;
	/** Whether shell integration (command detection) is present. */
	shellIntegration: boolean;
	disposed: boolean;
}

suite('ParadisAgentIdeChannel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { actionsEnabled?: boolean; scope?: 'space' | 'window'; readOtherSpaces?: boolean; shellCommands?: boolean; storage?: InMemoryStorageService; otherRepository?: boolean } = {}) {
		const terminals: IFakeTerminal[] = [];
		const instances = new Map<number, ITerminalInstance>();
		const onDidDisposeInstance = store.add(new Emitter<ITerminalInstance>());
		const add = (instanceId: number, space: string, status?: ParadisAgentStatus, executing: string | null = 'claude') => {
			const fake: IFakeTerminal = { instanceId, token: `token-${instanceId}`, space, sent: [], status, executing: executing ?? undefined, bracketedPaste: true, shellIntegration: true, disposed: false };
			terminals.push(fake);
			const instance = upcastPartial<ITerminalInstance>({
				instanceId,
				title: `Terminal ${instanceId}`,
				get isDisposed() { return fake.disposed; },
				capabilities: upcastPartial<ITerminalInstance['capabilities']>({
					get: ((capability: TerminalCapability) => capability === TerminalCapability.CommandDetection && fake.shellIntegration ? { executingCommand: fake.executing } : undefined) as ITerminalInstance['capabilities']['get'],
				}),
				xterm: {
					raw: {
						rows: 2,
						buffer: { active: { length: 2, getLine: (y: number) => ({ isWrapped: false, translateToString: () => y === 1 && fake.screenText ? fake.screenText : `line ${y}` }) } },
						get modes() { return { bracketedPasteMode: fake.bracketedPaste, applicationCursorKeysMode: false }; },
					},
				} as unknown as ITerminalInstance['xterm'],
				sendText: async (text: string, _execute: boolean, bracketed?: boolean) => { fake.sent.push({ text, bracketed }); },
				dispose: () => { fake.disposed = true; onDidDisposeInstance.fire(instance); },
			});
			instances.set(instanceId, instance);
			return fake;
		};
		const live = () => terminals.filter(terminal => !terminal.disposed);
		const configuration = new TestConfigurationService({
			[PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING]: options.actionsEnabled ?? true,
			[PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING]: options.scope ?? 'space',
			[PARADIS_AGENT_IDE_READ_OTHER_SPACES_SETTING]: options.readOtherSpaces ?? false,
			[PARADIS_AGENT_IDE_ALLOW_SHELL_COMMANDS_SETTING]: options.shellCommands ?? false,
		});
		const commands: unknown[][] = [];
		const notifications: INotification[] = [];
		// もう 1 つのリポジトリと、その中身だけを持つセクション（範囲の外の相手）
		const repositories = options.otherRepository ? [REPOSITORY, OTHER_REPOSITORY] : [REPOSITORY];
		const worktreesOf = (repositoryId: string) => repositoryId === REPOSITORY.id ? [WORKTREE] : repositoryId === OTHER_REPOSITORY.id && options.otherRepository ? [OTHER_WORKTREE] : [];
		let projectSections = options.otherRepository ? [{ id: 'project-2', name: 'Other' }] : [];
		let spaceSections = options.otherRepository ? [{ id: 'inside-2', name: 'Review', repositoryId: OTHER_REPOSITORY.id }] : [];
		const repositoryMember = new Map<string, string>(options.otherRepository ? [[OTHER_REPOSITORY.id, 'project-2']] : []);
		const worktreeMember = new Map<string, string>(options.otherRepository ? [[OTHER_WORKTREE.uri.toString(), 'inside-2']] : []);
		const setMember = (members: Map<string, string>, key: string, sectionId: string | undefined) => {
			if (sectionId === undefined) {
				members.delete(key);
			} else {
				members.set(key, sectionId);
			}
		};
		const storage = options.storage ?? store.add(new InMemoryStorageService());
		let launches = 0;
		const channel = store.add(new ParadisAgentIdeChannel(
			upcastPartial<IParadisPaneTokenService>({
				getTokenForInstance: (instanceId: number) => live().find(terminal => terminal.instanceId === instanceId)?.token,
				getInstanceForToken: (token: string) => live().find(terminal => terminal.token === token)?.instanceId,
			}),
			upcastPartial<ITerminalService>({
				get instances() { return live().map(terminal => instances.get(terminal.instanceId)!); },
				safeDisposeTerminal: async (instance: ITerminalInstance) => instance.dispose(),
				onDidDisposeInstance: onDidDisposeInstance.event,
				whenConnected: Promise.resolve(),
			}),
			upcastPartial<ITerminalGroupService>({ paradisParkedGroups: [] }),
			upcastPartial<ITerminalEditorService>({}),
			upcastPartial<IParadisTerminalScopeService>({
				isSharedPanelTerminal: () => false,
				getStateKeyForInstance: (instanceId: number) => terminals.find(terminal => terminal.instanceId === instanceId)?.space,
				// 記録の無いものを今のスペースと答える本物の挙動（strict では使わない）
				resolveScope: () => ({ kind: 'managed', stateKey: REPOSITORY.id }),
			}),
			upcastPartial<IParadisWorkspaceSwitchService>({ repositories, activeStateKey: REPOSITORY.id, onDidRetireScope: Event.None }),
			upcastPartial<IParadisWorktreeService>({ getWorktrees: worktreesOf }),
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
					launches++;
					const created = add(10 + launches, request.stateKey!);
					return { instanceId: created.instanceId, paneToken: created.token };
				}) as unknown as IInstantiationService['invokeFunction'],
			}),
			upcastPartial<INotificationService>({ notify: (notification: INotification) => { notifications.push(notification); return undefined!; } }),
			storage,
			upcastPartial<ILifecycleService>({ willShutdown: false }),
			new NullLogService(),
			upcastPartial<IParadisWorkspaceSectionsService>({
				groups: () => projectSections.map(section => ({ section, repositories: repositories.filter(repository => repositoryMember.get(repository.id) === section.id) })),
				isCollapsed: () => false,
				setCollapsed: () => { },
				sectionOf: (repositoryId: string) => repositoryMember.get(repositoryId),
				moveRepositoryToSection: (repositoryId: string, sectionId: string | undefined) => { setMember(repositoryMember, repositoryId, sectionId); },
				removeSection: (sectionId: string) => { projectSections = projectSections.filter(section => section.id !== sectionId); },
			}),
			upcastPartial<IParadisSpaceSectionsService>({
				createSection: () => undefined,
				sectionsOf: (repositoryId: string) => spaceSections.filter(section => section.repositoryId === repositoryId),
				orderedWorktrees: worktreesOf,
				isCollapsed: () => false,
				setCollapsed: () => { },
				sectionOf: (worktree: IParadisWorktree) => worktreeMember.get(worktree.uri.toString()),
				moveSpaceToSection: (worktree: IParadisWorktree, sectionId: string | undefined) => { setMember(worktreeMember, worktree.uri.toString(), sectionId); },
				removeSection: (_repositoryId: string, sectionId: string) => { spaceSections = spaceSections.filter(section => section.id !== sectionId); },
			}),
			upcastPartial<IParadisDialogService>({}),
			upcastPartial<IHostService>({}),
		));
		const caller = add(1, REPOSITORY.id);
		const sameSpace = add(2, REPOSITORY.id);
		const otherSpace = add(3, WORKTREE_KEY);
		return { channel, caller, sameSpace, otherSpace, add, commands, notifications, storage };
	}

	const id = (terminal: IFakeTerminal) => paradisAgentIdeTerminalId(terminal.token);
	const outcome = (result: ParadisAgentIdeResult) => result.ok ? 'ok' : result.error;

	test('ids are stable and do not contain the pane token', () => {
		assert.deepStrictEqual(
			{ stable: paradisAgentIdeTerminalId('secret') === paradisAgentIdeTerminalId('secret'), shape: /^t_[0-9a-f]{12}$/.test(paradisAgentIdeTerminalId('secret')), leaks: paradisAgentIdeTerminalId('secret').includes('secret') },
			{ stable: true, shape: true, leaks: false },
		);
	});

	test('reading is limited to the own space unless allowed', async () => {
		const narrow = setup();
		const wide = setup({ readOtherSpaces: true });
		const listed = await narrow.channel.run(narrow.caller.token, { op: 'listTerminals' });
		assert.ok(listed.ok);
		const rows = (listed.data as { terminals: { space: string; self?: boolean; can_send: boolean }[]; not_listed?: string }).terminals;
		assert.deepStrictEqual({
			rows: rows.map(row => ({ space: row.space, self: row.self === true, can_send: row.can_send })),
			notListed: typeof (listed.data as { not_listed?: string }).not_listed,
			readOther: outcome(await narrow.channel.run(narrow.caller.token, { op: 'readTerminal', terminal: id(narrow.otherSpace), scrollbackLines: 0 })).startsWith('That terminal is in a different space'),
			probeOther: (await narrow.channel.run(narrow.caller.token, { op: 'probeTerminal', terminal: id(narrow.otherSpace) })).ok,
			wideRead: (await wide.channel.run(wide.caller.token, { op: 'readTerminal', terminal: id(wide.otherSpace), scrollbackLines: 0 })).ok,
			leaks: JSON.stringify(listed.data).includes('token-'),
		}, {
			rows: [{ space: REPOSITORY.id, self: true, can_send: false }, { space: REPOSITORY.id, self: false, can_send: true }],
			notListed: 'string',
			readOther: true,
			probeOther: false,
			wideRead: true,
			leaks: false,
		});
	});

	test('section tools: list_spaces carries the sections, and writing needs the setting and a known caller', async () => {
		const on = setup();
		const off = setup({ actionsEnabled: false });
		const listed = await on.channel.run(on.caller.token, { op: 'listSpaces' });
		assert.deepStrictEqual({
			sections: listed.ok ? (listed.data as { sections?: unknown }).sections : undefined,
			off: outcome(await off.channel.run(off.caller.token, { op: 'createSection', name: 'Work' })),
			unknownCaller: outcome(await on.channel.run('token-of-nobody', { op: 'createSection', name: 'Work' })),
			unknownSection: outcome(await on.channel.run(on.caller.token, { op: 'removeSection', section: 'missing' })),
		}, {
			sections: [],
			off: 'Agent actions are turned off in Para Code settings.',
			unknownCaller: 'Para Code cannot find your own terminal in this window yet (it may still be restoring). Retry in a few seconds.',
			unknownSection: 'Unknown section "missing". There are no sections yet; create one with create_space_section.',
		});
	});

	test('section tools: with the default action scope, sections and spaces of another repository are refused; the whole window allows them', async () => {
		const run = async (scope: 'space' | 'window') => {
			const { channel, caller } = setup({ scope, otherRepository: true });
			const steps = [
				{ op: 'createSection', name: 'Review', repository: OTHER_REPOSITORY.id },
				{ op: 'updateSection', section: 'inside-2', collapsed: false },
				{ op: 'moveSpaceToSection', space: OTHER_WORKTREE_KEY, section: 'none' },
				{ op: 'removeSection', section: 'inside-2' },
				{ op: 'updateSection', section: 'project-2', collapsed: false },
				{ op: 'moveSpaceToSection', space: OTHER_REPOSITORY.id, section: 'none' },
				{ op: 'removeSection', section: 'project-2' },
			] satisfies ParadisAgentIdeRequest[];
			const outcomes: string[] = [];
			for (const step of steps) {
				outcomes.push(`${step.op}: ${outcome(await channel.run(caller.token, step))}`);
			}
			return outcomes;
		};
		const refusal = 'That section or space belongs to a repository other than the one of your own space. Agents can only change sections of the repository of their own space (the user can widen this to the whole window in Para Code settings).';
		assert.deepStrictEqual({ space: await run('space'), window: await run('window') }, {
			space: [
				`createSection: ${refusal}`,
				`updateSection: ${refusal}`,
				`moveSpaceToSection: ${refusal}`,
				`removeSection: ${refusal}`,
				`updateSection: ${refusal}`,
				`moveSpaceToSection: ${refusal}`,
				`removeSection: ${refusal}`,
			],
			window: [
				// 作成はスタブが id を返さないので保存できなかった扱い（範囲では断られていない）
				'createSection: Para Code could not save the change (the list of sections may be full). Nothing was changed; call list_spaces to see the current sections.',
				'updateSection: ok',
				'moveSpaceToSection: ok',
				'removeSection: ok',
				'updateSection: ok',
				'moveSpaceToSection: ok',
				'removeSection: ok',
			],
		});
	});

	test('a terminal without a recorded space is not treated as the current space', async () => {
		const { channel, caller, add } = setup();
		const unrecorded = add(4, undefined!);
		assert.strictEqual((await channel.run(caller.token, { op: 'readTerminal', terminal: id(unrecorded), scrollbackLines: 0 })).ok, false);
	});

	test('sending: same space is pasted with the agent marker; other space, self and permission are refused', async () => {
		const { channel, caller, sameSpace, otherSpace, add, notifications } = setup();
		const waiting = add(4, REPOSITORY.id, 'permission');
		const results = [
			outcome(await channel.run(caller.token, { op: 'sendInput', terminal: id(sameSpace), text: 'ls' })),
			outcome(await channel.run(caller.token, { op: 'sendInput', terminal: id(otherSpace), text: 'ls' })).startsWith('That terminal is in a different space'),
			outcome(await channel.run(caller.token, { op: 'sendInput', terminal: id(caller), text: 'ls' })).startsWith('That is your own terminal'),
			outcome(await channel.run(caller.token, { op: 'sendKey', terminal: id(waiting), key: 'enter' })).includes('waiting for the user'),
		];
		assert.deepStrictEqual({
			results,
			marked: sameSpace.sent.length === 1 && sameSpace.sent[0].text.startsWith('[Message from another agent') && sameSpace.sent[0].text.endsWith('ls') && sameSpace.sent[0].bracketed === true,
			otherSent: otherSpace.sent.length,
			waitingSent: waiting.sent.length,
			notified: notifications.length,
		}, { results: ['ok', true, true, true], marked: true, otherSent: 0, waitingSent: 0, notified: 1 });
	});

	test('a Codex menu on screen (Plan mode "Implement this plan?") gets no keys or text, and is listed as waiting for a choice', async () => {
		const { channel, caller, add } = setup();
		const planning = add(4, REPOSITORY.id, 'review');
		// 2 行目に、Plan メニューの末尾を複数行で出す（キーの案内の行は単語を連ねて組み立てる）
		planning.screenText = ['  Implement this plan?', '\u203a 1. Yes, implement this plan', '  3. No, stay in Plan mode', `  ${['enter', 'select', '\u00b7', 'esc', 'back'].join(' ')}`].join('\n');
		const results = await Promise.all((['enter', 'down', 'escape'] as const).map(async key => outcome(await channel.run(caller.token, { op: 'sendKey', terminal: id(planning), key })).includes('plan_implement')));
		const typed = outcome(await channel.run(caller.token, { op: 'sendInput', terminal: id(planning), text: '1' })).includes('plan_implement');
		const listed = await channel.run(caller.token, { op: 'listTerminals' });
		const entry = listed.ok ? (listed.data as { terminals: { id: string; status: string; can_send: boolean }[] }).terminals.find(terminal => terminal.id === id(planning)) : undefined;
		assert.deepStrictEqual({ results, typed, sent: planning.sent.length, status: entry?.status, canSend: entry?.can_send }, { results: [true, true, true], typed: true, sent: 0, status: 'waiting_for_choice', canSend: false });
	});

	test('Enter in a plain shell needs the shell setting; working agents do not get Enter', async () => {
		const blocked = setup();
		const shell = blocked.add(4, REPOSITORY.id, undefined, null);
		const busy = blocked.add(5, REPOSITORY.id, 'working');
		// Without shell integration Para Code cannot tell an agent is running, so it counts as a plain shell.
		const noIntegration = blocked.add(6, REPOSITORY.id);
		noIntegration.shellIntegration = false;

		const allowed = setup({ shellCommands: true });
		const allowedShell = allowed.add(4, REPOSITORY.id, undefined, null);
		assert.deepStrictEqual([
			(await blocked.channel.run(blocked.caller.token, { op: 'sendKey', terminal: id(shell), key: 'enter' })).ok,
			(await blocked.channel.run(blocked.caller.token, { op: 'sendKey', terminal: id(shell), key: 'ctrl_c' })).ok,
			(await blocked.channel.run(blocked.caller.token, { op: 'sendKey', terminal: id(busy), key: 'enter' })).ok,
			(await blocked.channel.run(blocked.caller.token, { op: 'sendKey', terminal: id(noIntegration), key: 'enter' })).ok,
			(await allowed.channel.run(allowed.caller.token, { op: 'sendKey', terminal: id(allowedShell), key: 'enter' })).ok,
			(await blocked.channel.run(blocked.caller.token, { op: 'createTerminal' })).ok,
		], [false, true, false, false, true, false]);
	});

	test('multi-line text is only pasted into an agent in the foreground', async () => {
		const { channel, caller, sameSpace } = setup();
		sameSpace.executing = 'bash';
		const result = await channel.run(caller.token, { op: 'sendInput', terminal: id(sameSpace), text: 'a\nb' });
		assert.deepStrictEqual({ ok: result.ok, sent: sameSpace.sent.length }, { ok: false, sent: 0 });
	});

	test('window scope reaches other spaces', async () => {
		const { channel, caller, otherSpace } = setup({ scope: 'window' });
		assert.strictEqual(outcome(await channel.run(caller.token, { op: 'sendKey', terminal: id(otherSpace), key: 'ctrl_c' })), 'ok');
	});

	test('actions off: the window refuses writes too', async () => {
		const { channel, caller, sameSpace } = setup({ actionsEnabled: false });
		assert.deepStrictEqual([
			(await channel.run(caller.token, { op: 'readTerminal', terminal: id(sameSpace), scrollbackLines: 0 })).ok,
			(await channel.run(caller.token, { op: 'sendInput', terminal: id(sameSpace), text: 'ls' })).ok,
		], [true, false]);
	});

	test('launched children cannot launch or create, only their launcher can close them, and the ledger survives a reload', async () => {
		const first = setup();
		const outOfScope = await first.channel.run(first.caller.token, { op: 'launchAgent', agent: 'claude', space: WORKTREE_KEY });
		const launched = await first.channel.run(first.caller.token, { op: 'launchAgent', agent: 'claude' });
		assert.ok(launched.ok);
		const child = (launched.data as { terminal: string }).terminal;
		const childToken = 'token-11';
		const reloaded = setup({ storage: first.storage });
		reloaded.add(11, REPOSITORY.id);
		assert.deepStrictEqual([
			outcome(outOfScope).startsWith('That space is not yours'),
			outcome(await first.channel.run(childToken, { op: 'launchAgent', agent: 'claude' })).startsWith('You were started by another agent'),
			outcome(await first.channel.run(childToken, { op: 'createSpace', prompt: 'x' })).startsWith('You were started by another agent'),
			(await first.channel.run(first.sameSpace.token, { op: 'closeTerminal', terminal: child })).ok,
			// 再読み込みの後も、作ったことと子であることは残っている
			outcome(await reloaded.channel.run(childToken, { op: 'launchAgent', agent: 'claude' })).startsWith('You were started by another agent'),
			outcome(await reloaded.channel.run(reloaded.caller.token, { op: 'closeTerminal', terminal: child })),
			first.notifications.length,
		], [true, true, true, false, true, 'ok', 1]);
	});

	test('the number of terminals an agent creates is limited', async () => {
		const { channel, caller } = setup();
		const results: boolean[] = [];
		for (let index = 0; index < 6; index++) {
			results.push((await channel.run(caller.token, { op: 'launchAgent', agent: 'claude' })).ok);
		}
		assert.deepStrictEqual(results, [true, true, true, true, true, false]);
	});

	test('a space the caller created is reachable with the space scope, and removal asks the user as an agent request', async () => {
		const { channel, caller, otherSpace, commands } = setup();
		const setupRefused = (await channel.run(caller.token, { op: 'createSpace', prompt: 'x', runSetup: true })).ok;
		const created = await channel.run(caller.token, { op: 'createSpace', prompt: 'fix the login bug', agent: 'claude', runSetup: false });
		assert.ok(created.ok);
		const data = created.data as { space: string; agent_terminal: string };
		assert.deepStrictEqual([
			setupRefused,
			data.space,
			outcome(await channel.run(caller.token, { op: 'sendInput', terminal: data.agent_terminal, text: 'status?' })),
			(await channel.run(caller.token, { op: 'sendInput', terminal: id(otherSpace), text: 'x' })).ok,
			(await channel.run(caller.token, { op: 'removeSpace', space: WORKTREE_KEY })).ok,
			commands.length,
		], [false, NEW_WORKTREE_KEY, 'ok', false, false, 0]);
	});
});
