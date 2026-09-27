/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Computer Use の承認ダイアログの受け口（設計書 3.5）。
//
// shared process の ParadisComputerUseToolProvider が「呼び出し元ペインを所有するウィンドウ」だけへ送ってくる。
// ダイアログはページ共有・端末の要求と同じもの（IParadisAgentBrowserTabsService.askApproval）なので、
// 「拒否」が先頭で既定のフォーカス、表示から 1 秒以内と ⌘D の承認は聞き直す、ほかの承認と同じ列に並ぶ、
// 1 ペインに 1 件、という決まりもそのまま同じになる。
//
// 拒否の後 3 分の自動の断りは、`cooldownKey` でそのアプリに絞る（別のアプリやページ共有は止めない）。
// 答えの記録（台帳）は shared process が行う。ここは聞くだけ。
//
// 回答待ちの設問に関わる所:
//  - Q98（ターミナル類の扱い）: 案 A なら、ターミナル類の bundle id のときに detail へ警告の1行を足す
//  - 「操作も許可」の選択肢は、操作系のツールが入るまで出さない（PARADIS_COMPUTER_USE_OPERATE_AVAILABLE）

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisSanitizeDisplayText } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';
import { IParadisAgentApprovalRequest, IParadisAgentBrowserTabsService, ParadisApprovalDeadline } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import {
	PARADIS_COMPUTER_USE_APPROVAL_CHANNEL,
	PARADIS_COMPUTER_USE_APPROVAL_METHOD,
	PARADIS_COMPUTER_USE_APPROVAL_TIMEOUT_MS,
	ParadisComputerUseApprovalOutcome,
} from '../common/paradisComputerUse.js';

/** ダイアログに出すアプリ名の最大文字数（アプリ名は誰でも付けられるので長さも切る）。 */
const APP_NAME_MAX_LENGTH = 60;
const BUNDLE_ID_MAX_LENGTH = 120;
/** bundle id として受ける形（英数字と . - _ だけ）。 */
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** shared process から届く承認の求めをダイアログへ流すチャネル。 */
export class ParadisComputerUseApprovalChannel implements IServerChannel {

	constructor(
		private readonly _approvals: Pick<IParadisAgentBrowserTabsService, 'askApproval'>,
		private readonly _paneTokens: Pick<IParadisPaneTokenService, 'getInstanceForToken'>,
	) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
		if (command !== PARADIS_COMPUTER_USE_APPROVAL_METHOD) {
			throw new Error(`Method not found: ${command}`);
		}
		const args = Array.isArray(arg) ? arg : [];
		const prompt = args[1] && typeof args[1] === 'object' ? args[1] as Record<string, unknown> : {};
		const outcome = await this._requestAccess(args[0], prompt, cancellationToken ?? CancellationToken.None);
		const answer: { readonly outcome: ParadisComputerUseApprovalOutcome } = { outcome };
		return answer as T;
	}

	private async _requestAccess(token: unknown, prompt: Record<string, unknown>, cancellation: CancellationToken): Promise<ParadisComputerUseApprovalOutcome> {
		if (typeof token !== 'string' || this._paneTokens.getInstanceForToken(token) === undefined) {
			return 'paneUnresolved';
		}
		const bundleId = typeof prompt.bundleId === 'string' && BUNDLE_ID_PATTERN.test(prompt.bundleId) ? paradisSanitizeDisplayText(prompt.bundleId, BUNDLE_ID_MAX_LENGTH) : undefined;
		if (!bundleId) {
			return 'cancelled';
		}
		// アプリ名はアプリ自身が決める文字列なので、制御文字と双方向制御を落としてから出す
		const appName = paradisSanitizeDisplayText(typeof prompt.appName === 'string' ? prompt.appName : undefined, APP_NAME_MAX_LENGTH) ?? bundleId;
		const upgrade = prompt.requested === 'operate';
		const offerOperate = upgrade || prompt.offerOperate === true;

		const detail = [
			localize('paradis.computerUse.approval.app', "アプリ: {0}（{1}）", appName, bundleId),
			upgrade
				? localize('paradis.computerUse.approval.upgrade', "このアプリの画面は読み取りを許可済みです。操作も許可すると、クリックと文字入力もします。")
				: localize('paradis.computerUse.approval.read', "読み取りを許可すると、エージェントはこのアプリのウィンドウの画面とアクセシビリティの情報（ボタンや文字の並び）を読みます。画面に写ったメール本文やチャットなどもエージェントへ渡り、エージェントの提供元へ送られます。"),
			...(offerOperate && !upgrade ? [localize('paradis.computerUse.approval.operate', "操作も許可すると、クリックと文字入力もします。")] : []),
			localize('paradis.computerUse.approval.scope', "選んだ内容はこのターミナルにだけ効き、Para Code を終了するまで覚えます。拒否した場合も、このターミナルからの同じアプリの求めは断ります。"),
			localize('paradis.computerUse.approval.outside', "Computer Use の操作は、エージェントのサンドボックスと許可設定の外で、あなたの権限で行われます。"),
		];
		const request: IParadisAgentApprovalRequest = {
			messageTemplate: pane => upgrade
				? localize('paradis.computerUse.approval.messageUpgrade', "{0} のエージェントが、「{1}」を操作したいと求めています", pane, appName)
				: localize('paradis.computerUse.approval.message', "{0} のエージェントが、「{1}」の画面を読みたいと求めています", pane, appName),
			detail,
			// 格上げでは「読み取りのみ」を出さない。初回は「読み取りのみ」を 2 番目（⌘D が押す位置）に置き、
			// ショートカットで決まるのがより安全な方になるようにする
			...(offerOperate && !upgrade ? { alternativeLabel: localize('paradis.computerUse.approval.readOnly', "読み取りのみ許可") } : {}),
			approveLabel: offerOperate
				? localize('paradis.computerUse.approval.approveOperate', "操作も許可")
				: localize('paradis.computerUse.approval.approveRead', "読み取りを許可"),
			cooldownKey: `computer:${bundleId}`,
		};

		// 締め切りは shared process の待ち（2 分）より少し短くし、こちらで閉じてから答えを返す
		const deadline = new ParadisApprovalDeadline(cancellation, PARADIS_COMPUTER_USE_APPROVAL_TIMEOUT_MS - 5_000);
		try {
			const outcome = await this._approvals.askApproval(token, request, deadline.token);
			// 答えを待つ間にペインが閉じていたら、許可として返さない
			if ((outcome === 'approve' || outcome === 'alternative') && this._paneTokens.getInstanceForToken(token) === undefined) {
				return 'paneUnresolved';
			}
			switch (outcome) {
				case 'approve':
					return offerOperate ? 'operate' : 'read';
				case 'alternative':
					// 2つ目の選択肢は初回の「読み取りのみ」だけ。それ以外で来ても許可としては扱わない
					return offerOperate && !upgrade ? 'read' : 'denied';
				default:
					return outcome;
			}
		} finally {
			deadline.dispose();
		}
	}
}

class ParadisComputerUseApprovalContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisComputerUseApproval';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IParadisAgentBrowserTabsService approvals: IParadisAgentBrowserTabsService,
		@IParadisPaneTokenService paneTokens: IParadisPaneTokenService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_COMPUTER_USE_APPROVAL_CHANNEL, new ParadisComputerUseApprovalChannel(approvals, paneTokens));
	}
}

registerWorkbenchContribution2(ParadisComputerUseApprovalContribution.ID, ParadisComputerUseApprovalContribution, WorkbenchPhase.AfterRestored);
