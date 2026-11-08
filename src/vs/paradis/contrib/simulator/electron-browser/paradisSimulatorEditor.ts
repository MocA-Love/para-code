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
//  - Device Hub が入力を奪っているときは注意を出す（見えている間だけ 5 秒ごとに確かめる）

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
import { IParadisSimulatorDevice, PARADIS_SIMULATOR_ENABLED_SETTING } from '../common/paradisSimulator.js';
import { paradisSimulatorNextOrientation } from '../common/paradisSimulatorInput.js';
import { IParadisSimulatorClient } from './paradisSimulatorClient.js';
import { PARADIS_SIMULATOR_EDITOR_ID, ParadisSimulatorEditorInput } from './paradisSimulatorEditorInput.js';
import { ParadisSimulatorFrameView } from './paradisSimulatorFrameView.js';

const $ = dom.$;

const DEVICE_HUB_POLL_MS = 5000;

/** 帯の下に出す知らせの種類。 */
type ParadisSimulatorNotice =
	| { readonly kind: 'none' }
	| { readonly kind: 'disabled' }
	| { readonly kind: 'unsupported' }
	| { readonly kind: 'missing' }
	| { readonly kind: 'shutdown' }
	| { readonly kind: 'booting' }
	| { readonly kind: 'error'; readonly message: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 1 つのタブ（端末 1 台）を映している間の状態。タブを替える・閉じるときに丸ごと捨てる。 */
class ParadisSimulatorEditorSession extends DisposableStore {
	device: IParadisSimulatorDevice | undefined;
	readonly frameView: ParadisSimulatorFrameView;

	constructor(readonly input: ParadisSimulatorEditorInput, stage: HTMLElement, client: IParadisSimulatorClient) {
		super();
		this.frameView = this.add(new ParadisSimulatorFrameView(stage, input.udid, client));
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

		this._deviceHub = dom.append(this._root, $('.paradis-simulator-device-hub'));
		this._deviceHub.textContent = localize('paradis.simulator.deviceHub', "Device Hub がこの端末の入力を使っています。タップやキーが届かないときは Device Hub を閉じてください。");
		this._deviceHub.style.display = 'none';

		this._notice = dom.append(this._root, $('.paradis-simulator-notice'));
		this._noticeText = dom.append(this._notice, $('span.paradis-simulator-notice-text'));
		this._noticeAction = this._register(new Button(this._notice, { ...defaultButtonStyles }));
		this._register(this._noticeAction.onDidClick(() => void this._boot()));

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
		session.add(session.frameView.onDidChangeFrameSize(() => this._relayout()));
		session.add(session.frameView.onDidFail(error => this._setNotice({ kind: 'error', message: error.message })));
		this._renderHeader();
		this._relayout();
		await this._refresh(session);
	}

	override clearInput(): void {
		// タブを閉じた・別のタブへ替えた: 映像の購読と Blob URL を放す
		this._session.clear();
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
			if (!status.supported || !status.enabled) {
				session.device = undefined;
				this._setNotice({ kind: status.supported ? 'disabled' : 'unsupported' });
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
			this._setNotice(!session.device ? { kind: 'missing' } : session.booted ? { kind: 'none' } : session.device.state === 'Booting' ? { kind: 'booting' } : { kind: 'shutdown' });
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
			this._deviceHubTimer.cancelAndSet(() => void this._checkDeviceHub(session), DEVICE_HUB_POLL_MS);
			void this._checkDeviceHub(session);
		} else {
			session.frameView.stop();
			this._deviceHubTimer.cancel();
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
				case 'disabled': return localize('paradis.simulator.notice.disabled', "シミュレータの新しい仕組みはオフです（設定 {0}）。", PARADIS_SIMULATOR_ENABLED_SETTING);
				case 'unsupported': return localize('paradis.simulator.notice.unsupported', "iOS のシミュレータは macOS でだけ使えます。");
				case 'missing': return localize('paradis.simulator.notice.missing', "この端末が見つかりません。Xcode で消された可能性があります。");
				case 'shutdown': return localize('paradis.simulator.notice.shutdown', "この端末は起動していません。");
				case 'booting': return localize('paradis.simulator.notice.booting', "起動しています…");
				case 'error': return localize('paradis.simulator.notice.error', "シミュレータとつながりませんでした: {0}", notice.message);
			}
		})();
		this._notice.style.display = notice.kind === 'none' ? 'none' : '';
		this._noticeText.textContent = text;
		const canBoot = notice.kind === 'shutdown';
		this._noticeAction.element.style.display = canBoot ? '' : 'none';
		this._noticeAction.label = localize('paradis.simulator.boot', "起動");
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
