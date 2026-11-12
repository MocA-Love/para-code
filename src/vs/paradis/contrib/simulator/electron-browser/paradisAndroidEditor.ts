/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Android の端末のエディタのペイン（q.html Q585 の ⑥b）。上の帯に端末の名前と OS、戻る・ホーム・アプリの一覧の
// ボタン、その下に scrcpy の映像（paradisAndroidVideoView.ts）。見えている間だけ映像を購読する。通話が終わった・
// 途切れたときは、間を延ばしながら購読し直し、使い切ったら「再試行」を出す。

import './media/paradisSimulator.css';
import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { paradisSimulatorStallRetryDelay } from '../common/paradisSimulatorInput.js';
import { PARADIS_ANDROID_EDITOR_ID, ParadisAndroidEditorInput } from './paradisAndroidEditorInput.js';
import { ParadisAndroidVideoView } from './paradisAndroidVideoView.js';
import { IParadisSimulatorClient } from './paradisSimulatorClient.js';
import { paradisLabelSimulatorScreen } from './paradisSimulatorFrameView.js';

const $ = dom.$;

class ParadisAndroidEditorSession extends DisposableStore {
	readonly view: ParadisAndroidVideoView;
	retries = 0;
	readonly retryTimer = this.add(new MutableDisposable());
	constructor(readonly input: ParadisAndroidEditorInput, stage: HTMLElement, client: IParadisSimulatorClient) {
		super();
		this.view = this.add(new ParadisAndroidVideoView(stage, input.serial, client));
	}
}

export class ParadisAndroidEditor extends EditorPane {

	static readonly ID = PARADIS_ANDROID_EDITOR_ID;

	private _root: HTMLElement | undefined;
	private _title: HTMLElement | undefined;
	private _subtitle: HTMLElement | undefined;
	private _notice: HTMLElement | undefined;
	private _noticeText: HTMLElement | undefined;
	private _retry: ParadisButton | undefined;
	private _stage: HTMLElement | undefined;
	private _back: ParadisButton | undefined;
	private _keyHint: HTMLElement | undefined;
	private readonly _session = this._register(new MutableDisposable<ParadisAndroidEditorSession>());
	private _lastDimension: dom.Dimension | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IParadisSimulatorClient private readonly _client: IParadisSimulatorClient,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super(PARADIS_ANDROID_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = dom.append(parent, $('.paradis-simulator-editor'));
		const bar = dom.append(this._root, $('.paradis-simulator-bar'));
		const titles = dom.append(bar, $('.paradis-simulator-titles'));
		this._title = dom.append(titles, $('span.paradis-simulator-title'));
		this._subtitle = dom.append(titles, $('span.paradis-simulator-subtitle'));
		this._keyHint = dom.append(bar, $('span.paradis-simulator-key-hint'));
		this._keyHint.textContent = localize('paradis.android.keyHint', "キー入力は端末へ届きます。Esc を 2 回で外へ");
		// 映像の枠の読み上げの説明（aria-describedby）。id はペインごとに替える
		this._keyHint.id = `paradis-android-key-hint-${generateUuid()}`;
		const actions = dom.append(bar, $('.paradis-simulator-actions'));
		const button = (label: string, deviceButton: string) => {
			const created = this._register(new ParadisButton(actions, { kind: 'secondary', small: true, label, title: label }));
			this._register(created.onDidClick(() => {
				const session = this._session.value;
				if (session) {
					this._client.androidInput(session.input.serial, { kind: 'button', button: deviceButton }).catch(error => this._notificationService.error(localize('paradis.android.buttonFailed', "Android の端末へ送れませんでした: {0}", error instanceof Error ? error.message : String(error))));
				}
			}));
			return created;
		};
		this._back = button(localize('paradis.android.back', "戻る"), 'back');
		button(localize('paradis.android.home', "ホーム"), 'home');
		button(localize('paradis.android.recents', "アプリの一覧"), 'app_switcher');

		this._notice = dom.append(this._root, $('.paradis-simulator-notice'));
		this._noticeText = dom.append(this._notice, $('span.paradis-simulator-notice-text'));
		// 要素は置いたまま文だけ替えるので、読み上げが切り替わりを拾える（つながらず「再試行」を出すときだけ alert）
		this._noticeText.setAttribute('role', 'status');
		this._retry = this._register(new ParadisButton(this._notice, { kind: 'primary', small: true, label: localize('paradis.android.retry', "再試行") }));
		this._register(this._retry.onDidClick(() => {
			const session = this._session.value;
			if (session) {
				session.retries = 0;
				this._setNotice(undefined);
				this._restart(session);
			}
		}));
		this._notice.style.display = 'none';
		this._stage = dom.append(this._root, $('.paradis-simulator-stage'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof ParadisAndroidEditorInput) || !this._stage || this._session.value?.input === input) {
			return;
		}
		const session = new ParadisAndroidEditorSession(input, this._stage, this._client);
		this._session.value = session;
		session.add(session.view.onDidDrawFrame(() => {
			session.retries = 0;
			this._setNotice(undefined);
		}));
		session.add(session.view.onDidEnd(reason => this._onLost(session, reason)));
		session.add(session.view.onDidStall(() => this._onLost(session, undefined)));
		session.add(session.view.onDidRequestExit(() => this._back?.focus()));
		session.add(session.view.onDidFail(error => this._setNotice(localize('paradis.android.decodeFailed', "映像の表示に失敗しました（読み直しています）: {0}", error.message))));
		// 復号できない（この codec を扱えない・続けて失敗した）: 自動では読み直さず、理由と「再試行」を出す
		session.add(session.view.onDidGiveUp(reason => this._setNotice(localize('paradis.android.gaveUp', "Android の端末の映像を表示できません: {0}", reason), true)));
		session.add(input.onDidChangeLabel(() => this._renderHeader()));
		this._renderHeader();
		this._setNotice(undefined);
		this._relayout();
		this._updateStreaming();
		const device = (await this._client.listAndroidDevices().catch(() => [])).find(candidate => candidate.serial === input.serial);
		if (this._session.value === session) {
			if (device) {
				input.setDeviceName(device.name);
				this._subtitle!.textContent = device.runtime;
			} else {
				this._setNotice(localize('paradis.android.missing', "この端末が見つかりません。エミュレータを起動するか、端末をつないでください。"));
			}
		}
	}

	override clearInput(): void {
		// タブを閉じた・別のタブへ替えた: 映像の購読と復号を放す
		this._session.clear();
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
		this._session.value?.view.focus();
	}

	private _updateStreaming(): void {
		const session = this._session.value;
		if (!session) {
			return;
		}
		if (this.isVisible()) {
			session.view.start();
		} else {
			session.view.stop();
		}
	}

	/** 通話が終わった・途切れた: 間を延ばしながら購読し直す。使い切ったら止めて「再試行」を出す。 */
	private _onLost(session: ParadisAndroidEditorSession, reason: string | undefined): void {
		session.view.stop();
		const delay = paradisSimulatorStallRetryDelay(session.retries);
		session.retries++;
		if (delay === undefined) {
			this._setNotice(reason
				? localize('paradis.android.lostReason', "Android の端末とつながりません: {0}", reason)
				: localize('paradis.android.lost', "Android の端末から映像が届きません。"), true);
			return;
		}
		const timer = setTimeout(() => {
			if (this._session.value === session) {
				this._restart(session);
			}
		}, delay);
		session.retryTimer.value = { dispose: () => clearTimeout(timer) };
	}

	private _restart(session: ParadisAndroidEditorSession): void {
		session.view.stop();
		if (this.isVisible()) {
			session.view.start();
		}
	}

	private _setNotice(text: string | undefined, retry = false): void {
		if (!this._notice || !this._noticeText || !this._retry) {
			return;
		}
		this._notice.style.display = text ? '' : 'none';
		this._noticeText.setAttribute('role', retry ? 'alert' : 'status');
		this._noticeText.textContent = text ?? '';
		this._retry.element.style.display = retry ? '' : 'none';
		this._relayout();
	}

	private _renderHeader(): void {
		if (this._title) {
			this._title.textContent = this._session.value?.input.getName() ?? '';
		}
		const session = this._session.value;
		if (session) {
			paradisLabelSimulatorScreen(session.view.element, session.input.getName(), this._keyHint);
		}
	}

	private _relayout(): void {
		const session = this._session.value;
		if (!session || !this._root || !this._lastDimension) {
			return;
		}
		const used = [...this._root.children].filter(child => child !== this._stage).reduce((sum, child) => sum + (child as HTMLElement).offsetHeight, 0);
		session.view.layout({ width: Math.max(0, this._lastDimension.width - 24), height: Math.max(0, this._lastDimension.height - used - 24) });
	}
}
