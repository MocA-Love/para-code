/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IAgentNetworkFilterService } from '../../../../../platform/networkFilter/common/networkFilterService.js';
import { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorGroup } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisAgentBrowserBindingModel } from '../../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisAgentBrowserTabsService, ParadisAgentApprovalOutcome } from '../../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IParadisWorkspaceSwitchService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisListProfilesResult, IParadisManageProfileResult, IParadisOpenProfileResult, PARADIS_AGENT_CREATED_PROFILE_LIMIT, PARADIS_AGENT_CREATED_PROFILE_TOTAL_LIMIT, PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD, PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD, PARADIS_BROWSER_PROFILE_MCP_METHOD } from '../../common/paradisBrowserProfileMcp.js';
import { IParadisBrowserProfile } from '../../common/paradisBrowserProfileModel.js';
import { paradisAgentOwnerMark, ParadisBrowserProfileMcpChannel } from '../../electron-browser/paradisBrowserProfileMcp.contribution.js';
import { IParadisBrowserProfilesService, IParadisCreateProfileOptions } from '../../electron-browser/paradisBrowserProfilesService.js';

function profile(id: string, name: string, extra: Partial<IParadisBrowserProfile> = {}): IParadisBrowserProfile {
	return { id, name, color: '#3fb950', createdAt: 1, lastUsedAt: 2, ...extra };
}

function createChannel(profiles: IParadisBrowserProfile[], approval: ParadisAgentApprovalOutcome, slotAvailable = true) {
	const calls: string[] = [];
	const profilesService = {
		list: () => profiles,
		findByName: (name: string) => profiles.find(candidate => candidate.name === name),
		canUseProfiles: () => true,
		getProfileStats: async () => ({ cookieCount: 3, openViewCount: 0 }),
		getProfileForView: () => undefined,
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
		askApproval: async () => { calls.push('ask'); return approval; },
		reserveSlot: () => slotAvailable ? toDisposable(() => { }) : undefined,
		registerAgentTab: () => { },
		bindTab: async () => true,
		bindTabWithin: async () => true,
		isOpenedBy: () => false,
	} as unknown as IParadisAgentBrowserTabsService;
	const channel = new ParadisBrowserProfileMcpChannel(
		profilesService,
		{ getBindingForToken: () => undefined } as unknown as IParadisAgentBrowserBindingModel,
		{ isSwitching: false } as unknown as IParadisWorkspaceSwitchService,
		{ isEnabled: () => false } as unknown as IAgentNetworkFilterService,
		new NullLogService(),
		agentTabsService,
		{ getKnownBrowserViews: () => new Map() } as unknown as IBrowserViewWorkbenchService,
	);
	return { channel, calls, profiles };
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
});
