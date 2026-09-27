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
import { IParadisAgentBrowserTabsService, ParadisAgentApprovalChoice } from '../../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IParadisWorkspaceSwitchService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisListProfilesResult, IParadisManageProfileResult, IParadisOpenProfileResult, PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD, PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD, PARADIS_BROWSER_PROFILE_MCP_METHOD } from '../../common/paradisBrowserProfileMcp.js';
import { IParadisBrowserProfile } from '../../common/paradisBrowserProfileModel.js';
import { paradisAgentOwnerMark, ParadisBrowserProfileMcpChannel } from '../../electron-browser/paradisBrowserProfileMcp.contribution.js';
import { IParadisBrowserProfilesService, IParadisCreateProfileOptions } from '../../electron-browser/paradisBrowserProfilesService.js';

function profile(id: string, name: string, extra: Partial<IParadisBrowserProfile> = {}): IParadisBrowserProfile {
	return { id, name, color: '#3fb950', createdAt: 1, lastUsedAt: 2, ...extra };
}

function createChannel(profiles: IParadisBrowserProfile[], approval: ParadisAgentApprovalChoice | undefined) {
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
		reserveSlot: () => toDisposable(() => { }),
		registerAgentTab: () => { },
		bindTab: async () => true,
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

	test('lists only agent-made profiles by name and just counts the user profiles', async () => {
		const mine = paradisAgentOwnerMark('pane-a');
		const { channel } = createChannel([
			profile('a3f19c2b7e04', 'Personal Gmail'),
			profile('b1c2d3e4f506', 'agent-test', { createdByAgent: true, agentOwner: mine }),
			profile('c1c2d3e4f506', 'other-agent', { createdByAgent: true, agentOwner: paradisAgentOwnerMark('pane-b') }),
		], undefined);
		store.add(channel);
		const result = await channel.call<IParadisListProfilesResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD, ['pane-a']);
		assert.deepStrictEqual(
			[result.profiles.map(entry => [entry.name, entry.createdByYou]), result.userProfileCount],
			[[['agent-test', true], ['other-agent', false]], 1],
		);
	});

	test('opening a user profile needs approval, an agent-made one does not', async () => {
		const denied = createChannel([profile('a3f19c2b7e04', 'PRD'), profile('b1c2d3e4f506', 'TEST', { createdByAgent: true })], undefined);
		store.add(denied.channel);
		const userResult = await denied.channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD'], CancellationToken.None);
		const agentResult = await denied.channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'TEST'], CancellationToken.None);
		assert.deepStrictEqual(
			[userResult, agentResult.ok, denied.calls],
			[{ ok: false, reason: 'denied' }, true, ['ask', 'open:b1c2d3e4f506']],
		);

		const approved = createChannel([profile('a3f19c2b7e04', 'PRD')], 'approve');
		store.add(approved.channel);
		const approvedResult = await approved.channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD'], CancellationToken.None);
		assert.deepStrictEqual([approvedResult.ok, approved.calls], [true, ['ask', 'open:a3f19c2b7e04']]);
	});

	test('rejects non-http URLs before asking anything', async () => {
		const { channel, calls } = createChannel([profile('a3f19c2b7e04', 'PRD')], 'approve');
		store.add(channel);
		const result = await channel.call<IParadisOpenProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_METHOD, ['pane-a', 'PRD', 'file:///etc/passwd'], CancellationToken.None);
		assert.deepStrictEqual([result, calls], [{ ok: false, reason: 'invalidUrl' }, []]);
	});

	test('only the pane that created a profile can delete it, and never a user profile', async () => {
		const { channel, calls, profiles } = createChannel([profile('a3f19c2b7e04', 'USER')], undefined);
		store.add(channel);
		const created = await channel.call<IParadisManageProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD, ['pane-a', 'scratch']);
		const results = [
			await channel.call<IParadisManageProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, ['pane-a', 'USER']),
			await channel.call<IParadisManageProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, ['pane-b', 'scratch']),
			(await channel.call<IParadisManageProfileResult>(undefined, PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD, ['pane-a', 'scratch'])).ok,
		];
		assert.deepStrictEqual(
			[created.ok, profiles[1].agentOwner === paradisAgentOwnerMark('pane-a'), results, calls],
			[true, true, [{ ok: false, reason: 'notCreatedByAgent' }, { ok: false, reason: 'notOwner' }, true], [`remove:${profiles[1].id}`]],
		);
	});
});
