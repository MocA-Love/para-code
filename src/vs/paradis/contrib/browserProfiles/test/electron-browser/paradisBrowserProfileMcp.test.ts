/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IAgentNetworkFilterService } from '../../../../../platform/networkFilter/common/networkFilterService.js';
import { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorGroup } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisAgentBrowserBindingModel } from '../../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisAgentBrowserTabsService, ParadisAgentApprovalOutcome } from '../../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IParadisWorkspaceSwitchService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisDeleteProfileResult, IParadisListProfilesResult, IParadisManageProfileResult, IParadisOpenProfileResult, PARADIS_AGENT_CREATED_PROFILE_LIMIT, PARADIS_BROWSER_PROFILE_ACCESS_SETTING, paradisReadProfileAccess, PARADIS_AGENT_CREATED_PROFILE_TOTAL_LIMIT, PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD, PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD, PARADIS_BROWSER_PROFILE_MCP_METHOD, paradisDeletedProfileMessage } from '../../common/paradisBrowserProfileMcp.js';
import { IParadisBrowserProfile } from '../../common/paradisBrowserProfileModel.js';
import { paradisAgentOwnerMark, ParadisBrowserProfileMcpChannel } from '../../electron-browser/paradisBrowserProfileMcp.contribution.js';
import { IParadisBrowserProfilesService, IParadisCreateProfileOptions } from '../../electron-browser/paradisBrowserProfilesService.js';

function profile(id: string, name: string, extra: Partial<IParadisBrowserProfile> = {}): IParadisBrowserProfile {
	return { id, name, color: '#3fb950', createdAt: 1, lastUsedAt: 2, ...extra };
}

interface IChannelOptions {
	/** 許可の設定（既定は ask: 今までどおり毎回聞く）。 */
	readonly access?: string;
	/** 「今後は聞かない」で許可を残したプロファイルの ID。 */
	readonly allowed?: Set<string>;
	/** ペインのスペースが画面に出ていない。 */
	readonly hidden?: boolean;
	/** ネットワークの制限が有効。 */
	readonly networkFilter?: boolean;
	/** 開いているタブ（openedBy はそのタブを開いたペイン。無ければ利用者のタブ）。 */
	readonly tabs?: readonly { readonly id: string; readonly profileId: string; readonly openedBy?: string }[];
}

/** `onStats` は main へ数を聞いている間に起きることを差し込む口。 */
function createChannel(profiles: IParadisBrowserProfile[], approval: ParadisAgentApprovalOutcome, slotAvailable = true, onStats?: () => void, shareWarning?: string, options: IChannelOptions = {}) {
	const calls: string[] = [];
	const registrations: string[] = [];
	const allowed = options.allowed ?? new Set<string>();
	const tabs = options.tabs ?? [];
	const profilesService = {
		isAgentAllowed: (id: string) => allowed.has(id),
		setAgentAllowed: (id: string, value: boolean) => { calls.push(`allow:${id}:${value}`); if (value) { allowed.add(id); } else { allowed.delete(id); } },
		createInProfile: (id: string, url?: string) => { calls.push(`create:${id}:${url ?? ''}`); return { id: 'view-hidden', resolve: async () => ({ isDirectlyShareable: true }), dispose: () => calls.push('dispose') } as unknown as BrowserEditorInput; },
		list: () => profiles,
		findByName: (name: string) => profiles.find(candidate => candidate.name === name),
		canUseProfiles: () => true,
		getProfileStats: async (id: string) => { onStats?.(); return { cookieCount: 3, openViewCount: tabs.filter(tab => tab.profileId === id).length }; },
		getProfileForView: (viewId: string) => tabs.find(tab => tab.id === viewId)?.profileId,
		create: (name: string, color: string, options?: IParadisCreateProfileOptions) => {
			const created = profile(`00000000000${profiles.length}`, name, { color, ...(options?.createdByAgent ? { createdByAgent: true, agentOwner: options.agentOwner } : {}) });
			profiles.push(created);
			return { ok: true, profile: created };
		},
		remove: async (id: string) => { calls.push(`remove:${id}`); },
		openInProfile: async (id: string) => { calls.push(`open:${id}`); return { id: 'view-1', resolve: async () => ({ isDirectlyShareable: true }) } as unknown as BrowserEditorInput; },
	} as unknown as IParadisBrowserProfilesService;
	const agentTabsService = {
		resolveTarget: () => ({ ok: true, group: {} as IEditorGroup }),
		resolveOpenTarget: () => options.hidden ? { ok: true, kind: 'hidden', stateKey: 'space-b' } : { ok: true, kind: 'visible', group: {} as IEditorGroup },
		keepTabForHiddenSpace: async (_token: string, input: BrowserEditorInput, stateKey: string) => { calls.push(`keep:${input.id}:${stateKey}`); },
		askApproval: async (_token: string, request: { readonly detail: readonly string[]; readonly alternativeLabel?: string }) => {
			calls.push((shareWarning !== undefined && request.detail.includes(shareWarning) ? 'ask-with-warning' : 'ask') + (request.alternativeLabel !== undefined ? '+remember' : ''));
			return approval;
		},
		reserveSlot: () => slotAvailable ? toDisposable(() => { }) : undefined,
		registerAgentTab: (token: string, input: BrowserEditorInput, options?: { readonly approvedProfile?: boolean }) => { registrations.push(`${token}:${input.id}:${options?.approvedProfile === true ? 'approved-profile' : 'own'}`); },
		bindTab: async () => true,
		bindTabWithin: async () => true,
		isOpenedBy: (token: string, viewId: string) => tabs.some(tab => tab.id === viewId && tab.openedBy === token),
	} as unknown as IParadisAgentBrowserTabsService;
	const channel = new ParadisBrowserProfileMcpChannel(
		profilesService,
		{ getBindingForToken: () => undefined } as unknown as IParadisAgentBrowserBindingModel,
		{ isSwitching: false } as unknown as IParadisWorkspaceSwitchService,
		{ isEnabled: () => options.networkFilter === true } as unknown as IAgentNetworkFilterService,
		new NullLogService(),
		agentTabsService,
		{ getKnownBrowserViews: () => new Map(tabs.map(tab => [tab.id, {}])) } as unknown as IBrowserViewWorkbenchService,
		{ getShareWarning: async () => shareWarning },
		{ getValue: (key?: unknown) => key === PARADIS_BROWSER_PROFILE_ACCESS_SETTING ? options.access ?? 'ask' : undefined } as unknown as IConfigurationService,
	);
	return { channel, calls, profiles, registrations };
}

suite('ParadisBrowserProfileMcpChannel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('lists by name only the profiles this pane created and just counts the rest', async () => {
		const mine = paradisAgentOwnerMark('pane-a');
		const { channel } = createChannel([
			profile('a3f19c2b7e04', 'Personal Gmail'),
			profile('b1c2d3e4f506', 'agent-test', { createdByAgent: true, agentOwner: mine }),
			profile('c1c2d3e4f506', 'other-agent', { createdByAgent: true, agentOwner: paradisAgentOwnerMark('pane-b') }),
		], 'denied');
		store.add(channel);
		const result = await channel.call<IParadisListProfilesResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD, ['pane-a']);
		assert.deepStrictEqual(
			[result.profiles.map(entry => [entry.name, entry.createdByYou]), result.hiddenProfileCount],
			[[['agent-test', true]], 2],
		);
	});

	test('a profile of the user or of another pane needs approval, one made by this pane does not', async () => {
		const denied = createChannel([
			profile('a3f19c2b7e04', 'PRD'),
			profile('b1c2d3e4f506', 'TEST', { createdByAgent: true, agentOwner: paradisAgentOwnerMark('pane-a') }),
			profile('c1c2d3e4f506', 'OTHER', { createdByAgent: true, agentOwner: paradisAgentOwnerMark('pane-b') }),
		], 'denied');
		store.add(denied.channel);
		const userResult = await denied.channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD'], CancellationToken.None);
		const otherPaneResult = await denied.channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'OTHER'], CancellationToken.None);
		const ownResult = await denied.channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'TEST'], CancellationToken.None);
		assert.deepStrictEqual(
			[userResult, otherPaneResult, ownResult.ok, denied.calls],
			[{ ok: false, reason: 'denied' }, { ok: false, reason: 'denied' }, true, ['ask', 'ask', 'open:b1c2d3e4f506']],
		);

		const approved = createChannel([profile('a3f19c2b7e04', 'PRD')], 'approve');
		store.add(approved.channel);
		const approvedResult = await approved.channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD'], CancellationToken.None);
		assert.deepStrictEqual([approvedResult.ok, approved.calls], [true, ['ask', 'open:a3f19c2b7e04']]);

		const busy = createChannel([profile('a3f19c2b7e04', 'PRD')], 'busy');
		store.add(busy.channel);
		assert.deepStrictEqual(await busy.channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD'], CancellationToken.None), { ok: false, reason: 'alreadyPending' });
	});

	test('a profile this pane made opens without asking even when it has browser extensions enabled', async () => {
		const channel = createChannel([
			profile('b1c2d3e4f506', 'TEST', { createdByAgent: true, agentOwner: paradisAgentOwnerMark('pane-a') }),
		], 'denied', true, undefined, 'extension warning');
		store.add(channel.channel);
		const own = await channel.channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'TEST'], CancellationToken.None);
		assert.deepStrictEqual([own.ok, channel.calls], [true, ['open:b1c2d3e4f506']]);
	});

	// ユーザーのプロファイルのタブは、ユーザーが共有を止めたら台帳から外れる印付きで載る（M22）。
	test('marks a tab of an approved user profile, but not one of a profile this pane made', async () => {
		const user = createChannel([profile('a3f19c2b7e04', 'PRD')], 'approve');
		store.add(user.channel);
		await user.channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD'], CancellationToken.None);
		const own = createChannel([profile('b1c2d3e4f506', 'TEST', { createdByAgent: true, agentOwner: paradisAgentOwnerMark('pane-a') })], 'denied');
		store.add(own.channel);
		await own.channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'TEST'], CancellationToken.None);
		assert.deepStrictEqual([user.registrations, own.registrations], [['pane-a:view-1:approved-profile'], ['pane-a:view-1:own']]);
	});

	test('rejects non-http URLs before asking anything', async () => {
		const { channel, calls } = createChannel([profile('a3f19c2b7e04', 'PRD')], 'approve');
		store.add(channel);
		const result = await channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD', 'file:///etc/passwd'], CancellationToken.None);
		assert.deepStrictEqual([result, calls], [{ ok: false, reason: 'invalidUrl' }, []]);
	});

	test('only the pane that created a profile can delete it; other names get the same answer as a missing one', async () => {
		const { channel, calls, profiles } = createChannel([profile('a3f19c2b7e04', 'USER')], 'denied');
		store.add(channel);
		const created = await channel.call<IParadisManageProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD, ['pane-a', 'scratch']);
		const results = [
			await channel.call<IParadisManageProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, ['pane-a', 'USER']),
			await channel.call<IParadisManageProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, ['pane-a', 'NOPE']),
			await channel.call<IParadisManageProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, ['pane-b', 'scratch']),
			(await channel.call<IParadisManageProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, ['pane-a', 'scratch'])).ok,
		];
		assert.deepStrictEqual(
			[created.ok, profiles[1].agentOwner === paradisAgentOwnerMark('pane-a'), results, calls],
			[true, true, [{ ok: false, reason: 'unknownProfile' }, { ok: false, reason: 'unknownProfile' }, { ok: false, reason: 'unknownProfile' }, true], [`remove:${profiles[1].id}`]],
		);
	});

	test('deleting a profile names the tabs of this pane it closed, and is refused while the user has a tab in it', async () => {
		const own = () => profile('b1c2d3e4f506', 'scratch', { createdByAgent: true, agentOwner: paradisAgentOwnerMark('pane-a') });
		const ownTabs = [
			{ id: 'view-1', profileId: 'b1c2d3e4f506', openedBy: 'pane-a' },
			{ id: 'view-2', profileId: 'b1c2d3e4f506', openedBy: 'pane-a' },
			{ id: 'view-3', profileId: 'other-profile', openedBy: 'pane-a' },
		];
		const withUserTab = [
			{ id: 'view-1', profileId: 'b1c2d3e4f506', openedBy: 'pane-a' },
			{ id: 'view-4', profileId: 'b1c2d3e4f506' },
		];
		const mine = createChannel([own()], 'denied', true, undefined, undefined, { tabs: ownTabs });
		store.add(mine.channel);
		const userTab = createChannel([own()], 'denied', true, undefined, undefined, { tabs: withUserTab });
		store.add(userTab.channel);
		const deleted = await mine.channel.call<IParadisDeleteProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, ['pane-a', 'scratch']);
		const refused = await userTab.channel.call<IParadisDeleteProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, ['pane-a', 'scratch']);
		assert.deepStrictEqual([deleted, refused, userTab.calls], [
			{ ok: true, profileName: 'scratch', closedTabIds: ['view-1', 'view-2'] },
			{ ok: false, reason: 'inUse' },
			[],
		]);
	});

	test('the answer of delete_browser_profile lists the closed tabs so the agent stops using them', () => {
		assert.deepStrictEqual([
			paradisDeletedProfileMessage('scratch', []),
			paradisDeletedProfileMessage('scratch', ['view-1']),
			paradisDeletedProfileMessage('scratch', ['view-1', 'view-2']),
		], [
			'Deleted the "scratch" browser profile and its stored data.',
			'Deleted the "scratch" browser profile and its stored data. Closed your tab in that profile: view-1. That tabId no longer works; use list_browser_tabs to see the tabs you still have.',
			'Deleted the "scratch" browser profile and its stored data. Closed your tabs in that profile: view-1, view-2. Those tabIds no longer work; use list_browser_tabs to see the tabs you still have.',
		]);
	});

	// main へ開いているタブの数を聞いている間に、ユーザーが自分用として使い始めたら消さない（A61）。
	test('does not delete a profile the user claimed while the open tabs were being counted', async () => {
		const profiles = [profile('b1c2d3e4f506', 'scratch', { createdByAgent: true, agentOwner: paradisAgentOwnerMark('pane-a') })];
		const { channel, calls } = createChannel(profiles, 'denied', true, () => { profiles[0] = profile('b1c2d3e4f506', 'scratch'); });
		store.add(channel);
		const result = await channel.call<IParadisManageProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, ['pane-a', 'scratch']);
		assert.deepStrictEqual([result, calls], [{ ok: false, reason: 'unknownProfile' }, []]);
	});

	test('checks the tab limit before asking for approval', async () => {
		const { channel, calls } = createChannel([profile('a3f19c2b7e04', 'PRD')], 'approve', false);
		store.add(channel);
		const result = await channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD'], CancellationToken.None);
		assert.deepStrictEqual([result, calls], [{ ok: false, reason: 'limitReached' }, []]);
	});

	test('counts the profile limit per pane, so profiles left by an earlier pane do not block a new one', async () => {
		const orphaned = Array.from({ length: PARADIS_AGENT_CREATED_PROFILE_LIMIT }, (_, index) => profile(`0000000000a${index}`, `old-${index}`, { createdByAgent: true, agentOwner: paradisAgentOwnerMark('restarted-pane') }));
		const { channel } = createChannel(orphaned, 'denied');
		store.add(channel);
		const results: (string | undefined)[] = [];
		for (let index = 0; index <= PARADIS_AGENT_CREATED_PROFILE_LIMIT; index++) {
			const result = await channel.call<IParadisManageProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD, ['pane-a', `new-${index}`]);
			results.push(result.ok ? undefined : result.reason);
		}
		assert.deepStrictEqual(results, [...Array.from({ length: PARADIS_AGENT_CREATED_PROFILE_LIMIT }, () => undefined), 'tooManyProfiles']);
	});

	test('stops agents from creating profiles once agent-made profiles reach the overall cap', async () => {
		const orphaned = Array.from({ length: PARADIS_AGENT_CREATED_PROFILE_TOTAL_LIMIT }, (_, index) => profile(`0000000000b${index}`, `old-${index}`, { createdByAgent: true, agentOwner: paradisAgentOwnerMark(`restarted-pane-${index % 5}`) }));
		const { channel } = createChannel(orphaned, 'denied');
		store.add(channel);
		assert.deepStrictEqual(
			await channel.call<IParadisManageProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD, ['pane-a', 'new']),
			{ ok: false, reason: 'tooManyAgentProfiles' },
		);
	});

	test('creating a profile with a taken or empty name gets one answer, so user profile names cannot be probed', async () => {
		const { channel } = createChannel([profile('a3f19c2b7e04', 'Personal Gmail')], 'denied');
		store.add(channel);
		assert.deepStrictEqual([
			await channel.call<IParadisManageProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD, ['pane-a', 'personal gmail']),
			await channel.call<IParadisManageProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD, ['pane-a', '   ']),
		], [{ ok: false, reason: 'invalidName' }, { ok: false, reason: 'invalidName' }]);
	});

	// 許可の設定 3 つ × 許可を残したか（Q670）。ask は残した許可を見ず、「今後は聞かない」も出さない。
	test('the access setting decides whether a user profile is opened without asking', async () => {
		const outcomes: Record<string, [boolean, string[]]> = {};
		for (const access of ['ask', 'remembered', 'all']) {
			for (const remembered of [false, true]) {
				const { channel, calls } = createChannel([profile('a3f19c2b7e04', 'PRD')], 'denied', true, undefined, undefined, { access, allowed: new Set(remembered ? ['a3f19c2b7e04'] : []) });
				store.add(channel);
				const result = await channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD'], CancellationToken.None);
				outcomes[`${access}/${remembered ? 'allowed' : 'not allowed'}`] = [result.ok, calls];
			}
		}
		assert.deepStrictEqual(outcomes, {
			'ask/not allowed': [false, ['ask']],
			'ask/allowed': [false, ['ask']],
			'remembered/not allowed': [false, ['ask+remember']],
			'remembered/allowed': [true, ['open:a3f19c2b7e04']],
			'all/not allowed': [true, ['open:a3f19c2b7e04']],
			'all/allowed': [true, ['open:a3f19c2b7e04']],
		});
	});

	test('"do not ask again" keeps the permission for that profile, so the next call opens it without a dialog', async () => {
		const first = createChannel([profile('a3f19c2b7e04', 'PRD')], 'alternative', true, undefined, undefined, { access: 'remembered' });
		store.add(first.channel);
		const opened = await first.channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD'], CancellationToken.None);
		const again = await first.channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD'], CancellationToken.None);
		assert.deepStrictEqual([opened.ok, again.ok, first.calls], [true, true, ['ask+remember', 'allow:a3f19c2b7e04:true', 'open:a3f19c2b7e04', 'open:a3f19c2b7e04']]);
	});

	// 許可の設定 3 つ × 拡張機能の有無 × 許可を残したか。拡張機能があっても聞くかどうかは設定のとおりで、
	// 拡張機能の注意は聞くときの本文にだけ載る。
	test('browser extensions do not change whether a user profile is asked about, only what the dialog says', async () => {
		const outcomes: Record<string, string[]> = {};
		for (const access of ['ask', 'remembered', 'all']) {
			for (const extensions of [false, true]) {
				for (const remembered of [false, true]) {
					const { channel, calls } = createChannel([profile('a3f19c2b7e04', 'PRD')], 'denied', true, undefined, extensions ? 'extension warning' : undefined, { access, allowed: new Set(remembered ? ['a3f19c2b7e04'] : []) });
					store.add(channel);
					await channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD'], CancellationToken.None);
					outcomes[`${access}/${extensions ? 'extensions' : 'no extensions'}/${remembered ? 'allowed' : 'not allowed'}`] = calls;
				}
			}
		}
		assert.deepStrictEqual(outcomes, {
			'ask/no extensions/not allowed': ['ask'],
			'ask/no extensions/allowed': ['ask'],
			'ask/extensions/not allowed': ['ask-with-warning'],
			'ask/extensions/allowed': ['ask-with-warning'],
			'remembered/no extensions/not allowed': ['ask+remember'],
			'remembered/no extensions/allowed': ['open:a3f19c2b7e04'],
			'remembered/extensions/not allowed': ['ask-with-warning+remember'],
			'remembered/extensions/allowed': ['open:a3f19c2b7e04'],
			'all/no extensions/not allowed': ['open:a3f19c2b7e04'],
			'all/no extensions/allowed': ['open:a3f19c2b7e04'],
			'all/extensions/not allowed': ['open:a3f19c2b7e04'],
			'all/extensions/allowed': ['open:a3f19c2b7e04'],
		});
	});

	test('"do not ask again" on a profile with browser extensions keeps the permission, so the next call opens it without a dialog', async () => {
		const { channel, calls } = createChannel([profile('a3f19c2b7e04', 'PRD')], 'alternative', true, undefined, 'extension warning', { access: 'remembered' });
		store.add(channel);
		const opened = await channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD'], CancellationToken.None);
		const again = await channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD'], CancellationToken.None);
		assert.deepStrictEqual([opened.ok, again.ok, calls], [true, true, ['ask-with-warning+remember', 'allow:a3f19c2b7e04:true', 'open:a3f19c2b7e04', 'open:a3f19c2b7e04']]);
	});

	test('the network filter and an untrusted workspace still keep allowed profiles away from the agent', async () => {
		const filtered = createChannel([profile('a3f19c2b7e04', 'PRD')], 'approve', true, undefined, undefined, { access: 'all', networkFilter: true });
		store.add(filtered.channel);
		const result = await filtered.channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD'], CancellationToken.None);
		const list = await filtered.channel.call<IParadisListProfilesResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD, ['pane-a']);
		assert.deepStrictEqual([result, list.profiles, list.hiddenProfileCount, filtered.calls], [{ ok: false, reason: 'profileNotShareable' }, [], 1, []]);
	});

	test('lists the names of the user profiles the agent may use without asking, and only counts the rest', async () => {
		const profiles = () => [
			profile('a3f19c2b7e04', 'PRD'),
			profile('d1c2d3e4f506', 'Personal'),
			profile('b1c2d3e4f506', 'agent-test', { createdByAgent: true, agentOwner: paradisAgentOwnerMark('pane-a') }),
		];
		const listed: Record<string, [string[], number]> = {};
		for (const access of ['ask', 'remembered', 'all']) {
			const { channel } = createChannel(profiles(), 'denied', true, undefined, undefined, { access, allowed: new Set(['a3f19c2b7e04']) });
			store.add(channel);
			const result = await channel.call<IParadisListProfilesResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD, ['pane-a']);
			listed[access] = [result.profiles.map(entry => `${entry.name}${entry.createdByYou ? ' (yours)' : ''}`), result.hiddenProfileCount];
		}
		assert.deepStrictEqual(listed, {
			ask: [['agent-test (yours)'], 2],
			remembered: [['PRD', 'agent-test (yours)'], 1],
			all: [['PRD', 'Personal', 'agent-test (yours)'], 0],
		});
	});

	test('opens a profile in the space of the pane even while that space is not on screen', async () => {
		const { channel, calls, registrations } = createChannel([profile('a3f19c2b7e04', 'PRD')], 'approve', true, undefined, undefined, { access: 'all', hidden: true });
		store.add(channel);
		const result = await channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD', 'https://example.com/'], CancellationToken.None);
		assert.deepStrictEqual([result, calls, registrations], [
			{ ok: true, profileName: 'PRD', restored: true, bound: true, tabId: 'view-hidden', spaceNotVisible: true },
			['create:a3f19c2b7e04:https://example.com/', 'keep:view-hidden:space-b'],
			['pane-a:view-hidden:approved-profile'],
		]);
	});

	test('reads an unknown access value as the most careful one', () => {
		assert.deepStrictEqual(['ask', 'remembered', 'all', 'always', undefined].map(paradisReadProfileAccess), ['ask', 'remembered', 'all', 'ask', 'ask']);
	});
});
