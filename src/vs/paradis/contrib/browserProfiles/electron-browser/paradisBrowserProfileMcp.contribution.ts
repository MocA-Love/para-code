/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// MCP ツール `open_browser_profile` と、プロファイルの一覧・作成・切替・削除の受け口（renderer 側）。
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
//
// ユーザーのプロファイル（ユーザーが作った、またはユーザーが自分で使った）と、別のペインが作った
// プロファイルはログイン状態を持ちうるので、エージェントが開く・切り替えるときはユーザーの承認を通し、
// 一覧では名前を伏せる。承認なしで使え、削除できるのは、そのペインが作りユーザーがまだ使っていないものだけ。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { BrowserViewStorageScope, isBrowserViewStorageScopeShareableWithAgent } from '../../../../platform/browserView/common/browserView.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentNetworkFilterService } from '../../../../platform/networkFilter/common/networkFilterService.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { paradisIsAllowedAgentTabUrl, paradisUrlOrigin } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';
import { IParadisAgentBrowserBindingModel } from '../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisAgentBrowserTabsService, ParadisApprovalDeadline } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisAgentProfileInfo,
	IParadisListProfilesResult,
	IParadisManageProfileResult,
	IParadisOpenProfileResult,
	IParadisSwitchProfileResult,
	PARADIS_AGENT_CREATED_PROFILE_LIMIT,
	PARADIS_AGENT_CREATED_PROFILE_TOTAL_LIMIT,
	PARADIS_BROWSER_PROFILE_MCP_CHANNEL,
	PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD,
	PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD,
	PARADIS_BROWSER_PROFILE_MCP_PANE_OWNED_METHOD,
	PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD,
	PARADIS_BROWSER_PROFILE_MCP_METHOD,
	PARADIS_BROWSER_PROFILE_MCP_SWITCH_METHOD,
} from '../common/paradisBrowserProfileMcp.js';
import { IParadisBrowserProfile, PARADIS_BROWSER_PROFILE_COLORS, paradisIsDuplicateProfileName, paradisNormalizeProfileName } from '../common/paradisBrowserProfileModel.js';
import { IParadisBrowserProfilesService } from './paradisBrowserProfilesService.js';

/**
 * 作ったペインの印。ペイントークンそのものは保存しない（台帳はアプリの保存領域に平文で残るため）。
 * トークンは CLI を起動し直すと変わるので、その後は作ったエージェントでも消せなくなる（安全側）。
 */
export function paradisAgentOwnerMark(token: string): string {
	const sha = new StringSHA1();
	sha.update(`paradis-agent-profile-owner:${token}`);
	return sha.digest().slice(0, 16);
}

/**
 * そのペインのエージェントが承認なしで使えるプロファイルか。そのペインが作り、ユーザーがまだ自分で
 * 使っていないものだけ。別のペインが作ったものも、ユーザーがそのタブの中でログインしている
 * かもしれないので、ユーザーのものと同じく承認を通す。
 */
function isOwnProfile(profile: IParadisBrowserProfile, token: string): boolean {
	return profile.createdByAgent === true && profile.agentOwner === paradisAgentOwnerMark(token);
}

type ParadisProfileApproval = 'approved' | 'denied' | 'approvalTimedOut' | 'alreadyPending' | 'recentlyDenied';

export class ParadisBrowserProfileMcpChannel extends Disposable implements IServerChannel {

	constructor(
		private readonly profilesService: IParadisBrowserProfilesService,
		private readonly bindingModel: IParadisAgentBrowserBindingModel,
		private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
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

	async call<T>(_ctx: unknown, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		const token = typeof args[0] === 'string' ? args[0] : undefined;
		const text = (index: number) => typeof args[index] === 'string' ? args[index] as string : undefined;
		const cancellation = cancellationToken ?? CancellationToken.None;
		switch (command) {
			case PARADIS_BROWSER_PROFILE_MCP_METHOD:
				return this._openBrowserProfile(token, text(1) ?? '', text(2), cancellation) as Promise<T>;
			case PARADIS_BROWSER_PROFILE_MCP_LIST_METHOD:
				return this._listProfiles(token) as Promise<T>;
			case PARADIS_BROWSER_PROFILE_MCP_CREATE_METHOD:
				return this._createProfile(token, text(1) ?? '') as Promise<T>;
			case PARADIS_BROWSER_PROFILE_MCP_SWITCH_METHOD:
				return this._switchProfile(token, text(1) ?? '', text(2), cancellation) as Promise<T>;
			case PARADIS_BROWSER_PROFILE_MCP_DELETE_METHOD:
				return this._deleteProfile(token, text(1) ?? '') as Promise<T>;
			case PARADIS_BROWSER_PROFILE_MCP_PANE_OWNED_METHOD:
				return this._isPaneOwnedProfile(token, text(1) ?? '') as Promise<T>;
		}
		throw new Error(`Method not found: ${command}`);
	}

	private async _openBrowserProfile(token: string | undefined, profileName: string, url: string | undefined, cancellation: CancellationToken): Promise<IParadisOpenProfileResult> {
		if (token === undefined) {
			return { ok: false, reason: 'paneUnresolved' };
		}
		if (!this.profilesService.canUseProfiles()) {
			return { ok: false, reason: 'untrustedWorkspace' };
		}
		if (url !== undefined && !paradisIsAllowedAgentTabUrl(url)) {
			return { ok: false, reason: 'invalidUrl' };
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
		// 開く先の判断（切替中・ペイン未解決・非表示スペース）はタブのサービスと共通にする。
		const target = this.agentTabsService.resolveTarget(token);
		if (!target.ok) {
			return target;
		}

		// 締め切りは承認・タブを開く・共有までの1本（shared process の待ち時間より短い）。
		const deadline = new ParadisApprovalDeadline(cancellation);
		try {
			return await this._openApprovedProfile(token, profile, url, deadline);
		} finally {
			deadline.dispose();
		}
	}

	private async _openApprovedProfile(token: string, profile: IParadisBrowserProfile, url: string | undefined, deadline: ParadisApprovalDeadline): Promise<IParadisOpenProfileResult> {
		// エージェントが開くタブなので、open_browser_tab と同じ上限と台帳に載せる（自分で閉じられるように）。
		// 上限は承認ダイアログを出す前に確かめる（承認させてから上限で断らない）。枠は開き終えるまで持つ。
		const slot = this.agentTabsService.reserveSlot(token);
		if (!slot) {
			return { ok: false, reason: 'limitReached' };
		}
		let input: BrowserEditorInput | undefined;
		let restored = false;
		try {
			const approval = await this._approveUserProfile(token, profile, deadline, url);
			if (approval !== 'approved') {
				return { ok: false, reason: approval };
			}
			// 承認を待っている間に状況が変わっていないか確かめ直す。
			const group = this.agentTabsService.resolveTarget(token);
			if (!group.ok) {
				return group;
			}

			// 開く前に Cookie の有無を見ておく。開いた後だとそのページ自身が置いた Cookie が混ざり、
			// 「ログイン状態が復元された」かどうかを誤って答えてしまう。
			const stats = await this.profilesService.getProfileStats(profile.id);
			restored = (stats.cookieCount ?? 0) > 0;

			input = await this.profilesService.openInProfile(profile.id, url, group.group);
			if (input) {
				// ユーザーのプロファイル（承認を得て使うもの）のタブは、ユーザーが共有を止めたら台帳から外れ、
				// 次に使うときは承認し直しになる。自分で作ったプロファイルのタブは自分のタブと同じ扱い。
				this.agentTabsService.registerAgentTab(token, input, { approvedProfile: !isOwnProfile(profile, token) });
			}
		} finally {
			slot.dispose();
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
			if (model && model.isDirectlyShareable) {
				// 締め切りを過ぎて成立した共有は外す（エージェントには時間切れが返っている）。
				bound = await this.agentTabsService.bindTabWithin(token, input, deadline.token) === true;
			}
		} catch (error) {
			this.logService.warn('[ParadisBrowserProfileMcp] opened the page but could not share it with the calling pane', error);
		}

		return { ok: true, profileName: profile.name, restored, bound, tabId: input.id };
	}

	/**
	 * このペインのものでないプロファイル（ユーザーのもの、別のペインが作ったもの）を使う前の承認。
	 * ダイアログには名前と、開く先のサイト（origin）を出す（何を渡すのかが分かるように）。
	 */
	private async _approveUserProfile(token: string, profile: IParadisBrowserProfile, deadline: ParadisApprovalDeadline, url: string | undefined): Promise<ParadisProfileApproval> {
		if (isOwnProfile(profile, token)) {
			return 'approved';
		}
		const origin = paradisUrlOrigin(url);
		const outcome = await this.agentTabsService.askApproval(token, {
			messageTemplate: pane => localize('paradis.browserProfiles.mcp.approval.message', "{0} のエージェントが、ブラウザのプロファイル「{1}」を使いたいと求めています", pane, profile.name),
			detail: [
				origin
					? localize('paradis.browserProfiles.mcp.approval.site', "開くサイト: {0}", origin)
					: localize('paradis.browserProfiles.mcp.approval.noSite', "開くサイト: 空のページ（その後エージェントが移動できます）"),
				localize('paradis.browserProfiles.mcp.approval.detail', "許可すると、エージェントはこのプロファイルに保存されたログイン状態（Cookie など）のままページを開き、操作できます。"),
				localize('paradis.browserProfiles.mcp.approval.detail2', "エージェントが開いたタブは、エージェントのタブとして一覧に載ります。共有を止めるか閉じれば使えなくなります。"),
			],
			approveLabel: localize('paradis.browserProfiles.mcp.approval.allow', "このプロファイルを使わせる"),
		}, deadline.token);
		switch (outcome) {
			case 'approve':
			case 'alternative':
				return 'approved';
			case 'denied':
				return 'denied';
			case 'busy':
				return 'alreadyPending';
			case 'recentlyDenied':
				return 'recentlyDenied';
			case 'cancelled':
			case 'unanswered':
				return 'approvalTimedOut';
		}
	}

	// #region 一覧・作成・切替・削除

	private async _listProfiles(token: string | undefined): Promise<IParadisListProfilesResult> {
		const profiles: IParadisAgentProfileInfo[] = [];
		let hiddenProfileCount = 0;
		for (const profile of this.profilesService.list()) {
			if (token === undefined || !isOwnProfile(profile, token)) {
				// このペインのものでなければ、名前もログインの有無も出さない（どのサービスに入っているかが分かる）。
				hiddenProfileCount++;
				continue;
			}
			const stats = await this.profilesService.getProfileStats(profile.id);
			profiles.push({
				name: profile.name,
				createdByYou: true,
				hasStoredLogin: stats.cookieCount === undefined ? undefined : stats.cookieCount > 0,
				lastUsed: new Date(profile.lastUsedAt).toISOString(),
			});
		}
		return {
			ok: true,
			profiles,
			hiddenProfileCount,
			usable: this.profilesService.canUseProfiles(),
			shareable: isBrowserViewStorageScopeShareableWithAgent(BrowserViewStorageScope.Profile, this.agentNetworkFilterService.isEnabled()),
		};
	}

	private async _createProfile(token: string | undefined, name: string): Promise<IParadisManageProfileResult<{ readonly profileName: string }>> {
		if (token === undefined) {
			return { ok: false, reason: 'paneUnresolved' };
		}
		if (!this.profilesService.canUseProfiles()) {
			return { ok: false, reason: 'untrustedWorkspace' };
		}
		const normalized = paradisNormalizeProfileName(name);
		const profiles = this.profilesService.list();
		// 空の名前も、既にある名前も同じ答えにする。「既にある」と教えると、ユーザーのプロファイル名を
		// ダイアログを出さずに探れてしまう。
		if (!normalized || paradisIsDuplicateProfileName(profiles, normalized)) {
			return { ok: false, reason: 'invalidName' };
		}
		// 上限はペインごとに数える。作ったペインのトークンは CLI を起動し直すと変わり、前のペインが作った
		// ものはもう誰も消せないので、全ペインの合計で数えると、残ったものだけで以後ずっと作れなくなる。
		if (profiles.filter(profile => isOwnProfile(profile, token)).length >= PARADIS_AGENT_CREATED_PROFILE_LIMIT) {
			return { ok: false, reason: 'tooManyProfiles' };
		}
		// 誰のものかを問わない合計にも天井を置く（前のペインが残したものが増え続けないように）。持ち主のペインが
		// もう無いかは、ほかのウィンドウや復元中のペインがあるので確かめられず、自動では消さない。
		if (profiles.filter(profile => profile.createdByAgent).length >= PARADIS_AGENT_CREATED_PROFILE_TOTAL_LIMIT) {
			return { ok: false, reason: 'tooManyAgentProfiles' };
		}
		// 色はエージェントに選ばせない（ユーザーが見分けるための印）。まだ使われていない色から順に割り当てる。
		const used = new Set(profiles.map(profile => profile.color));
		const assigned = PARADIS_BROWSER_PROFILE_COLORS.find(candidate => !used.has(candidate)) ?? PARADIS_BROWSER_PROFILE_COLORS[profiles.length % PARADIS_BROWSER_PROFILE_COLORS.length];
		const created = this.profilesService.create(normalized, assigned, { createdByAgent: true, agentOwner: paradisAgentOwnerMark(token) });
		return created.ok ? { ok: true, profileName: created.profile.name } : { ok: false, reason: 'invalidName' };
	}

	/**
	 * エージェントが開いたタブを別のプロファイルで開き直す。Electron のセッションはビューの作成時に
	 * 固定されるので、切替は「同じ位置へ新しいタブを差し込み古いタブを閉じる」作り直しになる
	 * （プロファイルのピルから切り替えたときと同じ）。ユーザーのタブは対象にしない。
	 */
	private async _switchProfile(token: string | undefined, profileName: string, tabId: string | undefined, cancellation: CancellationToken): Promise<IParadisSwitchProfileResult> {
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
		const deadline = new ParadisApprovalDeadline(cancellation);
		try {
			const approval = await this._approveUserProfile(token, profile, deadline, input.url);
			if (approval !== 'approved') {
				return { ok: false, reason: approval };
			}
			if (input.isDisposed() || this.workspaceSwitchService.isSwitching) {
				// 承認を待つ間にタブが閉じられた・スペースの切替が始まった。
				return { ok: false, reason: input.isDisposed() ? 'notAgentTab' : 'switching' };
			}

			const stats = await this.profilesService.getProfileStats(profile.id);
			const restored = (stats.cookieCount ?? 0) > 0;
			const replacement = await this.profilesService.switchView(input, { kind: 'profile', profileId: profile.id });
			if (!replacement) {
				return { ok: false, reason: 'switchFailed' };
			}
			// 古いタブは閉じられて台帳から外れる。作り直したタブをエージェントのものとして載せ直す
			// （承認を得たユーザーのプロファイルなら、開いたときと同じく共有を止めたら外れる印を付ける）。
			this.agentTabsService.registerAgentTab(token, replacement, { approvedProfile: !isOwnProfile(profile, token) });
			let bound = false;
			try {
				const model = await replacement.resolve();
				if (model.isDirectlyShareable) {
					bound = await this.agentTabsService.bindTabWithin(token, replacement, deadline.token) === true;
				}
			} catch (error) {
				this.logService.warn('[ParadisBrowserProfileMcp] switched the profile but could not share the new tab', error);
			}
			return { ok: true, profileName: profile.name, tabId: replacement.id, bound, restored };
		} finally {
			deadline.dispose();
		}
	}

	/**
	 * そのプロファイルを、このペインだけが使っているか。そのペインが作り（利用者が使うと印が外れる）、
	 * 開いているタブ（ほかのウィンドウのものも main が数える）がすべてこのペインのタブのとき true。
	 */
	private async _isPaneOwnedProfile(token: string | undefined, profileId: string): Promise<boolean> {
		if (token === undefined || profileId.length === 0) {
			return false;
		}
		const profile = this.profilesService.list().find(candidate => candidate.id === profileId);
		if (!profile || !isOwnProfile(profile, token)) {
			return false;
		}
		const ownTabs = [...this.browserViewWorkbenchService.getKnownBrowserViews().keys()]
			.filter(viewId => this.profilesService.getProfileForView(viewId) === profile.id && this.agentTabsService.isOpenedBy(token, viewId)).length;
		const stats = await this.profilesService.getProfileStats(profile.id);
		return stats.openViewCount <= ownTabs;
	}

	private async _deleteProfile(token: string | undefined, profileName: string): Promise<IParadisManageProfileResult<{ readonly profileName: string }>> {
		if (token === undefined) {
			return { ok: false, reason: 'paneUnresolved' };
		}
		// このペインが作ったもの以外は、無いのと同じ答えにする（名前の有無を探らせない）。
		const profile = this.profilesService.findByName(profileName);
		if (!profile || !isOwnProfile(profile, token)) {
			return { ok: false, reason: 'unknownProfile' };
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
}

class ParadisBrowserProfileMcpContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisBrowserProfileMcp';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IParadisBrowserProfilesService profilesService: IParadisBrowserProfilesService,
		@IParadisAgentBrowserBindingModel bindingModel: IParadisAgentBrowserBindingModel,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IAgentNetworkFilterService agentNetworkFilterService: IAgentNetworkFilterService,
		@ILogService logService: ILogService,
		@IParadisAgentBrowserTabsService agentTabsService: IParadisAgentBrowserTabsService,
		@IBrowserViewWorkbenchService browserViewWorkbenchService: IBrowserViewWorkbenchService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_BROWSER_PROFILE_MCP_CHANNEL, this._register(new ParadisBrowserProfileMcpChannel(
			profilesService,
			bindingModel,
			workspaceSwitchService,
			agentNetworkFilterService,
			logService,
			agentTabsService,
			browserViewWorkbenchService,
		)));
	}
}

registerWorkbenchContribution2(ParadisBrowserProfileMcpContribution.ID, ParadisBrowserProfileMcpContribution, WorkbenchPhase.AfterRestored);
