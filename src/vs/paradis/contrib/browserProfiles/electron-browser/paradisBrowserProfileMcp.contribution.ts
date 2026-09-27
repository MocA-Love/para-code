/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// MCP ツール `open_browser_profile` の受け口（renderer 側）。
//
// shared process の ParadisAgentBrowserService が「呼び出し元ペインを所有するウィンドウ」だけへ
// ルーティングして呼ぶ。ただし1つのウィンドウの中には複数のスペースがあるので、ここで
// 「呼び出し元ペインが属するスペース」を解いて、そのスペースのエディタ領域へ開く。解決手順は
// paradisAgentPreview.contribution.ts と同じ形にしてある（あちらが正、こちらは踏襲）。
//
// `preview_file` との違いは、非表示スペースのときに**予約しない**こと。このツールの目的は
// 「開いたページをこのペインへ共有して、そのまま chrome-devtools 系ツールで操作させる」なので、
// 後からユーザーが戻ってきたときに開いても、エージェントはもうそこにいない。開けないことを
// その場で伝える方が誠実。

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { BrowserViewStorageScope, isBrowserViewStorageScopeShareableWithAgent } from '../../../../platform/browserView/common/browserView.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentNetworkFilterService } from '../../../../platform/networkFilter/common/networkFilterService.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisAgentBrowserBindingModel } from '../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import {
	IParadisAuxiliaryWindowScopeService,
	IParadisTerminalScopeService,
	IParadisWorkspaceSwitchService,
	IParadisWorktreeService,
	paradisListSpaces,
} from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisAgentBrowserTabsService } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import {
	IParadisAgentProfileInfo,
	IParadisListProfilesResult,
	IParadisManageProfileResult,
	IParadisOpenProfileResult,
	IParadisSwitchProfileResult,
	PARADIS_AGENT_CREATED_PROFILE_LIMIT,
	PARADIS_BROWSER_PROFILE_MCP_CHANNEL,
	PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD,
	PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD,
	PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD,
	PARADIS_BROWSER_PROFILE_MCP_METHOD,
	PARADIS_BROWSER_PROFILE_MCP_SWITCH_METHOD,
} from '../common/paradisBrowserProfileMcp.js';
import { PARADIS_BROWSER_PROFILE_COLORS, paradisIsDuplicateProfileName, paradisNormalizeProfileName } from '../common/paradisBrowserProfileModel.js';
import { IParadisBrowserProfilesService } from './paradisBrowserProfilesService.js';

/** 呼び出し元ペインから決まる、ページを開く先。 */
type ParadisProfileTargetSpace =
	| { readonly kind: 'space'; readonly stateKey: string }
	| { readonly kind: 'active' }
	| { readonly kind: 'unresolved' };

export class ParadisBrowserProfileMcpChannel extends Disposable implements IServerChannel {

	constructor(
		private readonly profilesService: IParadisBrowserProfilesService,
		private readonly bindingModel: IParadisAgentBrowserBindingModel,
		private readonly editorGroupsService: IEditorGroupsService,
		private readonly paneTokenService: IParadisPaneTokenService,
		private readonly terminalScopeService: IParadisTerminalScopeService,
		private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		private readonly worktreeService: IParadisWorktreeService,
		private readonly auxiliaryWindowScopeService: IParadisAuxiliaryWindowScopeService,
		private readonly agentNetworkFilterService: IAgentNetworkFilterService,
		private readonly logService: ILogService,
		private readonly agentTabsService: IParadisAgentBrowserTabsService,
		private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
	) {
		super();
	}

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		const token = typeof args[0] === 'string' ? args[0] : undefined;
		const text = (index: number) => typeof args[index] === 'string' ? args[index] as string : undefined;
		switch (command) {
			case PARADIS_BROWSER_PROFILE_MCP_METHOD:
				return this._openBrowserProfile(token, text(1) ?? '', text(2)) as Promise<T>;
			case PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD:
				return this._listProfiles() as Promise<T>;
			case PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD:
				return this._createProfile(text(1) ?? '', text(2)) as Promise<T>;
			case PARADIS_BROWSER_PROFILE_MCP_SWITCH_METHOD:
				return this._switchProfile(token, text(1) ?? '', text(2)) as Promise<T>;
			case PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD:
				return this._deleteProfile(token, text(1) ?? '') as Promise<T>;
		}
		throw new Error(`Method not found: ${command}`);
	}

	private async _openBrowserProfile(token: string | undefined, profileName: string, url: string | undefined): Promise<IParadisOpenProfileResult> {
		// 切り替えの最中は、どちらのスペースへ属させてもタブの所属が不定になる。開かずに再試行させる。
		if (this.workspaceSwitchService.isSwitching) {
			return { ok: false, reason: 'switching' };
		}
		if (!this.profilesService.canUseProfiles()) {
			return { ok: false, reason: 'untrustedWorkspace' };
		}
		// 名前 → ID の解決は台帳が持つ（NFKC + caseless 一致）。エージェントが送ってくる名前は
		// 大小文字や全角半角が揺れる。
		const profile = this.profilesService.findByName(profileName);
		if (!profile) {
			return { ok: false, reason: 'unknownProfile' };
		}
		// エージェント向けネットワークフィルタが有効な間、upstream はフィルタを強制しない保存スコープ
		// （名前付きプロファイルを含む）を共有不可と判定する。そのまま共有に進むと upstream は確認
		// モーダルを出して Cookie の無い Agent スコープのタブを開き直し、こちらはそれへバインドして
		// 「ログイン状態を復元した」と答えてしまう。開く前に構造化した失敗で断る。
		if (!isBrowserViewStorageScopeShareableWithAgent(BrowserViewStorageScope.Profile, this.agentNetworkFilterService.isEnabled())) {
			return { ok: false, reason: 'profileNotShareable' };
		}

		const target = this._resolvePaneTarget(token);
		if (target.kind === 'unresolved') {
			return { ok: false, reason: 'paneUnresolved' };
		}
		const stateKey = target.kind === 'space' ? target.stateKey : this.workspaceSwitchService.activeStateKey;

		let group: IEditorGroup | undefined;
		if (stateKey === undefined) {
			// スペース管理下に無いウィンドウ。振り分ける相手がいないのでメインの領域へ開く。
			group = this.editorGroupsService.mainPart.activeGroup;
		} else {
			group = this._resolveVisibleGroup(stateKey);
			if (!group) {
				return this._spaceName(stateKey) === undefined
					? { ok: false, reason: 'unreachableSpace' }
					: { ok: false, reason: 'spaceNotVisible' };
			}
		}

		// 開く前に Cookie の有無を見ておく。開いた後だとそのページ自身が置いた Cookie が混ざり、
		// 「ログイン状態が復元された」かどうかを誤って答えてしまう。
		const stats = await this.profilesService.getProfileStats(profile.id);
		const restored = (stats.cookieCount ?? 0) > 0;

		// エージェントが開くタブなので、open_browser_tab と同じ上限と台帳に載せる（自分で閉じられるように）。
		const slot = token !== undefined ? this.agentTabsService.reserveSlot(token) : undefined;
		if (token !== undefined && !slot) {
			return { ok: false, reason: 'limitReached' };
		}
		let input: BrowserEditorInput | undefined;
		try {
			input = await this.profilesService.openInProfile(profile.id, url, group);
			if (input && token !== undefined) {
				this.agentTabsService.registerAgentTab(token, input);
			}
		} finally {
			slot?.dispose();
		}
		if (!input) {
			this.logService.warn('[ParadisBrowserProfileMcp] could not open a page in the requested profile');
			return { ok: false, reason: 'openFailed' };
		}

		// 共有（bind）はここまでの成功とは独立に扱う。ページは既に開いており、共有だけ失敗した
		// 場合に「開けなかった」と答えるとエージェントが開き直して無限にタブが増える。
		let bound = false;
		try {
			const model = await input.resolve();
			// 開いている間にフィルタが有効化された場合も、差し替えタブへのバインドへ進ませない
			// （上の事前判定と同じ理由。ページは開けているので bound: false で返す）。
			if (token !== undefined && model && model.isDirectlyShareable) {
				bound = await this.agentTabsService.bindTab(token, input);
			}
		} catch (error) {
			this.logService.warn('[ParadisBrowserProfileMcp] opened the page but could not share it with the calling pane', error);
		}

		return { ok: true, profileName: profile.name, restored, bound, tabId: input.id };
	}

	// #region 一覧・作成・切替・削除（計画書 B9）

	private async _listProfiles(): Promise<IParadisListProfilesResult> {
		const profiles: IParadisAgentProfileInfo[] = [];
		for (const profile of this.profilesService.list()) {
			const stats = await this.profilesService.getProfileStats(profile.id);
			profiles.push({
				name: profile.name,
				createdByAgent: profile.createdByAgent === true,
				hasStoredLogin: stats.cookieCount === undefined ? undefined : stats.cookieCount > 0,
				lastUsed: new Date(profile.lastUsedAt).toISOString(),
			});
		}
		return {
			ok: true,
			profiles,
			usable: this.profilesService.canUseProfiles(),
			shareable: isBrowserViewStorageScopeShareableWithAgent(BrowserViewStorageScope.Profile, this.agentNetworkFilterService.isEnabled()),
		};
	}

	private async _createProfile(name: string, color: string | undefined): Promise<IParadisManageProfileResult<{ readonly profileName: string }>> {
		if (!this.profilesService.canUseProfiles()) {
			return { ok: false, reason: 'untrustedWorkspace' };
		}
		const normalized = paradisNormalizeProfileName(name);
		if (!normalized) {
			return { ok: false, reason: 'invalidName' };
		}
		const profiles = this.profilesService.list();
		if (paradisIsDuplicateProfileName(profiles, normalized)) {
			return { ok: false, reason: 'duplicateName' };
		}
		if (profiles.filter(profile => profile.createdByAgent).length >= PARADIS_AGENT_CREATED_PROFILE_LIMIT) {
			return { ok: false, reason: 'tooManyProfiles' };
		}
		// 色はエージェントに選ばせない（ユーザーが見分けるための印）。まだ使われていない色から順に割り当てる。
		const used = new Set(profiles.map(profile => profile.color));
		const requested = color && PARADIS_BROWSER_PROFILE_COLORS.includes(color) ? color : undefined;
		const assigned = requested ?? PARADIS_BROWSER_PROFILE_COLORS.find(candidate => !used.has(candidate)) ?? PARADIS_BROWSER_PROFILE_COLORS[profiles.length % PARADIS_BROWSER_PROFILE_COLORS.length];
		const created = this.profilesService.create(normalized, assigned, { createdByAgent: true });
		return created.ok ? { ok: true, profileName: created.profile.name } : { ok: false, reason: 'invalidName' };
	}

	/**
	 * エージェントが開いたタブを別のプロファイルで開き直す。Electron のセッションはビューの作成時に
	 * 固定されるので、切替は「同じ位置へ新しいタブを差し込み古いタブを閉じる」作り直しになる
	 * （プロファイルのピルから切り替えたときと同じ）。ユーザーのタブは対象にしない。
	 */
	private async _switchProfile(token: string | undefined, profileName: string, tabId: string | undefined): Promise<IParadisSwitchProfileResult> {
		if (token === undefined) {
			return { ok: false, reason: 'paneUnresolved' };
		}
		if (this.workspaceSwitchService.isSwitching) {
			return { ok: false, reason: 'switching' };
		}
		if (!this.profilesService.canUseProfiles()) {
			return { ok: false, reason: 'untrustedWorkspace' };
		}
		const profile = this.profilesService.findByName(profileName);
		if (!profile) {
			return { ok: false, reason: 'unknownProfile' };
		}
		if (!isBrowserViewStorageScopeShareableWithAgent(BrowserViewStorageScope.Profile, this.agentNetworkFilterService.isEnabled())) {
			return { ok: false, reason: 'profileNotShareable' };
		}
		const targetId = tabId ?? this.bindingModel.getBindingForToken(token)?.pageId;
		const input = targetId ? this.browserViewWorkbenchService.getKnownBrowserViews().get(targetId) : undefined;
		if (!input || !this.agentTabsService.isOpenedBy(token, input.id)) {
			return { ok: false, reason: 'notAgentTab' };
		}

		const stats = await this.profilesService.getProfileStats(profile.id);
		const restored = (stats.cookieCount ?? 0) > 0;
		const replacement = await this.profilesService.switchView(input, { kind: 'profile', profileId: profile.id });
		if (!replacement) {
			return { ok: false, reason: 'switchFailed' };
		}
		// 古いタブは閉じられて台帳から外れる。作り直したタブをエージェントのものとして載せ直す。
		this.agentTabsService.registerAgentTab(token, replacement);
		let bound = false;
		try {
			const model = await replacement.resolve();
			if (model.isDirectlyShareable) {
				bound = await this.agentTabsService.bindTab(token, replacement);
			}
		} catch (error) {
			this.logService.warn('[ParadisBrowserProfileMcp] switched the profile but could not share the new tab', error);
		}
		return { ok: true, profileName: profile.name, tabId: replacement.id, bound, restored };
	}

	private async _deleteProfile(token: string | undefined, profileName: string): Promise<IParadisManageProfileResult<{ readonly profileName: string }>> {
		if (token === undefined) {
			return { ok: false, reason: 'paneUnresolved' };
		}
		const profile = this.profilesService.findByName(profileName);
		if (!profile) {
			return { ok: false, reason: 'unknownProfile' };
		}
		if (profile.createdByAgent !== true) {
			return { ok: false, reason: 'notCreatedByAgent' };
		}
		// 削除はそのプロファイルのタブを全部閉じる。ユーザーや別のペインが使っているタブがあれば断る
		// （このウィンドウ以外で開いているタブも main が数えている）。
		const ownTabs = [...this.browserViewWorkbenchService.getKnownBrowserViews().keys()]
			.filter(viewId => this.profilesService.getProfileForView(viewId) === profile.id && this.agentTabsService.isOpenedBy(token, viewId)).length;
		const stats = await this.profilesService.getProfileStats(profile.id);
		if (stats.openViewCount > ownTabs) {
			return { ok: false, reason: 'inUse' };
		}
		await this.profilesService.remove(profile.id);
		return { ok: true, profileName: profile.name };
	}

	// #endregion

	/** 呼び出し元ペインから届け先を決める（paradisAgentPreview と同じ判断）。 */
	private _resolvePaneTarget(token: string | undefined): ParadisProfileTargetSpace {
		if (token === undefined) {
			return { kind: 'active' };
		}
		const instanceId = this.paneTokenService.getInstanceForToken(token);
		if (instanceId === undefined) {
			return { kind: 'unresolved' };
		}
		const recorded = this.terminalScopeService.getStateKeyForInstance(instanceId);
		if (recorded !== undefined) {
			return { kind: 'space', stateKey: recorded };
		}
		const scope = this.terminalScopeService.resolveScope(instanceId);
		return scope.kind === 'managed'
			? { kind: 'space', stateKey: scope.stateKey }
			: scope.kind === 'unscoped' ? { kind: 'active' } : { kind: 'unresolved' };
	}

	/** そのスペースが今画面に出ているエディタ領域のグループ（無ければ undefined）。 */
	private _resolveVisibleGroup(stateKey: string): IEditorGroup | undefined {
		const parts: readonly IEditorPart[] = this.workspaceSwitchService.activeStateKey === stateKey
			? [this.editorGroupsService.mainPart]
			: [...this.auxiliaryWindowScopeService.getPinnedParts(stateKey)];
		if (!parts.length) {
			return undefined;
		}
		const partSet = new Set(parts);
		return this.editorGroupsService.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)
			.find(group => partSet.has(this.editorGroupsService.getPart(group)))
			?? parts[0].activeGroup;
	}

	/** スペースの表示名。切り替え先の一覧に無ければ undefined（＝もう到達できない）。 */
	private _spaceName(stateKey: string): string | undefined {
		return paradisListSpaces(this.workspaceSwitchService.repositories, this.worktreeService)
			.find(entry => entry.space === stateKey)?.name;
	}
}

class ParadisBrowserProfileMcpContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisBrowserProfileMcp';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IParadisBrowserProfilesService profilesService: IParadisBrowserProfilesService,
		@IParadisAgentBrowserBindingModel bindingModel: IParadisAgentBrowserBindingModel,
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@IParadisPaneTokenService paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalScopeService terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService worktreeService: IParadisWorktreeService,
		@IParadisAuxiliaryWindowScopeService auxiliaryWindowScopeService: IParadisAuxiliaryWindowScopeService,
		@IAgentNetworkFilterService agentNetworkFilterService: IAgentNetworkFilterService,
		@ILogService logService: ILogService,
		@IParadisAgentBrowserTabsService agentTabsService: IParadisAgentBrowserTabsService,
		@IBrowserViewWorkbenchService browserViewWorkbenchService: IBrowserViewWorkbenchService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_BROWSER_PROFILE_MCP_CHANNEL, this._register(new ParadisBrowserProfileMcpChannel(
			profilesService,
			bindingModel,
			editorGroupsService,
			paneTokenService,
			terminalScopeService,
			workspaceSwitchService,
			worktreeService,
			auxiliaryWindowScopeService,
			agentNetworkFilterService,
			logService,
			agentTabsService,
			browserViewWorkbenchService,
		)));
	}
}

registerWorkbenchContribution2(ParadisBrowserProfileMcpContribution.ID, ParadisBrowserProfileMcpContribution, WorkbenchPhase.AfterRestored);
