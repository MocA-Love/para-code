/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントの「この端末を使いたい」（mobile_request_device、B13）を利用者に承認してもらう受け口。
//
// shared process の ParadisMobileDeviceOpsToolProvider が「呼び出し元ペインを所有するウィンドウ」だけへ
// ルーティングして呼ぶ。ダイアログはページ共有の承認と同じもの（IParadisAgentBrowserTabsService.askApproval）を
// 使うので、次の決まりもそのまま同じになる:
//  - 「拒否」が先頭で既定のフォーカス。Esc と閉じるボタンは拒否
//  - 表示から 1 秒以内の承認と、⌘D での承認は聞き直す
//  - ダイアログはページ共有・プロファイルの承認と同じ列に並べて1つずつ出す。1ペインにつき待てる求めは1つ
//  - 拒否の後 3 分は、同じペインからの求めを自動で断る（ページ共有の求めと数え方を共有する）
// ここは承認を取るだけで、台帳への割り当ては shared process が行う（承認の後に、ほかのペインへ渡って
// いないかを確かめ直してから）。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisSanitizeAgentPageRequestReason, paradisSanitizeDisplayText } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';
import { IParadisAgentBrowserTabsService, ParadisApprovalDeadline } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IParadisTerminalScopeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisMobileDeviceRequestAnswer,
	PARADIS_MOBILE_DEVICE_REQUEST_CHANNEL,
	PARADIS_MOBILE_DEVICE_REQUEST_METHOD,
} from '../common/paradisMobileDeviceOps.js';

/** ダイアログに出す端末名の最大文字数（端末名はエージェントも simctl で付けられるので、長さも切る）。 */
const DEVICE_NAME_MAX_LENGTH = 80;
const RUNTIME_MAX_LENGTH = 40;

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
		if (command !== PARADIS_MOBILE_DEVICE_REQUEST_METHOD) {
			throw new Error(`Method not found: ${command}`);
		}
		const args = Array.isArray(arg) ? arg : [];
		return this._request(args[0], args[1], cancellationToken ?? CancellationToken.None) as Promise<T>;
	}

	private async _request(token: unknown, rawPrompt: unknown, cancellation: CancellationToken): Promise<IParadisMobileDeviceRequestAnswer> {
		const instanceId = typeof token === 'string' ? this._paneTokens.getInstanceForToken(token) : undefined;
		if (typeof token !== 'string' || instanceId === undefined) {
			return { outcome: 'paneUnresolved' };
		}
		const prompt = rawPrompt && typeof rawPrompt === 'object' ? rawPrompt as Record<string, unknown> : {};
		const text = (name: string) => typeof prompt[name] === 'string' ? prompt[name] as string : undefined;
		// 名前・理由はエージェントが決められる文字列なので、制御文字と双方向制御を落としてから出す
		const deviceName = paradisSanitizeDisplayText(text('deviceName'), DEVICE_NAME_MAX_LENGTH) ?? localize('paradis.mobileDeviceRequest.unnamed', "名前のない端末");
		const runtime = paradisSanitizeDisplayText(text('runtime'), RUNTIME_MAX_LENGTH);
		const reason = paradisSanitizeAgentPageRequestReason(text('reason'));
		const replacing = paradisSanitizeDisplayText(text('replacingDeviceName'), DEVICE_NAME_MAX_LENGTH);

		const detail = [
			reason ? localize('paradis.mobileDeviceRequest.reason', "エージェントが書いた理由: {0}", reason) : undefined,
			runtime
				? localize('paradis.mobileDeviceRequest.deviceWithRuntime', "使いたい端末: {0}（{1}）", deviceName, runtime)
				: localize('paradis.mobileDeviceRequest.device', "使いたい端末: {0}", deviceName),
			replacing ? localize('paradis.mobileDeviceRequest.replacing', "承認すると、このターミナルに渡している「{0}」は外れます。", replacing) : undefined,
			localize('paradis.mobileDeviceRequest.effect', "承認すると、このターミナルのエージェントはこの端末の画面を読み、タップ・入力・回転などの操作と、アプリのインストール・起動・権限の付与ができます。共有ダイアログの「モバイル端末」タブからいつでも外せます。"),
		].filter((line): line is string => line !== undefined);

		// ページ共有と同じ締め切り（ダイアログの表示を含めて 50 秒）。shared process の取り消しでも閉じる
		const deadline = new ParadisApprovalDeadline(cancellation);
		try {
			const outcome = await this._approvals.askApproval(token, {
				messageTemplate: pane => localize('paradis.mobileDeviceRequest.message', "{0} のエージェントが、モバイル端末を使いたいと求めています", pane),
				detail,
				approveLabel: localize('paradis.mobileDeviceRequest.approve', "この端末を渡す"),
			}, deadline.token);
			if (outcome !== 'approve') {
				// 2つ目の選択肢は出していないので alternative は来ない。来ても承認としては扱わない
				return { outcome: outcome === 'alternative' ? 'denied' : outcome };
			}
			const stateKey = this._terminalScopes.getStateKeyForInstance(instanceId);
			return { outcome: 'approved', ...(stateKey !== undefined ? { stateKey } : {}) };
		} finally {
			deadline.dispose();
		}
	}
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
