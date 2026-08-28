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
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
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
import {
	IParadisOpenProfileResult,
	PARADIS_BROWSER_PROFILE_MCP_CHANNEL,
	PARADIS_BROWSER_PROFILE_MCP_METHOD,
} from '../common/paradisBrowserProfileMcp.js';
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
		private readonly logService: ILogService,
	) {
		super();
	}

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		if (command === PARADIS_BROWSER_PROFILE_MCP_METHOD) {
			const args = Array.isArray(arg) ? arg : [];
			const token = typeof args[0] === 'string' ? args[0] : undefined;
			const profileName = typeof args[1] === 'string' ? args[1] : '';
			const url = typeof args[2] === 'string' ? args[2] : undefined;
			return this._openBrowserProfile(token, profileName, url) as Promise<T>;
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

		const input = await this.profilesService.openInProfile(profile.id, url, group);
		if (!input) {
			this.logService.warn('[ParadisBrowserProfileMcp] could not open a page in the requested profile');
			return { ok: false, reason: 'openFailed' };
		}

		// 共有（bind）はここまでの成功とは独立に扱う。ページは既に開いており、共有だけ失敗した
		// 場合に「開けなかった」と答えるとエージェントが開き直して無限にタブが増える。
		let bound = false;
		try {
			const model = await input.resolve();
			if (token !== undefined && model) {
				bound = await this.bindingModel.bindPageToPane(model, token);
			}
		} catch (error) {
			this.logService.warn('[ParadisBrowserProfileMcp] opened the page but could not share it with the calling pane', error);
		}

		return { ok: true, profileName: profile.name, restored, bound };
	}

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
		@ILogService logService: ILogService,
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
			logService,
		)));
	}
}

registerWorkbenchContribution2(ParadisBrowserProfileMcpContribution.ID, ParadisBrowserProfileMcpContribution, WorkbenchPhase.AfterRestored);
