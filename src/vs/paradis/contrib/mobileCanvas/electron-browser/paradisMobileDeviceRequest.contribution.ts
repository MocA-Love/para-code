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
// インストール）」に絞る。別の端末の要求やページ共有は止めない。
// ここは承認を取るだけで、台帳への割り当てとインストールは shared process が行う。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisSanitizeAgentPageRequestReason, paradisSanitizeDisplayText } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';
import { IParadisAgentApprovalRequest, IParadisAgentBrowserTabsService, ParadisApprovalDeadline } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IParadisTerminalScopeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisMobileDeviceRequestAnswer,
	PARADIS_MOBILE_DEVICE_REQUEST_CHANNEL,
	PARADIS_MOBILE_DEVICE_REQUEST_METHOD,
	PARADIS_MOBILE_INSTALL_APPROVAL_METHOD,
} from '../common/paradisMobileDeviceOps.js';

/** ダイアログに出す端末名の最大文字数（端末名はエージェントも simctl で付けられるので、長さも切る）。 */
const DEVICE_NAME_MAX_LENGTH = 80;
const RUNTIME_MAX_LENGTH = 40;
/** ダイアログに出すインストールするパスの最大文字数。 */
const PATH_MAX_LENGTH = 400;

/** shared process から届く要求を承認ダイアログへ流すチャネル。 */
export class ParadisMobileDeviceRequestChannel implements IServerChannel {

	constructor(
		private readonly _approvals: Pick<IParadisAgentBrowserTabsService, 'askApproval'>,
		private readonly _paneTokens: Pick<IParadisPaneTokenService, 'getInstanceForToken'>,
		private readonly _terminalScopes: Pick<IParadisTerminalScopeService, 'getStateKeyForInstance'>,
	) { }

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
		}
		throw new Error(`Method not found: ${command}`);
	}

	private _requestDevice(token: unknown, prompt: Record<string, unknown>, cancellation: CancellationToken): Promise<IParadisMobileDeviceRequestAnswer> {
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
		return this._ask(token, {
			messageTemplate: pane => localize('paradis.mobileDeviceRequest.message', "{0} のエージェントが、モバイル端末を使いたいと求めています", pane),
			detail,
			approveLabel: localize('paradis.mobileDeviceRequest.approve', "この端末を渡す"),
			cooldownKey: `mobile-device:${text(prompt, 'deviceId') ?? deviceName}`,
		}, cancellation);
	}

	private _approveInstall(token: unknown, prompt: Record<string, unknown>, cancellation: CancellationToken): Promise<IParadisMobileDeviceRequestAnswer> {
		const deviceName = deviceNameOf(prompt);
		const path = paradisSanitizeDisplayText(text(prompt, 'path'), PATH_MAX_LENGTH);
		if (!path) {
			return Promise.resolve({ outcome: 'cancelled' });
		}
		return this._ask(token, {
			messageTemplate: pane => localize('paradis.mobileInstall.message', "{0} のエージェントが、モバイル端末にアプリを入れようとしています", pane),
			detail: [
				localize('paradis.mobileInstall.path', "インストールするもの: {0}", path),
				localize('paradis.mobileInstall.device', "入れる端末: {0}", deviceName),
				localize('paradis.mobileInstall.effect', "このアプリは Para Code の権限で動き、エージェントの作業フォルダの制限の外に出られます（この Mac のファイルやネットワークに触れられます）。エージェントが作った覚えのないものなら拒否してください。"),
			],
			approveLabel: localize('paradis.mobileInstall.approve', "インストールする"),
			cooldownKey: `mobile-install:${text(prompt, 'deviceId') ?? deviceName}`,
		}, cancellation);
	}

	private async _ask(token: unknown, request: IParadisAgentApprovalRequest, cancellation: CancellationToken): Promise<IParadisMobileDeviceRequestAnswer> {
		if (typeof token !== 'string' || this._paneTokens.getInstanceForToken(token) === undefined) {
			return { outcome: 'paneUnresolved' };
		}
		// ページ共有と同じ締め切り（ダイアログの表示を含めて 50 秒）。shared process の取り消しでも閉じる
		const deadline = new ParadisApprovalDeadline(cancellation);
		try {
			const outcome = await this._approvals.askApproval(token, request, deadline.token);
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
