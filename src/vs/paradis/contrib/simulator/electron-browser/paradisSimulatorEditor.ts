/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータのエディタのペイン（q.html Q582 の画面案 1）。上の帯に機種名・OS と、回転・ホーム・保存・起動 / 停止の
// ボタン、その下に映像（paradisSimulatorFrameView.ts）。
//
//  - 映像は見えている間だけ購読する。見えなくなったら外す（端末のセッションはホストに残る）
//  - 復元したタブは、端末が落ちていれば「起動」のボタンを出し、勝手に起動しない
//  - Device Hub が入力を奪っているときは注意を出す（見えている間だけ 5 秒ごとに確かめる。向きもこのとき読み直す）
//  - 映像が途切れたら（端末が止まった・ホストが起きない・流れが切れた）、すぐに理由と「再試行」を出し、裏で間を
//    延ばしながら様子を読み直して購読し直す。知らせを消すのは 1 枚描けたときだけ（読み直しのたびに消すと、
//    使い切るまでの約 100 秒、黒いまま何も出なかった）

import './media/paradisSimulator.css';
import * as dom from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisSimulatorDevice } from '../common/paradisSimulator.js';
import { paradisSimulatorDuoPanel, paradisSimulatorNextOrientation, paradisSimulatorStallReason, paradisSimulatorStallRetryDelay } from '../common/paradisSimulatorInput.js';
import { ParadisSimulatorFoldBar, ParadisSimulatorFoldRequest } from './paradisSimulatorFoldBar.js';
import { IParadisSimulatorClient } from './paradisSimulatorClient.js';
import { PARADIS_SIMULATOR_EDITOR_ID, ParadisSimulatorEditorInput } from './paradisSimulatorEditorInput.js';
import { ParadisSimulatorFrameView } from './paradisSimulatorFrameView.js';

const $ = dom.$;

const DEVICE_HUB_POLL_MS = 5000;


/** 帯の下に出す知らせの種類。 */
type ParadisSimulatorNotice =
	| { readonly kind: 'none' }
	| { readonly kind: 'unsupported' }
	| { readonly kind: 'missing' }
	| { readonly kind: 'shutdown' }
	| { readonly kind: 'booting' }
	| { readonly kind: 'stalled'; readonly reason?: string }
	| { readonly kind: 'error'; readonly message: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 1 つのタブ（端末 1 台）を映している間の状態。タブを替える・閉じるときに丸ごと捨てる。 */
class ParadisSimulatorEditorSession extends DisposableStore {
	device: IParadisSimulatorDevice | undefined;
	readonly frameView: ParadisSimulatorFrameView;
	/** 折りたたみの端末の、最後に読んだ様子（折りたたみでなければ undefined）。 */
	fold: { hingeDegrees: number; activeDisplay: 'cover' | 'inner' } | undefined;
	deviceHubRunning: boolean | undefined;
	folding = false;
	foldError: string | undefined;
	/** 開閉の最中に来た求めのうち最後の 1 つ（スライダーを離した値など。終わった後に送り直す）。 */
	pendingFold: ParadisSimulatorFoldRequest | undefined;
	/** 外の画面が映っていたときの最後の 1 枚（内の画面のときに小窓へ出す）。 */
	coverFrame: Uint8Array | undefined;
	readonly coverMini: HTMLImageElement;
	private _coverUrl: string | undefined;

	constructor(readonly input: ParadisSimulatorEditorInput, stage: HTMLElement, client: IParadisSimulatorClient) {
		super();
		this.frameView = this.add(new ParadisSimulatorFrameView(stage, input.udid, client));
		this.coverMini = dom.append(stage, $<HTMLImageElement>('img.paradis-simulator-cover-mini'));
		this.coverMini.alt = localize('paradis.simulator.coverMiniAlt', "外の画面（閉じていたときの最後の画面）");
		this.coverMini.style.display = 'none';
		this.add({
			dispose: () => {
				this._revokeCover();
				this.coverMini.remove();
			}
		});
	}

	/** 内の画面を映していて、外の画面の 1 枚があるときだけ小窓に出す。 */
	renderCoverMini(): void {
		const show = this.fold?.activeDisplay === 'inner' && !!this.coverFrame;
		if (!show) {
			this.coverMini.style.display = 'none';
			this._revokeCover();
			return;
		}
		if (!this._coverUrl) {
			this._coverUrl = URL.createObjectURL(new Blob([this.coverFrame!.slice()], { type: 'image/jpeg' }));
			this.coverMini.src = this._coverUrl;
		}
		this.coverMini.style.display = '';
	}

	/** 外の画面の 1 枚を差し替えた（小窓の画像を作り直す）。 */
	setCoverFrame(frame: Uint8Array): void {
		this.coverFrame = frame;
		this._revokeCover();
	}

	private _revokeCover(): void {
		if (this._coverUrl) {
			URL.revokeObjectURL(this._coverUrl);
			this._coverUrl = undefined;
			this.coverMini.removeAttribute('src');
		}
	}

	get booted(): boolean {
		return this.device?.state === 'Booted';
	}
}

export class ParadisSimulatorEditor extends EditorPane {

	static readonly ID = PARADIS_SIMULATOR_EDITOR_ID;

	private _root: HTMLElement | undefined;
	private _title: HTMLElement | undefined;
	private _subtitle: HTMLElement | undefined;
	private _notice: HTMLElement | undefined;
	private _noticeText: HTMLElement | undefined;
	private _noticeAction: Button | undefined;
	private _deviceHub: HTMLElement | undefined;
	private _stage: HTMLElement | undefined;
	private _bar: HTMLElement | undefined;
	private readonly _buttons: { rotate?: Button; home?: Button; save?: Button; power?: Button } = {};

	private readonly _session = this._register(new MutableDisposable<ParadisSimulatorEditorSession>());
	private readonly _deviceHubTimer = this._register(new IntervalTimer());
	private readonly _stallRetry = this._register(new MutableDisposable());
	private _stallCount = 0;
	private _keyHint: HTMLElement | undefined;
	private _foldBar: ParadisSimulatorFoldBar | undefined;
	private _noticeState: ParadisSimulatorNotice = { kind: 'none' };
	private _lastDimension: dom.Dimension | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IParadisSimulatorClient private readonly _client: IParadisSimulatorClient,
		@INotificationService private readonly _notificationService: INotificationService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super(PARADIS_SIMULATOR_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = dom.append(parent, $('.paradis-simulator-editor'));
		this._bar = dom.append(this._root, $('.paradis-simulator-bar'));
		const titles = dom.append(this._bar, $('.paradis-simulator-titles'));
		this._title = dom.append(titles, $('span.paradis-simulator-title'));
		this._subtitle = dom.append(titles, $('span.paradis-simulator-subtitle'));
		this._keyHint = dom.append(this._bar, $('span.paradis-simulator-key-hint'));
		this._keyHint.textContent = localize('paradis.simulator.keyHint', "キー入力は端末へ届きます。Esc を 2 回で外へ");
		const actions = dom.append(this._bar, $('.paradis-simulator-actions'));
		const button = (label: string, run: () => Promise<void>) => {
			const created = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true, small: true, title: label }));
			created.label = label;
			this._register(created.onDidClick(() => void run().catch(error => this._notificationService.error(localize('paradis.simulator.actionFailed', "シミュレータの操作に失敗しました: {0}", errorMessage(error))))));
			return created;
		};
		this._buttons.rotate = button(localize('paradis.simulator.rotate', "回転"), () => this._rotate());
		this._buttons.home = button(localize('paradis.simulator.home', "ホーム"), () => this._press('home'));
		this._buttons.save = button(localize('paradis.simulator.save', "保存"), () => this._saveScreenshot());
		this._buttons.power = button(localize('paradis.simulator.shutdown', "停止"), () => this._togglePower());

		this._foldBar = this._register(new ParadisSimulatorFoldBar(this._root));
		this._register(this._foldBar.onDidRequestFold(request => void this._fold(request)));
		this._register(this._foldBar.onDidRequestDeviceHub(() => void this._openDeviceHub()));

		this._deviceHub = dom.append(this._root, $('.paradis-simulator-device-hub'));
		this._deviceHub.textContent = localize('paradis.simulator.deviceHub', "Device Hub がこの端末の入力を使っています。タップやキーが届かないときは Device Hub を閉じてください。");
		this._deviceHub.style.display = 'none';

		this._notice = dom.append(this._root, $('.paradis-simulator-notice'));
		this._noticeText = dom.append(this._notice, $('span.paradis-simulator-notice-text'));
		this._noticeAction = this._register(new Button(this._notice, { ...defaultButtonStyles }));
		this._register(this._noticeAction.onDidClick(() => {
			if (this._noticeState.kind === 'stalled') {
				this._retryAfterStall();
			} else {
				void this._boot();
			}
		}));

		this._stage = dom.append(this._root, $('.paradis-simulator-stage'));
		this._renderNotice();
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof ParadisSimulatorEditorInput) || !this._stage) {
			return;
		}
		if (this._session.value?.input === input) {
			return;
		}
		const session = new ParadisSimulatorEditorSession(input, this._stage, this._client);
		this._session.value = session;
		// 同じペインで別の端末のタブへ替えた: 前の端末の途切れの知らせと読み直しを持ち越さない
		this._stallRetry.clear();
		this._stallCount = 0;
		this._setNotice({ kind: 'none' });
		session.add(session.frameView.onDidChangeFrameSize(() => {
			this._relayout();
			void this._readScreenConfig(session);
		}));
		session.add(input.onDidRequestBoot(() => void this._bootIfRequested(session)));
		session.add(session.frameView.onDidStall(reason => this._onStall(session, reason)));
		session.add(session.frameView.onDidDrawFrame(() => {
			this._stallCount = 0;
			if (this._noticeState.kind === 'stalled') {
				this._setNotice({ kind: 'none' });
			}
			// 外の画面を映している間の 1 枚を覚えておき、内の画面に替わったら小窓に出す
			if (session.fold?.activeDisplay === 'cover' && session.frameView.currentFrame) {
				session.setCoverFrame(session.frameView.currentFrame);
			}
		}));
		session.add(session.frameView.onDidRequestExit(() => this._buttons.rotate?.focus()));
		session.add(session.frameView.onDidFail(error => this._setNotice({ kind: 'error', message: error.message })));
		this._renderHeader();
		this._relayout();
		await this._refresh(session);
		await this._bootIfRequested(session);
	}

	/** エージェントの要求を承認して開いたタブは、止まっていれば起動する（利用者が開いたタブは勝手に起動しない）。 */
	private async _bootIfRequested(session: ParadisSimulatorEditorSession): Promise<void> {
		if (this._session.value !== session || !session.input.takeBootRequest()) {
			return;
		}
		if (!session.device) {
			await this._refresh(session);
		}
		if (session.device && session.device.state === 'Shutdown') {
			await this._boot();
		}
	}

	override clearInput(): void {
		// タブを閉じた・別のタブへ替えた: 映像の購読と Blob URL を放す
		this._session.clear();
		this._foldBar?.update(undefined);
		this._stallRetry.clear();
		this._stallCount = 0;
		this._deviceHubTimer.cancel();
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this._updateStreaming();
	}

	override layout(dimension: dom.Dimension): void {
		this._lastDimension = dimension;
		this._relayout();
	}

	override focus(): void {
		super.focus();
		this._session.value?.frameView.focus();
	}

	/** 端末の様子を読み直し、帯・知らせ・映像の購読を合わせる。 */
	private async _refresh(session: ParadisSimulatorEditorSession): Promise<void> {
		try {
			const status = await this._client.getStatus();
			if (this._session.value !== session) {
				return;
			}
			if (!status.supported) {
				session.device = undefined;
				this._setNotice({ kind: 'unsupported' });
				return;
			}
			const devices = await this._client.listDevices();
			if (this._session.value !== session) {
				return;
			}
			session.device = devices.find(device => device.udid === session.input.udid);
			if (session.device) {
				session.input.setDeviceName(session.device.name);
			}
			// 起動しているなら、映像が届かない知らせは残す（消すのは 1 枚描けたとき）
			const streaming: ParadisSimulatorNotice = this._noticeState.kind === 'stalled' ? this._noticeState : { kind: 'none' };
			this._setNotice(!session.device ? { kind: 'missing' } : session.booted ? streaming : session.device.state === 'Booting' ? { kind: 'booting' } : { kind: 'shutdown' });
		} catch (error) {
			if (this._session.value === session) {
				this._setNotice({ kind: 'error', message: errorMessage(error) });
			}
		} finally {
			if (this._session.value === session) {
				this._renderHeader();
				this._updateStreaming();
			}
		}
	}

	private _updateStreaming(): void {
		const session = this._session.value;
		if (!session) {
			this._deviceHubTimer.cancel();
			return;
		}
		if (this.isVisible() && session.booted) {
			session.frameView.start();
			this._deviceHubTimer.cancelAndSet(() => {
				void this._checkDeviceHub(session);
				void this._readScreenConfig(session);
			}, DEVICE_HUB_POLL_MS);
			void this._checkDeviceHub(session);
			void this._readScreenConfig(session);
		} else {
			session.frameView.stop();
			this._deviceHubTimer.cancel();
		}
	}

	/**
	 * 映像が途切れた。購読を止め、すぐに理由と「再試行」を出す。理由は shared process から届いたもの、無ければ
	 * ホストが起きない理由（`getStatus`）。裏では待ってから様子を読み直し（起動中なら購読し直す）、待ちは回目ごとに
	 * 延ばして、使い切ったら止める（「再試行」で数え直す）。
	 */
	private _onStall(session: ParadisSimulatorEditorSession, streamReason: string | undefined): void {
		session.frameView.stop();
		const reason = paradisSimulatorStallReason(streamReason, undefined);
		this._setNotice({ kind: 'stalled', reason });
		if (!reason) {
			void this._client.getStatus().then(status => {
				const hostError = paradisSimulatorStallReason(undefined, status.hostError);
				if (hostError && this._session.value === session && this._noticeState.kind === 'stalled' && !this._noticeState.reason) {
					this._setNotice({ kind: 'stalled', reason: hostError });
				}
			}, () => undefined);
		}
		const delay = paradisSimulatorStallRetryDelay(this._stallCount);
		this._stallCount++;
		if (delay === undefined) {
			return;
		}
		const timer = setTimeout(() => {
			if (this._session.value === session) {
				void this._refresh(session);
			}
		}, delay);
		this._stallRetry.value = { dispose: () => clearTimeout(timer) };
	}

	private _retryAfterStall(): void {
		const session = this._session.value;
		this._stallCount = 0;
		this._stallRetry.clear();
		if (session) {
			this._setNotice({ kind: 'none' });
			void this._refresh(session);
		}
	}

	/** 端末の向きを読み直す（エージェントや Simulator.app で回されたときも、映像の回し方と入力の座標を合わせる）。 */
	private async _readScreenConfig(session: ParadisSimulatorEditorSession): Promise<void> {
		try {
			const config = await this._client.getScreenConfig(session.input.udid);
			if (this._session.value === session) {
				session.frameView.setScreenConfig(config);
				const panel = paradisSimulatorDuoPanel(config);
				const wasFoldable = !!session.fold;
				session.fold = config.hingeDegrees !== undefined && panel ? { hingeDegrees: config.hingeDegrees, activeDisplay: panel } : undefined;
				if (session.fold && (!wasFoldable || session.deviceHubRunning === undefined)) {
					session.deviceHubRunning = await this._client.deviceHubRunning().catch(() => undefined);
				}
				this._renderFold(session);
			}
		} catch {
			// 映像の流れが始まる前は無いことがある。次の読み直しで合わせる
		}
	}

	private _renderFold(session: ParadisSimulatorEditorSession): void {
		if (this._session.value !== session) {
			return;
		}
		this._foldBar?.update(session.fold ? { ...session.fold, deviceHubRunning: session.deviceHubRunning, busy: session.folding, error: session.foldError } : undefined);
		session.renderCoverMini();
		this._relayout();
	}

	private async _fold(request: ParadisSimulatorFoldRequest): Promise<void> {
		const session = this._session.value;
		if (!session?.fold) {
			return;
		}
		if (session.folding) {
			// 最中に来た値は捨てずに、最後の 1 つだけ覚えて終わった後に送る
			session.pendingFold = request;
			return;
		}
		session.folding = true;
		session.foldError = undefined;
		this._renderFold(session);
		try {
			const { ok } = await this._client.fold(session.input.udid, request.kind === 'pose' ? { pose: request.pose } : { hinge: request.hinge });
			if (!ok) {
				// 開閉は Device Hub が起動していないと断られる（Mac で実測）。起動しているか読み直して、案内を出す
				session.deviceHubRunning = await this._client.deviceHubRunning().catch(() => undefined);
				session.foldError = session.deviceHubRunning === false
					? localize('paradis.simulator.fold.refusedNoHub', "開閉できませんでした。Device Hub が起動していません。「Device Hub を起動」を押してから、もう一度試してください。")
					: localize('paradis.simulator.fold.refused', "開閉できませんでした。Xcode の Device Hub が起動しているか確かめてから、もう一度試してください。");
			}
		} catch (error) {
			session.foldError = localize('paradis.simulator.fold.failed', "開閉に失敗しました: {0}", errorMessage(error));
		} finally {
			session.folding = false;
		}
		await this._readScreenConfig(session);
		this._renderFold(session);
		const next = session.pendingFold;
		session.pendingFold = undefined;
		if (next && this._session.value === session) {
			await this._fold(next);
		}
	}

	private async _openDeviceHub(): Promise<void> {
		const session = this._session.value;
		try {
			await this._client.openDeviceHub();
		} catch (error) {
			this._notificationService.error(localize('paradis.simulator.deviceHub.openFailed', "Device Hub を起動できませんでした: {0}", errorMessage(error)));
		}
		if (session) {
			session.deviceHubRunning = await this._client.deviceHubRunning().catch(() => undefined);
			session.foldError = undefined;
			this._renderFold(session);
		}
	}

	private async _checkDeviceHub(session: ParadisSimulatorEditorSession): Promise<void> {
		let active = false;
		try {
			active = await this._client.deviceHubActive(session.input.udid);
		} catch {
			// 確かめられないときは出さない
		}
		if (this._session.value === session && this._deviceHub) {
			this._deviceHub.style.display = active ? '' : 'none';
			this._relayout();
		}
		// 折りたたみの端末なら、Device Hub が起動しているかも読み直す（開閉のバーの案内のため）
		if (this._session.value === session && session.fold) {
			const running = await this._client.deviceHubRunning().catch(() => undefined);
			if (running !== session.deviceHubRunning) {
				session.deviceHubRunning = running;
				this._renderFold(session);
			}
		}
	}

	private _setNotice(notice: ParadisSimulatorNotice): void {
		this._noticeState = notice;
		this._renderNotice();
		this._relayout();
	}

	private _renderNotice(): void {
		if (!this._notice || !this._noticeText || !this._noticeAction) {
			return;
		}
		const notice = this._noticeState;
		const text = (() => {
			switch (notice.kind) {
				case 'none': return '';
				case 'unsupported': return localize('paradis.simulator.notice.unsupported', "iOS のシミュレータは macOS でだけ使えます。");
				case 'missing': return localize('paradis.simulator.notice.missing', "この端末が見つかりません。Xcode で消された可能性があります。");
				case 'shutdown': return localize('paradis.simulator.notice.shutdown', "この端末は起動していません。");
				case 'booting': return localize('paradis.simulator.notice.booting', "起動しています…");
				case 'error': return localize('paradis.simulator.notice.error', "シミュレータとつながりませんでした: {0}", notice.message);
				case 'stalled': return notice.reason
					? localize('paradis.simulator.notice.stalledReason', "映像が届きません: {0}", notice.reason)
					: localize('paradis.simulator.notice.stalledNoReason', "映像が届きません。シミュレータのホストから映像が来ていません。");
			}
		})();
		this._notice.style.display = notice.kind === 'none' ? 'none' : '';
		this._noticeText.textContent = text;
		const action = notice.kind === 'shutdown' ? localize('paradis.simulator.boot', "起動") : notice.kind === 'stalled' ? localize('paradis.simulator.retry', "再試行") : undefined;
		this._noticeAction.element.style.display = action ? '' : 'none';
		this._noticeAction.label = action ?? '';
	}

	private _renderHeader(): void {
		const session = this._session.value;
		if (!this._title || !this._subtitle) {
			return;
		}
		this._title.textContent = session?.input.getName() ?? '';
		this._subtitle.textContent = session?.device?.runtime ?? '';
		const booted = !!session?.booted;
		for (const key of ['rotate', 'home', 'save'] as const) {
			this._buttons[key]!.enabled = booted;
		}
		const power = this._buttons.power!;
		power.enabled = !!session?.device && session.device.state !== 'Booting' && session.device.state !== 'ShuttingDown';
		power.label = booted ? localize('paradis.simulator.shutdown', "停止") : localize('paradis.simulator.boot', "起動");
	}

	private _relayout(): void {
		const session = this._session.value;
		if (!session || !this._root || !this._lastDimension) {
			return;
		}
		const used = [...this._root.children].filter(child => child !== this._stage).reduce((sum, child) => sum + (child as HTMLElement).offsetHeight, 0);
		// 映像のまわりに少し余白を残す
		session.frameView.layout({ width: Math.max(0, this._lastDimension.width - 24), height: Math.max(0, this._lastDimension.height - used - 24) });
	}

	private _requireBooted(): ParadisSimulatorEditorSession {
		const session = this._session.value;
		if (!session?.booted) {
			throw new Error(localize('paradis.simulator.notBooted', "端末が起動していません"));
		}
		return session;
	}

	private async _rotate(): Promise<void> {
		const session = this._requireBooted();
		const config = await this._client.getScreenConfig(session.input.udid);
		await this._client.sendInput(session.input.udid, { kind: 'rotate', orientation: paradisSimulatorNextOrientation(config.orientation) });
		await this._readScreenConfig(session);
	}

	private async _press(button: string): Promise<void> {
		const session = this._requireBooted();
		await this._client.sendInput(session.input.udid, { kind: 'button', button });
	}

	private async _saveScreenshot(): Promise<void> {
		const session = this._requireBooted();
		const jpeg = await this._client.captureFrame(session.input.udid);
		const name = `${session.input.getName().replace(/[\\/:*?"<>|]+/g, '-')}.jpg`;
		const target = await this._fileDialogService.showSaveDialog({
			defaultUri: joinPath(await this._fileDialogService.defaultFilePath(), name),
			filters: [{ name: localize('paradis.simulator.jpegFilter', "JPEG 画像"), extensions: ['jpg'] }],
		});
		if (target) {
			await this._fileService.writeFile(target, jpeg);
		}
	}

	private async _boot(): Promise<void> {
		const session = this._session.value;
		if (!session?.device) {
			return;
		}
		this._setNotice({ kind: 'booting' });
		try {
			await this._client.boot(session.input.udid);
		} catch (error) {
			if (this._session.value === session) {
				this._setNotice({ kind: 'error', message: errorMessage(error) });
			}
			return;
		}
		await this._refresh(session);
	}

	private async _togglePower(): Promise<void> {
		const session = this._session.value;
		if (!session?.device) {
			return;
		}
		if (!session.booted) {
			return this._boot();
		}
		session.frameView.stop();
		await this._client.shutdown(session.input.udid);
		await this._refresh(session);
	}
}
