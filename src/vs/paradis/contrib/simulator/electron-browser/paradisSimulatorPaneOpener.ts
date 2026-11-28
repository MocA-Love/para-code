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
// - どのスペースのペインか分からない（再起動の復元で所属を引けず待避されたターミナル・一覧に無いスペース）なら、
//   勝手に別のスペースへ置かず、今のスペースに裏のタブで開く（前に出さない）。確認の文でも「分からない」と伝える。
// - 切り替えの最中に承認されたら、切り替えが済んでから決め直す。
// 確認の文（paradisMobileDeviceRequest.contribution.ts）も {@link paradisDescribeDeviceOpenSpace} で同じ判定を使う。
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
import { IParadisAuxiliaryWindowScopeService, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisIsSettledOnSpace, paradisListSpaces, paradisResolveInstanceSpace } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisAndroidAvdOf, paradisAndroidSerialOf } from '../common/paradisAndroid.js';
import { paradisSimulatorUdidOfDeviceId } from '../common/paradisSimulator.js';
import { IParadisMobileCanvasModel } from './paradisMobileCanvasModel.js';
import { IParadisSimulatorClient } from './paradisSimulatorClient.js';
import { IParadisSimulatorOpenForPane, paradisOpenAndroidEditor, paradisOpenSimulatorEditor } from './paradisSimulatorPlacement.js';

/** 見えている画面へ開くときの置き方。 */
export interface IParadisDeviceOpenVisible {
	readonly kind: 'visible';
	/** 置いてよいエディタ部分だけ（頼んだペインのスペースにピン留めした補助ウィンドウ）。 */
	readonly parts?: readonly IEditorPart[];
	/** 置かないエディタ部分（ほかのスペースにピン留めした補助ウィンドウ）。 */
	readonly exclude?: readonly IEditorPart[];
	/** 開く先のスペース（今のスペースでない補助ウィンドウへ開くとき）。 */
	readonly stateKey?: string;
	/** どのスペースのペインか分からない。今のスペースに裏のタブで開く。 */
	readonly unknownSpace?: true;
}

/** 端末の画面をどこへ開くか。 */
export type ParadisDeviceOpenWhere =
	| IParadisDeviceOpenVisible
	/** 画面に出ていないスペース。切り替えたときに開く。 */
	| { readonly kind: 'hidden'; readonly stateKey: string }
	/** 切り替えの最中。済んでから決め直す。 */
	| { readonly kind: 'later' }
	/** ペインが閉じた。何もしない。 */
	| { readonly kind: 'closed' };

export interface IParadisDeviceOpenWhereServices {
	readonly paneTokenService: Pick<IParadisPaneTokenService, 'getInstanceForToken'>;
	readonly terminalScopeService: Pick<IParadisTerminalScopeService, 'getStateKeyForInstance' | 'resolveScope' | 'isSharedPanelTerminal'>;
	readonly workspaceSwitchService: Pick<IParadisWorkspaceSwitchService, 'activeStateKey' | 'isSwitching' | 'pendingSwitchTargetKey' | 'repositories'>;
	readonly worktreeService: Pick<IParadisWorktreeService, 'getWorktrees'>;
	readonly auxiliaryWindowScopeService: Pick<IParadisAuxiliaryWindowScopeService, 'getPinnedParts'>;
}

/** 頼んだペインから、端末の画面を開く先を決める。 */
export function paradisResolveDeviceOpenWhere(services: IParadisDeviceOpenWhereServices, paneToken: string): ParadisDeviceOpenWhere {
	const instanceId = services.paneTokenService.getInstanceForToken(paneToken);
	if (instanceId === undefined) {
		return { kind: 'closed' };
	}
	const switchService = services.workspaceSwitchService;
	const active = switchService.activeStateKey;
	// 切り替えの最中か、次の切り替えが始まっている（行き先が今のスペースでない）。済んでから決め直す
	if (switchService.isSwitching || (switchService.pendingSwitchTargetKey !== undefined && switchService.pendingSwitchTargetKey !== active)) {
		return { kind: 'later' };
	}
	if (active === undefined) {
		// スペースを使っていないウィンドウ。振り分ける相手がいないので今までどおり
		return { kind: 'visible' };
	}
	const pinnedElsewhere = (stateKey: string | undefined) => services.auxiliaryWindowScopeService.getPinnedParts().filter(part => !services.auxiliaryWindowScopeService.getPinnedParts(stateKey).includes(part));
	const stateKey = paradisResolveInstanceSpace(services.terminalScopeService, active, instanceId);
	if (stateKey === active) {
		return { kind: 'visible', exclude: pinnedElsewhere(active) };
	}
	// 所属が分からない（復元で所属を引けず待避された・まだ決まっていない）か、一覧に無いスペース（実体を失った worktree、
	// 所属の分からないターミナルの置き場）。勝手に別のスペースへ置かず、今のスペースに裏のタブで開く
	const reachable = stateKey !== undefined && paradisListSpaces(switchService.repositories, services.worktreeService as IParadisWorktreeService).some(entry => entry.space === stateKey);
	if (stateKey === undefined || !reachable) {
		return { kind: 'visible', exclude: pinnedElsewhere(active), unknownSpace: true };
	}
	const pinned = services.auxiliaryWindowScopeService.getPinnedParts(stateKey);
	if (pinned.length > 0) {
		return { kind: 'visible', parts: pinned, stateKey };
	}
	return { kind: 'hidden', stateKey };
}

/** 確認の文に出す、開く先のスペース。今のスペースに今までどおり開くなら undefined。 */
export type ParadisDeviceOpenSpaceNote =
	| { readonly kind: 'otherSpace'; readonly name: string }
	| { readonly kind: 'unknownSpace' };

/** 確認の文のための、開く先のスペース（開くときと同じ {@link paradisResolveDeviceOpenWhere} で決める）。 */
export function paradisDescribeDeviceOpenSpace(services: IParadisDeviceOpenWhereServices, paneToken: string): ParadisDeviceOpenSpaceNote | undefined {
	const where = paradisResolveDeviceOpenWhere(services, paneToken);
	if (where.kind === 'visible' && where.unknownSpace) {
		return { kind: 'unknownSpace' };
	}
	const stateKey = where.kind === 'hidden' || where.kind === 'visible' ? where.stateKey : undefined;
	if (stateKey === undefined) {
		return undefined;
	}
	const name = paradisListSpaces(services.workspaceSwitchService.repositories, services.worktreeService as IParadisWorktreeService).find(entry => entry.space === stateKey)?.name;
	return name ? { kind: 'otherSpace', name } : { kind: 'unknownSpace' };
}

export interface IParadisDeviceOpenDeferralHost extends IParadisDeviceOpenWhereServices {
	readonly workspaceSwitchService: IParadisDeviceOpenWhereServices['workspaceSwitchService'] & Pick<IParadisWorkspaceSwitchService, 'onDidSwitchScope' | 'onDidRetireScope'>;
	/**
	 * 見えている画面へ端末のタブを開く。開く前に待つもの（端末の名前の取得など）がある間に今のスペースが変わったら、
	 * `unchanged()` が false になる。そのときは開かずに {@link ParadisDeviceOpenDeferrals.openForPane} からやり直す。
	 */
	open(paneToken: string, deviceId: string, where: IParadisDeviceOpenVisible, unchanged: () => boolean): Promise<void>;
	/** 画面を控えた端末を、エージェントが使えるように起動する（止まっていれば）。 */
	bootWhileHidden(deviceId: string): Promise<void>;
	/** そのペインにその端末がまだ割り当てられているか（控えている間に外されたら開かない）。 */
	isStillAttached(paneToken: string, deviceId: string): Promise<boolean>;
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
			case 'visible': {
				const switchService = this._host.workspaceSwitchService;
				const active = switchService.activeStateKey;
				// 開く直前も、次の切り替えが始まっていないか（行き先が立っていないか）まで見る
				return this._host.open(paneToken, deviceId, where, () => !switchService.isSwitching && (active === undefined ? switchService.activeStateKey === undefined : paradisIsSettledOnSpace(switchService, active)));
			}
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
			case 'closed':
				return;
		}
	}

	private async _flush(stateKey: string): Promise<void> {
		const entries = [...this._later, ...(this._hidden.get(stateKey) ?? [])];
		this._later.clear();
		this._hidden.delete(stateKey);
		// 決め直す（まだ別のスペースなら控え直し、閉じたペイン・外された端末の分は捨てる）
		for (const [deviceId, paneToken] of entries) {
			if (!await this._host.isStillAttached(paneToken, deviceId).catch(() => true)) {
				continue;
			}
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
		@IParadisMobileCanvasModel private readonly _mobileCanvasModel: IParadisMobileCanvasModel,
	) {
		super();
		this._deferrals = this._register(new ParadisDeviceOpenDeferrals({
			paneTokenService,
			terminalScopeService,
			workspaceSwitchService,
			worktreeService,
			auxiliaryWindowScopeService,
			open: (paneToken, deviceId, where, unchanged) => this._open(paneToken, paneTokenService.getInstanceForToken(paneToken), deviceId, where, unchanged),
			bootWhileHidden: deviceId => this._bootWhileHidden(deviceId),
			isStillAttached: async (paneToken, deviceId) => {
				await this._mobileCanvasModel.refresh();
				const snapshot = this._mobileCanvasModel.snapshot;
				// 台帳を読めなかったときは、外されたとは言えないので開く
				return snapshot.unavailableReason !== undefined || snapshot.attachments.some(attachment => attachment.paneToken === paneToken && attachment.deviceId === deviceId);
			},
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
	private async _open(paneToken: string, paneInstanceId: number | undefined, deviceId: string, where: IParadisDeviceOpenVisible, unchanged: () => boolean): Promise<void> {
		const forPane: IParadisSimulatorOpenForPane = {
			paneInstanceId,
			...(where.parts ? { parts: where.parts } : {}),
			...(where.exclude ? { exclude: where.exclude } : {}),
			...(where.unknownSpace ? { inactive: true } : {}),
		};
		const serial = paradisAndroidSerialOf(deviceId);
		if (serial) {
			const name = (await this._client.listAndroidDevices().catch(() => [])).find(candidate => candidate.serial === serial)?.name ?? serial;
			// 名前を待つ間にスペースが切り替わったら、開く先を決め直す（切り替え先に開かない）
			if (!unchanged()) {
				return this._deferrals.openForPane(paneToken, deviceId);
			}
			await paradisOpenAndroidEditor(serial, name, this._editorService, this._editorGroupsService, this._configurationService, forPane);
			return;
		}
		const udid = paradisSimulatorUdidOfDeviceId(deviceId);
		if (!udid) {
			return;
		}
		const device = (await this._client.listDevices().catch(() => [])).find(candidate => candidate.udid === udid);
		if (!unchanged()) {
			return this._deferrals.openForPane(paneToken, deviceId);
		}
		const input = await paradisOpenSimulatorEditor(udid, device?.name ?? '', this._editorService, this._editorGroupsService, this._configurationService, forPane);
		input.requestBoot();
	}

	/**
	 * 画面を控えた（または開けるスペースが無い）iOS のシミュレータを、止まっていれば起動する（タブを開いたときの起動の代わり）。
	 * Android の端末は動いている。
	 */
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
