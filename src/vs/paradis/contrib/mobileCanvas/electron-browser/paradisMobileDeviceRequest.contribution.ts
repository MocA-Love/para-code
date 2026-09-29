/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントの「この端末を使いたい」（mobile_request_device）と「このアプリを入れたい」（mobile_install_app）を
// 利用者に承認してもらう受け口（B13）。
//
// shared process の ParadisMobileDeviceOpsToolProvider が「呼び出し元ペインを所有するウィンドウ」だけへ
// ルーティングして呼ぶ。ダイアログはページ共有の承認と同じもの（IParadisAgentBrowserTabsService.askApproval）を
// 使うので、次の決まりもそのまま同じになる:
//  - 「拒否」が先頭で既定のフォーカス。Esc と閉じるボタンは拒否
//  - 表示から 1 秒以内の承認と、⌘D での承認は聞き直す
//  - ダイアログはページ共有・プロファイルの承認と同じ列に並べて1つずつ出す。1ペインにつき待てる求めは1つ
// 拒否の後 3 分の自動の断りだけは、`cooldownKey` で「そのペインの、その端末への要求（インストールは、その端末への
// インストール）」に絞る。別の端末の要求やページ共有は止めない。ただし端末の要求を拒否された直後の 10 秒は、
// 同じペインからの別の端末の要求も断る（端末を替えて続けてダイアログを出させない）。
// インストールは、承認の前に shared process が写した一時フォルダの中身（ID と名前）を見せる。
// ここは承認を取るだけで、台帳への割り当てとインストールは shared process が行う。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { PARADIS_AGENT_APPROVAL_DEADLINE_MS, paradisSanitizeAgentPageRequestReason, paradisSanitizeDisplayText } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';
import { IParadisAgentApprovalRequest, IParadisAgentBrowserTabsService, ParadisApprovalDeadline } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IParadisTerminalScopeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisMobileDeviceRequestAnswer,
	PARADIS_MOBILE_DEVICE_REQUEST_CHANNEL,
	PARADIS_MOBILE_DEVICE_REQUEST_METHOD,
	PARADIS_MOBILE_INSTALL_APPROVAL_METHOD,
	PARADIS_MOBILE_INSTALL_PRECHECK_METHOD,
	ParadisMobileApprovalPrecheck,
} from '../common/paradisMobileDeviceOps.js';

/** ダイアログに出す端末名の最大文字数（端末名はエージェントも simctl で付けられるので、長さも切る）。 */
const DEVICE_NAME_MAX_LENGTH = 80;
const RUNTIME_MAX_LENGTH = 40;
/** ダイアログに出すインストールするパスの最大文字数。超えたら先頭を切り、末尾（ファイル名）を残す。 */
const PATH_MAX_LENGTH = 200;
const APP_ID_MAX_LENGTH = 200;
/**
 * 端末の要求を拒否された直後、同じペインからのほかの端末の要求も断る時間。3 分の断りは端末ごとなので、
 * これが無いと端末の数だけ続けてダイアログを出せる。
 */
export const PARADIS_MOBILE_ANY_DEVICE_DENIAL_MS = 10_000;

/** shared process から届く要求を承認ダイアログへ流すチャネル。 */
export class ParadisMobileDeviceRequestChannel implements IServerChannel {

	constructor(
		private readonly _approvals: Pick<IParadisAgentBrowserTabsService, 'askApproval' | 'approvalBlock'>,
		private readonly _paneTokens: Pick<IParadisPaneTokenService, 'getInstanceForToken'>,
		private readonly _terminalScopes: Pick<IParadisTerminalScopeService, 'getStateKeyForInstance'>,
		private readonly _now: () => number = Date.now,
		private readonly _deadlineMs: number = PARADIS_AGENT_APPROVAL_DEADLINE_MS,
	) { }

	/** ペイン → 端末の要求を最後に拒否された時刻。 */
	private readonly _lastDeviceDenial = new Map<string, number>();

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		const prompt = args[1] && typeof args[1] === 'object' ? args[1] as Record<string, unknown> : {};
		const cancellation = cancellationToken ?? CancellationToken.None;
		switch (command) {
			case PARADIS_MOBILE_DEVICE_REQUEST_METHOD:
				return this._requestDevice(args[0], prompt, cancellation) as Promise<T>;
			case PARADIS_MOBILE_INSTALL_APPROVAL_METHOD:
				return this._approveInstall(args[0], prompt, cancellation) as Promise<T>;
			case PARADIS_MOBILE_INSTALL_PRECHECK_METHOD: {
				const answer: { readonly outcome: ParadisMobileApprovalPrecheck } = { outcome: this._precheckInstall(args[0], prompt) };
				return answer as T;
			}
		}
		throw new Error(`Method not found: ${command}`);
	}

	private async _requestDevice(token: unknown, prompt: Record<string, unknown>, cancellation: CancellationToken): Promise<IParadisMobileDeviceRequestAnswer> {
		// 拒否された直後は、別の端末の要求もダイアログを出さずに断る（端末を替えて続けて迫らせない）
		const deniedAt = typeof token === 'string' ? this._lastDeviceDenial.get(token) : undefined;
		if (deniedAt !== undefined) {
			if (this._now() - deniedAt < PARADIS_MOBILE_ANY_DEVICE_DENIAL_MS) {
				return { outcome: 'recentlyDenied' };
			}
			this._lastDeviceDenial.delete(token as string);
		}
		// 名前・理由はエージェントが決められる文字列なので、制御文字と双方向制御を落としてから出す
		const deviceName = deviceNameOf(prompt);
		const runtime = paradisSanitizeDisplayText(text(prompt, 'runtime'), RUNTIME_MAX_LENGTH);
		const reason = paradisSanitizeAgentPageRequestReason(text(prompt, 'reason'));
		const replacing = paradisSanitizeDisplayText(text(prompt, 'replacingDeviceName'), DEVICE_NAME_MAX_LENGTH);
		const detail = [
			reason ? localize('paradis.mobileDeviceRequest.reason', "エージェントが書いた理由: {0}", reason) : undefined,
			runtime
				? localize('paradis.mobileDeviceRequest.deviceWithRuntime', "使いたい端末: {0}（{1}）", deviceName, runtime)
				: localize('paradis.mobileDeviceRequest.device', "使いたい端末: {0}", deviceName),
			replacing ? localize('paradis.mobileDeviceRequest.replacing', "承認すると、このターミナルに渡している「{0}」は外れます。", replacing) : undefined,
			localize('paradis.mobileDeviceRequest.effect', "承認すると、このターミナルのエージェントはこの端末の画面を読み、タップ・入力・回転などの操作と、アプリの起動・権限の付与ができます。共有ダイアログの「モバイル端末」タブからいつでも外せます。"),
			localize('paradis.mobileDeviceRequest.install', "アプリのインストールは、そのたびに確認します。エージェントが入れたアプリは Para Code の権限で動き、エージェントの作業フォルダの制限の外に出られます。"),
		].filter((line): line is string => line !== undefined);
		const answer = await this._ask(token, {
			messageTemplate: pane => localize('paradis.mobileDeviceRequest.message', "{0} のエージェントが、モバイル端末を使いたいと求めています", pane),
			detail,
			approveLabel: localize('paradis.mobileDeviceRequest.approve', "この端末を渡す"),
			cooldownKey: `mobile-device:${text(prompt, 'deviceId') ?? deviceName}`,
		}, cancellation);
		if (answer.outcome === 'denied' && typeof token === 'string') {
			this._lastDeviceDenial.set(token, this._now());
		}
		return answer;
	}

	private _precheckInstall(token: unknown, prompt: Record<string, unknown>): ParadisMobileApprovalPrecheck {
		if (typeof token !== 'string' || this._paneTokens.getInstanceForToken(token) === undefined) {
			return 'paneUnresolved';
		}
		return this._approvals.approvalBlock(token, installCooldownKey(prompt)) ?? 'clear';
	}

	private _approveInstall(token: unknown, prompt: Record<string, unknown>, cancellation: CancellationToken): Promise<IParadisMobileDeviceRequestAnswer> {
		const deviceName = deviceNameOf(prompt);
		const path = tailOf(paradisSanitizeDisplayText(text(prompt, 'path'), Number.MAX_SAFE_INTEGER), PATH_MAX_LENGTH);
		if (!path) {
			return Promise.resolve({ outcome: 'cancelled' });
		}
		const appId = paradisSanitizeDisplayText(text(prompt, 'appId'), APP_ID_MAX_LENGTH);
		const appName = paradisSanitizeDisplayText(text(prompt, 'appName'), DEVICE_NAME_MAX_LENGTH);
		return this._ask(token, {
			messageTemplate: pane => localize('paradis.mobileInstall.message', "{0} のエージェントが、モバイル端末にアプリを入れようとしています", pane),
			detail: [
				appId
					? appName
						? localize('paradis.mobileInstall.appWithName', "入れるアプリ: {0}（{1}）", appId, appName)
						: localize('paradis.mobileInstall.app', "入れるアプリ: {0}", appId)
					: localize('paradis.mobileInstall.appUnknown', "入れるアプリ: ID を読めませんでした"),
				localize('paradis.mobileInstall.path', "写した元: {0}", path),
				localize('paradis.mobileInstall.device', "入れる端末: {0}", deviceName),
				localize('paradis.mobileInstall.copy', "Para Code がこの時点の中身を写したものを入れます。承認の後に元のファイルが変わっても、入るものは変わりません。"),
				localize('paradis.mobileInstall.effect', "このアプリは Para Code の権限で動き、エージェントの作業フォルダの制限の外に出られます（この Mac のファイルやネットワークに触れられます）。エージェントが作った覚えのないものなら拒否してください。"),
			],
			approveLabel: localize('paradis.mobileInstall.approve', "インストールする"),
			cooldownKey: installCooldownKey(prompt),
		}, cancellation);
	}

	private async _ask(token: unknown, request: IParadisAgentApprovalRequest, cancellation: CancellationToken): Promise<IParadisMobileDeviceRequestAnswer> {
		if (typeof token !== 'string' || this._paneTokens.getInstanceForToken(token) === undefined) {
			return { outcome: 'paneUnresolved' };
		}
		// ページ共有と同じ締め切り（ダイアログの表示を含めて 50 秒）。shared process の取り消しでも閉じる
		const deadline = new ParadisApprovalDeadline(cancellation, this._deadlineMs);
		try {
			const outcome = await this._approvals.askApproval(token, request, deadline.token);
			if (outcome === 'cancelled' && deadline.timedOut) {
				// 締め切りで閉じたものは、取り消しではなく「答えが無かった」と返す（ページ共有・プロファイルと同じ）
				return { outcome: 'timedOut' };
			}
			if (outcome !== 'approve') {
				// 2つ目の選択肢は出していないので alternative は来ない。来ても承認としては扱わない
				return { outcome: outcome === 'alternative' ? 'denied' : outcome };
			}
			// 答えを待つ間にペインが閉じていたら承認として返さない（閉じたペインへ割り当てが残らないように）
			const instanceId = this._paneTokens.getInstanceForToken(token);
			if (instanceId === undefined) {
				return { outcome: 'paneUnresolved' };
			}
			const stateKey = this._terminalScopes.getStateKeyForInstance(instanceId);
			return { outcome: 'approved', ...(stateKey !== undefined ? { stateKey } : {}) };
		} finally {
			deadline.dispose();
		}
	}
}

function text(prompt: Record<string, unknown>, name: string): string | undefined {
	return typeof prompt[name] === 'string' ? prompt[name] as string : undefined;
}

/** 長すぎる文字列の先頭を切り、末尾（パスのファイル名）を残す。 */
function tailOf(value: string | undefined, maxLength: number): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const characters = Array.from(value);
	return characters.length > maxLength ? `\u2026${characters.slice(characters.length - maxLength).join('')}` : value;
}

/** インストールの拒否を数える単位（そのペインの、その端末へのインストール）。確かめと承認で同じものを使う。 */
function installCooldownKey(prompt: Record<string, unknown>): string {
	return `mobile-install:${text(prompt, 'deviceId') ?? deviceNameOf(prompt)}`;
}

function deviceNameOf(prompt: Record<string, unknown>): string {
	return paradisSanitizeDisplayText(text(prompt, 'deviceName'), DEVICE_NAME_MAX_LENGTH) ?? localize('paradis.mobileDeviceRequest.unnamed', "名前のない端末");
}

class ParadisMobileDeviceRequestContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisMobileDeviceRequest';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IParadisAgentBrowserTabsService approvals: IParadisAgentBrowserTabsService,
		@IParadisPaneTokenService paneTokens: IParadisPaneTokenService,
		@IParadisTerminalScopeService terminalScopes: IParadisTerminalScopeService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_MOBILE_DEVICE_REQUEST_CHANNEL, new ParadisMobileDeviceRequestChannel(approvals, paneTokens, terminalScopes));
	}
}

registerWorkbenchContribution2(ParadisMobileDeviceRequestContribution.ID, ParadisMobileDeviceRequestContribution, WorkbenchPhase.AfterRestored);
