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
// ボタンは「拒否」「読み取りのみ許可」「操作も許可」の 3 つ。読み取りを許可済みのアプリの格上げでは
// 「拒否」「操作も許可」の 2 つにする。ターミナル類とスクリプトエディタには、コマンドを打てる旨の一文を足す（Q98 の回答 A）。
// Computer Use はエージェントの作業フォルダ・サンドボックス・許可設定の外で動くので、本文に必ず書く（設計書 6.6）。
//
// 設定 `paradis.computerUse.confirmForegroundInput` がオンのときは、アプリを前面に出して実際のマウスポインタと
// キーボードを使う前の確認（`requestForeground`）もここで受ける。ボタンは「拒否」「今回だけ許可」「このターミナルでは
// 今後も許可」。⌘D の位置（2 番目）には狭い方の「今回だけ許可」を置く。拒否の後 3 分の自動の断りは、操作の許可とは
// 別の鍵（`computer-foreground:<bundle id>`）で数える。

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
	PARADIS_COMPUTER_USE_FOREGROUND_METHOD,
	ParadisComputerUseApprovalOutcome,
	ParadisComputerUseForegroundOutcome,
	paradisComputerUseRunsCommands,
} from '../common/paradisComputerUse.js';

/** ダイアログに出すアプリ名の最大文字数（アプリ名は誰でも付けられるので長さも切る）。 */
const APP_NAME_MAX_LENGTH = 60;
const BUNDLE_ID_MAX_LENGTH = 120;
/** bundle id として受ける形（英数字と . - _ だけ）。 */
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** 前面の確認ダイアログに出す操作の名前（ツール名から `computer_` を外したもの → 日本語）。 */
export function paradisForegroundActionLabel(action: string): string | undefined {
	switch (action) {
		case 'activate_app': return localize('paradis.computerUse.foreground.action.activate', "アプリを前面に出す");
		case 'click': return localize('paradis.computerUse.foreground.action.click', "クリック");
		case 'drag': return localize('paradis.computerUse.foreground.action.drag', "ドラッグ");
		case 'scroll': return localize('paradis.computerUse.foreground.action.scroll', "スクロール");
		case 'type_text': return localize('paradis.computerUse.foreground.action.type', "文字入力");
		case 'paste_text': return localize('paradis.computerUse.foreground.action.paste', "貼り付け");
		case 'press_key': return localize('paradis.computerUse.foreground.action.key', "キー操作");
		case 'hotkey': return localize('paradis.computerUse.foreground.action.hotkey', "キーボードショートカット");
		case 'set_value': return localize('paradis.computerUse.foreground.action.value', "値の変更");
		default: return undefined;
	}
}

/** shared process から届く承認の求めをダイアログへ流すチャネル。 */
export class ParadisComputerUseApprovalChannel implements IServerChannel {

	constructor(
		private readonly _approvals: Pick<IParadisAgentBrowserTabsService, 'askApproval'>,
		private readonly _paneTokens: Pick<IParadisPaneTokenService, 'getInstanceForToken'>,
		// 締め切りは shared process の待ち（2 分）より少し短くし、こちらで閉じてから答えを返す
		private readonly _deadlineMs: number = PARADIS_COMPUTER_USE_APPROVAL_TIMEOUT_MS - 5_000,
	) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		const prompt = args[1] && typeof args[1] === 'object' ? args[1] as Record<string, unknown> : {};
		if (command === PARADIS_COMPUTER_USE_FOREGROUND_METHOD) {
			const answer: { readonly outcome: ParadisComputerUseForegroundOutcome } = { outcome: await this._requestForeground(args[0], prompt, cancellationToken ?? CancellationToken.None) };
			return answer as T;
		}
		if (command !== PARADIS_COMPUTER_USE_APPROVAL_METHOD) {
			throw new Error(`Method not found: ${command}`);
		}
		const outcome = await this._requestAccess(args[0], prompt, cancellationToken ?? CancellationToken.None);
		const answer: { readonly outcome: ParadisComputerUseApprovalOutcome } = { outcome };
		return answer as T;
	}

	/** アプリを前面に出して実際のマウスポインタとキーボードを使ってよいか（設定 `paradis.computerUse.confirmForegroundInput`）。 */
	private async _requestForeground(token: unknown, prompt: Record<string, unknown>, cancellation: CancellationToken): Promise<ParadisComputerUseForegroundOutcome> {
		if (typeof token !== 'string' || this._paneTokens.getInstanceForToken(token) === undefined) {
			return 'paneUnresolved';
		}
		const bundleId = typeof prompt.bundleId === 'string' && BUNDLE_ID_PATTERN.test(prompt.bundleId) ? paradisSanitizeDisplayText(prompt.bundleId, BUNDLE_ID_MAX_LENGTH) : undefined;
		if (!bundleId) {
			return 'cancelled';
		}
		const appName = paradisSanitizeDisplayText(typeof prompt.appName === 'string' ? prompt.appName : undefined, APP_NAME_MAX_LENGTH) ?? bundleId;
		// 操作の名前は決まった一覧の日本語にする（知らない名前は出さない）
		const action = typeof prompt.action === 'string' ? paradisForegroundActionLabel(prompt.action) : undefined;
		const detail = [
			localize('paradis.computerUse.foreground.app', "アプリ: {0}（{1}）", appName, bundleId),
			...(action ? [localize('paradis.computerUse.foreground.action', "操作: {0}", action)] : []),
			localize('paradis.computerUse.foreground.pointer', "このアプリを前面に出し、実際のマウスポインタを動かしてクリックやキー入力を送ります。その間にあなたがマウスやキーボードを使うと、エージェントの操作は止まります。"),
			localize('paradis.computerUse.foreground.scope', "「このターミナルでは今後も許可」を選ぶと、Para Code を終了するまで、このターミナルからのこのアプリへの操作では聞きません。ボタンを押す・値を変える・欄へ文字を入れるなど、ポインタを動かさずに送れる操作では、この確認は出ません。"),
		];
		const request: IParadisAgentApprovalRequest = {
			messageTemplate: pane => localize('paradis.computerUse.foreground.message', "{0} のエージェントが、「{1}」でマウスとキーボードを使おうとしています", pane, appName),
			detail,
			alternativeLabel: localize('paradis.computerUse.foreground.once', "今回だけ許可"),
			approveLabel: localize('paradis.computerUse.foreground.pane', "このターミナルでは今後も許可"),
			cooldownKey: `computer-foreground:${bundleId}`,
		};
		const deadline = new ParadisApprovalDeadline(cancellation, this._deadlineMs);
		try {
			const outcome = await this._approvals.askApproval(token, request, deadline.token);
			if (outcome === 'cancelled' && deadline.timedOut) {
				return 'timedOut';
			}
			if ((outcome === 'approve' || outcome === 'alternative') && this._paneTokens.getInstanceForToken(token) === undefined) {
				return 'paneUnresolved';
			}
			switch (outcome) {
				case 'approve':
					return 'pane';
				case 'alternative':
					return 'once';
				default:
					return outcome;
			}
		} finally {
			deadline.dispose();
		}
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
		const wantsOperate = prompt.requested === 'operate';
		const offerOperate = prompt.offerOperate === true || wantsOperate;
		// 格上げは、読み取りを許可済みのアプリへの操作の求めだけ
		const upgrade = prompt.upgrade === true && wantsOperate;

		const detail = [
			localize('paradis.computerUse.approval.app', "アプリ: {0}（{1}）", appName, bundleId),
			...(upgrade
				? [localize('paradis.computerUse.approval.upgrade', "このアプリの画面は読み取りを許可済みです。操作も許可すると、クリック・文字入力・貼り付け・キー操作・前面に出すこともします。")]
				: [localize('paradis.computerUse.approval.read', "読み取り: このアプリのウィンドウの画面とアクセシビリティの情報（ボタンや文字の並び）を読みます。画面に写ったメール本文やチャットなどもエージェントへ渡り、エージェントの提供元へ送られます。")]),
			...(offerOperate && !upgrade
				? [localize('paradis.computerUse.approval.operate', "操作: クリック・文字入力・貼り付け・キー操作・前面に出すこともします。あなたがキーを打っている間は止まり、マウスポインタを動かす操作はマウスを使っている間も止まります。")]
				: []),
			...(offerOperate && paradisComputerUseRunsCommands(bundleId)
				? [localize('paradis.computerUse.approval.commands', "このアプリを操作すると、コマンドをあなたの権限で実行できます。")]
				: []),
			localize('paradis.computerUse.approval.scope', "選んだ内容はこのターミナルにだけ効き、Para Code を終了するまで覚えます。拒否した場合も、このターミナルからの同じアプリの求めは断ります。"),
			localize('paradis.computerUse.approval.outside', "Computer Use は、エージェントの作業フォルダやサンドボックス、許可設定の制限の外で、あなたの権限で動きます。"),
		];
		const request: IParadisAgentApprovalRequest = {
			messageTemplate: pane => wantsOperate
				? localize('paradis.computerUse.approval.messageOperate', "{0} のエージェントが、「{1}」を操作したいと求めています", pane, appName)
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

		const deadline = new ParadisApprovalDeadline(cancellation, this._deadlineMs);
		try {
			const outcome = await this._approvals.askApproval(token, request, deadline.token);
			if (outcome === 'cancelled' && deadline.timedOut) {
				// 締め切りで閉じたものは、取り消しではなく「答えが無かった」と返す（ページ共有・モバイル端末と同じ）
				return 'timedOut';
			}
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
