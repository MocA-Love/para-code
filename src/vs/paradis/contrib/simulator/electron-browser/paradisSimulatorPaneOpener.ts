/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントの端末の要求（mobile_request_device）を承認したとき、その端末の画面を「頼んだペインのスペース」に開く。
//
// - 頼んだペインが今のスペースのもの（またはスペースを使っていないウィンドウ・スペースの外の Bot のペイン）なら、
//   今までどおり今の画面に開く。Bot のペインはどのスペースにも属さず、所属を尋ねると今のスペースと答える（#1267）ので、
//   ここでは何もしなくても今のスペースに開く（Bot のタブは利用者と一緒にスペースを渡り歩くので、それが自然）。
// - 別のスペースのペインなら、今の画面は切り替えず、前にも出さない。そのスペースにピン留めした補助ウィンドウがあれば
//   そこへ、無ければ控えておき、利用者がそのスペースへ切り替えたときに開く（preview_file の予約・ブラウザのタブの
//   待ちと同じ決め方）。iOS のシミュレータは、控えている間もエージェントが使えるよう、止まっていればここで起動する。
// - 切り替えの最中に承認されたら、切り替えが済んでから決め直す。
// 控えはメモリにだけ持つ（スペースの working set は upstream の保存形式で、外から足す口が無い）。再読み込みすると消えるが、
// 端末の割り当て自体は shared process の台帳に残るので、共有ダイアログの「モバイル端末」タブから画面を開ける。

import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorGroupsService, IEditorPart } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAuxiliaryWindowScopeService, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces, paradisResolveInstanceSpace } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisAndroidAvdOf, paradisAndroidSerialOf } from '../common/paradisAndroid.js';
import { paradisSimulatorUdidOfDeviceId } from '../common/paradisSimulator.js';
import { IParadisSimulatorClient } from './paradisSimulatorClient.js';
import { paradisOpenAndroidEditor, paradisOpenSimulatorEditor } from './paradisSimulatorPlacement.js';

/** 端末の画面をどこへ開くか。 */
export type ParadisDeviceOpenWhere =
	/** 見えている画面へ開く。`parts` が無ければ今までどおりウィンドウ全体から置き場所を選ぶ。 */
	| { readonly kind: 'visible'; readonly parts?: readonly IEditorPart[] }
	/** 画面に出ていないスペース。切り替えたときに開く。 */
	| { readonly kind: 'hidden'; readonly stateKey: string }
	/** 切り替えの最中。済んでから決め直す。 */
	| { readonly kind: 'later' }
	/** ペインが閉じた・そのスペースへもう行けない。開かない。 */
	| { readonly kind: 'none' };

export interface IParadisDeviceOpenWhereServices {
	readonly paneTokenService: Pick<IParadisPaneTokenService, 'getInstanceForToken'>;
	readonly terminalScopeService: Pick<IParadisTerminalScopeService, 'getStateKeyForInstance' | 'resolveScope' | 'isSharedPanelTerminal'>;
	readonly workspaceSwitchService: Pick<IParadisWorkspaceSwitchService, 'activeStateKey' | 'isSwitching' | 'repositories'>;
	readonly worktreeService: Pick<IParadisWorktreeService, 'getWorktrees'>;
	readonly auxiliaryWindowScopeService: Pick<IParadisAuxiliaryWindowScopeService, 'getPinnedParts'>;
}

/** 頼んだペインから、端末の画面を開く先を決める。 */
export function paradisResolveDeviceOpenWhere(services: IParadisDeviceOpenWhereServices, paneToken: string): ParadisDeviceOpenWhere {
	const instanceId = services.paneTokenService.getInstanceForToken(paneToken);
	if (instanceId === undefined) {
		return { kind: 'none' };
	}
	const switchService = services.workspaceSwitchService;
	if (switchService.isSwitching) {
		return { kind: 'later' };
	}
	const active = switchService.activeStateKey;
	const stateKey = paradisResolveInstanceSpace(services.terminalScopeService, active, instanceId);
	// スペースを使っていないウィンドウ・今のスペースのペイン・所属がまだ決まっていないペインは今までどおり。
	// 所属が決まっていないのは、承認ダイアログの間にペインが再接続しているときくらいで、承認は済んでいるので開く
	if (stateKey === undefined || stateKey === active) {
		return { kind: 'visible' };
	}
	const pinned = services.auxiliaryWindowScopeService.getPinnedParts(stateKey);
	if (pinned.length > 0) {
		return { kind: 'visible', parts: pinned };
	}
	// 一覧に無いスペース（実体を失った worktree など）は、戻ってこられないので控えない
	const reachable = paradisListSpaces(switchService.repositories, services.worktreeService as IParadisWorktreeService).some(entry => entry.space === stateKey);
	return reachable ? { kind: 'hidden', stateKey } : { kind: 'none' };
}

export interface IParadisDeviceOpenDeferralHost extends IParadisDeviceOpenWhereServices {
	readonly workspaceSwitchService: IParadisDeviceOpenWhereServices['workspaceSwitchService'] & Pick<IParadisWorkspaceSwitchService, 'onDidSwitchScope' | 'onDidRetireScope'>;
	/** 見えている画面へ端末のタブを開く。 */
	open(paneToken: string, deviceId: string, parts: readonly IEditorPart[] | undefined): Promise<void>;
	/** 画面を控えた端末を、エージェントが使えるように起動する（止まっていれば）。 */
	bootWhileHidden(deviceId: string): Promise<void>;
}

/**
 * 端末の画面を、頼んだペインのスペースに開く。画面に出ていないスペースの分は控え、そのスペースへ切り替えたときに開く。
 */
export class ParadisDeviceOpenDeferrals extends Disposable {

	/** スペース → 端末 → 頼んだペイン（同じ端末を続けて頼まれたら、最後のものだけ残す）。 */
	private readonly _hidden = new Map<string, Map<string, string>>();
	/** 切り替えの最中に承認された分（端末 → 頼んだペイン）。 */
	private readonly _later = new Map<string, string>();
	private readonly _flushes = this._register(new DisposableStore());

	constructor(private readonly _host: IParadisDeviceOpenDeferralHost) {
		super();
		// 切り替えの通知の中では開かず、後片付け（working set の適用・パネルの開閉）が済んでから開く（ブラウザのタブと同じ）
		this._register(_host.workspaceSwitchService.onDidSwitchScope(stateKey => disposableTimeout(() => void this._flush(stateKey), 0, this._flushes)));
		this._register(_host.workspaceSwitchService.onDidRetireScope(stateKey => this._hidden.delete(stateKey)));
	}

	/** 控えている端末（テスト用）。 */
	waiting(): { readonly hidden: Record<string, Record<string, string>>; readonly later: Record<string, string> } {
		const hidden: Record<string, Record<string, string>> = {};
		for (const [stateKey, devices] of this._hidden) {
			hidden[stateKey] = Object.fromEntries(devices);
		}
		return { hidden, later: Object.fromEntries(this._later) };
	}

	async openForPane(paneToken: string, deviceId: string): Promise<void> {
		const where = paradisResolveDeviceOpenWhere(this._host, paneToken);
		switch (where.kind) {
			case 'visible':
				return this._host.open(paneToken, deviceId, where.parts);
			case 'hidden': {
				let devices = this._hidden.get(where.stateKey);
				if (!devices) {
					devices = new Map();
					this._hidden.set(where.stateKey, devices);
				}
				devices.set(deviceId, paneToken);
				return this._host.bootWhileHidden(deviceId);
			}
			case 'later':
				this._later.set(deviceId, paneToken);
				return;
			case 'none':
				return;
		}
	}

	private async _flush(stateKey: string): Promise<void> {
		const entries = [...this._later, ...(this._hidden.get(stateKey) ?? [])];
		this._later.clear();
		this._hidden.delete(stateKey);
		// 決め直す（まだ別のスペースなら控え直し、閉じたペインの分は捨てる）
		for (const [deviceId, paneToken] of entries) {
			await this.openForPane(paneToken, deviceId).catch(() => undefined);
		}
	}
}

export const IParadisSimulatorPaneOpener = createDecorator<IParadisSimulatorPaneOpener>('paradisSimulatorPaneOpener');

export interface IParadisSimulatorPaneOpener {
	readonly _serviceBrand: undefined;
	/** 承認した端末の画面を、頼んだペインのスペースに開く（止まっていれば起動する）。 */
	openForPane(paneToken: string, deviceId: string): Promise<void>;
}

class ParadisSimulatorPaneOpener extends Disposable implements IParadisSimulatorPaneOpener {
	declare readonly _serviceBrand: undefined;

	private readonly _deferrals: ParadisDeviceOpenDeferrals;

	constructor(
		@IParadisSimulatorClient private readonly _client: IParadisSimulatorClient,
		@INotificationService private readonly _notificationService: INotificationService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IParadisPaneTokenService paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalScopeService terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService worktreeService: IParadisWorktreeService,
		@IParadisAuxiliaryWindowScopeService auxiliaryWindowScopeService: IParadisAuxiliaryWindowScopeService,
	) {
		super();
		this._deferrals = this._register(new ParadisDeviceOpenDeferrals({
			paneTokenService,
			terminalScopeService,
			workspaceSwitchService,
			worktreeService,
			auxiliaryWindowScopeService,
			open: (paneToken, deviceId, parts) => this._open(paneTokenService.getInstanceForToken(paneToken), deviceId, parts),
			bootWhileHidden: deviceId => this._bootWhileHidden(deviceId),
		}));
	}

	async openForPane(paneToken: string, deviceId: string): Promise<void> {
		// 起動していない Android の AVD は起動だけする（画面のタブは開かないので、スペースを問わない。起動した後の画面は
		// 「シミュレータを開く」か共有ダイアログから開く）
		if (!paradisAndroidSerialOf(deviceId) && paradisAndroidAvdOf(deviceId)) {
			await this._client.bootAndroid(deviceId).catch(error => this._notificationService.error(localize('paradis.simulator.android.bootFailed', "Android のエミュレータを起動できませんでした: {0}", error instanceof Error ? error.message : String(error))));
			return;
		}
		if (!paradisAndroidSerialOf(deviceId) && !(isMacintosh && paradisSimulatorUdidOfDeviceId(deviceId))) {
			return;
		}
		await this._deferrals.openForPane(paneToken, deviceId);
	}

	/** その端末の画面をペインのターミナルの右に開き、止まっていれば起動する。 */
	private async _open(paneInstanceId: number | undefined, deviceId: string, parts: readonly IEditorPart[] | undefined): Promise<void> {
		const forPane = { paneInstanceId, ...(parts ? { parts } : {}) };
		const serial = paradisAndroidSerialOf(deviceId);
		if (serial) {
			const name = (await this._client.listAndroidDevices().catch(() => [])).find(candidate => candidate.serial === serial)?.name ?? serial;
			await paradisOpenAndroidEditor(serial, name, this._editorService, this._editorGroupsService, this._configurationService, forPane);
			return;
		}
		const udid = paradisSimulatorUdidOfDeviceId(deviceId);
		if (!udid) {
			return;
		}
		const device = (await this._client.listDevices().catch(() => [])).find(candidate => candidate.udid === udid);
		const input = await paradisOpenSimulatorEditor(udid, device?.name ?? '', this._editorService, this._editorGroupsService, this._configurationService, forPane);
		input.requestBoot();
	}

	/** 画面を控えた iOS のシミュレータを、止まっていれば起動する（タブを開いたときの起動の代わり）。Android の端末は動いている。 */
	private async _bootWhileHidden(deviceId: string): Promise<void> {
		const udid = paradisSimulatorUdidOfDeviceId(deviceId);
		if (!udid) {
			return;
		}
		const device = (await this._client.listDevices().catch(() => [])).find(candidate => candidate.udid === udid);
		if (device?.state === 'Shutdown') {
			await this._client.boot(udid).catch(error => this._notificationService.error(localize('paradis.simulator.bootFailed', "シミュレータを起動できませんでした: {0}", error instanceof Error ? error.message : String(error))));
		}
	}
}

registerSingleton(IParadisSimulatorPaneOpener, ParadisSimulatorPaneOpener, InstantiationType.Delayed);
