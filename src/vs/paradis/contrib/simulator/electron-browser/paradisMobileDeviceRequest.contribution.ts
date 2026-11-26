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
// 端末の要求は「足す」（1 つのペインに 10 台まで）。今持っている端末の一覧と、何台目になるかを見せる。上限まで
// 持っているときは、外す 1 台を利用者が選ぶ確認（paradisMobileReleasePickDialog.ts）を出し、選んだ端末の id を返す。
// ここは承認を取るだけで、台帳への割り当てとインストールは shared process が行う。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { PARADIS_SIMULATOR_OPEN_FOR_PANE_COMMAND_ID } from '../common/paradisSimulator.js';
import { PARADIS_AGENT_APPROVAL_DEADLINE_MS, paradisSanitizeAgentPageRequestReason, paradisSanitizeDisplayText } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';
import { IParadisAgentApprovalPresentation, IParadisAgentApprovalRequest, IParadisAgentBrowserTabsService, ParadisApprovalDeadline } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { PARADIS_MOBILE_MAX_DEVICES_PER_PANE } from '../common/paradisMobileAttachmentBook.js';
import { IParadisMobileReleasePick, paradisShowMobileReleasePick } from './paradisMobileReleasePickDialog.js';
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
/** 「今 N 台を渡しています（…）」の文に並べる端末名の最大文字数（10 台ぶん並んでも読める長さにする）。 */
const HELD_NAME_IN_SENTENCE_MAX_LENGTH = 32;
/** ダイアログに出すインストールするパスの最大文字数。超えたら先頭を切り、末尾（ファイル名）を残す。 */
const PATH_MAX_LENGTH = 200;
const APP_ID_MAX_LENGTH = 200;
/**
 * 端末の要求を拒否された直後、同じペインからのほかの端末の要求も断る時間。3 分の断りは端末ごとなので、
 * これが無いと端末の数だけ続けてダイアログを出せる。
 */
export const PARADIS_MOBILE_ANY_DEVICE_DENIAL_MS = 10_000;

/** 上限のときの「外す端末を選ぶ」確認を出す口（テストでは偽物を渡す）。 */
export type ParadisMobileReleasePickPresenter = (pick: IParadisMobileReleasePick, presentation: IParadisAgentApprovalPresentation) => Promise<'approve' | 'deny' | undefined>;

/** shared process から届く要求を承認ダイアログへ流すチャネル。 */
export class ParadisMobileDeviceRequestChannel implements IServerChannel {

	constructor(
		private readonly _approvals: Pick<IParadisAgentBrowserTabsService, 'askApproval' | 'approvalBlock'>,
		private readonly _paneTokens: Pick<IParadisPaneTokenService, 'getInstanceForToken'>,
		private readonly _terminalScopes: Pick<IParadisTerminalScopeService, 'getStateKeyForInstance'>,
		private readonly _now: () => number = Date.now,
		private readonly _deadlineMs: number = PARADIS_AGENT_APPROVAL_DEADLINE_MS,
		/** 端末の要求を承認したとき（シミュレータの作り直し ③: その端末の画面をペインのターミナルの右に開く）。 */
		private readonly _onDidApproveDevice?: (paneToken: string, deviceId: string) => void,
		/** 上限まで端末を持っているペインの要求で、外す端末を選ぶ確認を出す。 */
		private readonly _showReleasePick?: ParadisMobileReleasePickPresenter,
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
		// 期限を過ぎた記録はペインを問わずまとめて消す（拒否したまま閉じたペインの分がウィンドウの寿命の間たまらないように）
		const now = this._now();
		for (const [deniedToken, deniedAt] of this._lastDeviceDenial) {
			if (now - deniedAt >= PARADIS_MOBILE_ANY_DEVICE_DENIAL_MS) {
				this._lastDeviceDenial.delete(deniedToken);
			}
		}
		if (typeof token === 'string' && this._lastDeviceDenial.has(token)) {
			return { outcome: 'recentlyDenied' };
		}
		// 名前・理由はエージェントが決められる文字列なので、制御文字と双方向制御を落としてから出す
		const deviceName = deviceNameOf(prompt);
		const runtime = paradisSanitizeDisplayText(text(prompt, 'runtime'), RUNTIME_MAX_LENGTH);
		const reason = paradisSanitizeAgentPageRequestReason(text(prompt, 'reason'));
		// 今持っている端末（名前はエージェントも simctl で付けられるので、1 件ずつ無害化して長さを切る）
		const held = attachedDevicesOf(prompt);
		// 上限まで持っているときは、外す 1 台を利用者が選ぶ（選ぶ口が無ければふつうの確認を出し、台帳が上限で断る）
		const pickRelease = prompt.mustRelease === true && held.length > 0 && this._showReleasePick !== undefined;
		const heldNames = held.map(device => localize('paradis.mobileDeviceRequest.heldName', "「{0}」", paradisSanitizeDisplayText(device.name, HELD_NAME_IN_SENTENCE_MAX_LENGTH) ?? device.name)).join(localize('paradis.mobileDeviceRequest.heldSeparator', "、"));
		const detail = [
			reason ? localize('paradis.mobileDeviceRequest.reason', "エージェントが書いた理由: {0}", reason) : undefined,
			runtime
				? localize('paradis.mobileDeviceRequest.deviceWithRuntime', "使いたい端末: {0}（{1}）", deviceName, runtime)
				: localize('paradis.mobileDeviceRequest.device', "使いたい端末: {0}", deviceName),
			pickRelease
				? localize('paradis.mobileDeviceRequest.full', "このターミナルには、上限の {0} 台を渡しています。渡すには、下から外す端末を 1 台選んでください。", PARADIS_MOBILE_MAX_DEVICES_PER_PANE)
				: held.length > 0
					? localize('paradis.mobileDeviceRequest.adding', "このターミナルには今 {0} 台を渡しています（{1}）。承認すると {2} 台目として足されます（1 つのターミナルに {3} 台まで）。今の端末は外れません。", held.length, heldNames, held.length + 1, PARADIS_MOBILE_MAX_DEVICES_PER_PANE)
					: undefined,
			localize('paradis.mobileDeviceRequest.effect', "承認すると、このターミナルのエージェントはこの端末の画面を読み、タップ・入力・回転などの操作と、アプリの起動・権限の付与ができます。共有ダイアログの「モバイル端末」タブからいつでも外せます。"),
			localize('paradis.mobileDeviceRequest.install', "アプリのインストールは、そのたびに確認します。エージェントが入れたアプリは Para Code の権限で動き、エージェントの作業フォルダの制限の外に出られます。"),
		].filter((line): line is string => line !== undefined);
		// 外す端末の初めの選択は、いちばん前に渡したもの。聞き直しでも、利用者が選んだものを保つ
		const pick: IParadisMobileReleasePick | undefined = pickRelease ? {
			lines: detail,
			listLabel: localize('paradis.mobileDeviceRequest.pickLabel', "外す端末（渡した順）"),
			devices: held,
			approveLabel: localize('paradis.mobileDeviceRequest.approveRelease', "選んだ端末を外して渡す"),
			selectedId: held[0].id,
		} : undefined;
		const answer = await this._ask(token, {
			messageTemplate: pane => localize('paradis.mobileDeviceRequest.message', "{0} のエージェントが、モバイル端末を使いたいと求めています", pane),
			detail,
			approveLabel: localize('paradis.mobileDeviceRequest.approve', "この端末を渡す"),
			cooldownKey: `mobile-device:${text(prompt, 'deviceId') ?? deviceName}`,
			...(pick ? { present: (presentation: IParadisAgentApprovalPresentation) => this._showReleasePick!(pick, presentation) } : {}),
		}, cancellation);
		if (answer.outcome === 'denied' && typeof token === 'string') {
			this._lastDeviceDenial.set(token, this._now());
		}
		const deviceId = text(prompt, 'deviceId');
		if (answer.outcome === 'approved' && typeof token === 'string' && deviceId) {
			this._onDidApproveDevice?.(token, deviceId);
		}
		// 選んだ端末は、shared process の台帳が「そのペインの割り当てか」を確かめてから外す
		return answer.outcome === 'approved' && pick ? { ...answer, releaseDeviceId: pick.selectedId } : answer;
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

/** 要求に付いてきた「今持っている端末」。形の違うものは落とし、名前は無害化して長さを切る。上限の数までしか読まない。 */
function attachedDevicesOf(prompt: Record<string, unknown>): { readonly id: string; readonly name: string }[] {
	const raw = Array.isArray(prompt.attachedDevices) ? prompt.attachedDevices.slice(0, PARADIS_MOBILE_MAX_DEVICES_PER_PANE) : [];
	const devices: { id: string; name: string }[] = [];
	for (const entry of raw) {
		const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
		if (typeof record.id === 'string' && record.id) {
			devices.push({ id: record.id, name: paradisSanitizeDisplayText(typeof record.name === 'string' ? record.name : undefined, DEVICE_NAME_MAX_LENGTH) || localize('paradis.mobileDeviceRequest.unnamed', "名前のない端末") });
		}
	}
	return devices;
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
		@ICommandService commandService: ICommandService,
		@ILayoutService layoutService: ILayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHostService hostService: IHostService,
	) {
		super();
		// 承認した端末の画面を開く（simulator/electron-browser/paradisSimulator.contribution.ts）。iOS のシミュレータは
		// 開いて起動し、動いている Android の端末は開き、起動していない Android の AVD は起動だけする
		const openSimulator = (paneToken: string, deviceId: string) => void commandService.executeCommand(PARADIS_SIMULATOR_OPEN_FOR_PANE_COMMAND_ID, paneToken, deviceId).catch(() => undefined);
		sharedProcessService.registerChannel(PARADIS_MOBILE_DEVICE_REQUEST_CHANNEL, new ParadisMobileDeviceRequestChannel(approvals, paneTokens, terminalScopes, Date.now, PARADIS_AGENT_APPROVAL_DEADLINE_MS, openSimulator,
			(pick, presentation) => paradisShowMobileReleasePick({ layoutService, keybindingService, hostService }, pick, presentation)));
	}
}

registerWorkbenchContribution2(ParadisMobileDeviceRequestContribution.ID, ParadisMobileDeviceRequestContribution, WorkbenchPhase.AfterRestored);
