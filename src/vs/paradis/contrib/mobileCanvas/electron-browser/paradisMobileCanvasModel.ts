/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// アタッチUI（バインディングダイアログの「モバイル端末」タブ）が使う renderer 側のモデル。
// shared process の台帳へIPCで話し、端末一覧とアタッチ状況をキャッシュする。
//
// 端末一覧は Mobile Canvas ホストの起動を伴うことがあり安くないので、ダイアログが
// 開いている間だけ `beginPolling()` で定期取得し、閉じたら止める。

import { IntervalTimer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisMobileAttachment, IParadisMobileCanvasSnapshot, IParadisMobileDevice, PARADIS_MOBILE_CANVAS_CHANNEL } from '../common/paradisMobileCanvas.js';

export const IParadisMobileCanvasModel = createDecorator<IParadisMobileCanvasModel>('paradisMobileCanvasModel');

export interface IParadisMobileCanvasModel {
	readonly _serviceBrand: undefined;

	/** 端末一覧・アタッチ状況・取得失敗理由が変わったときに発火する。 */
	readonly onDidChange: Event<void>;

	/** 直近に取得した内容。まだ一度も取れていなければ空。 */
	readonly snapshot: IParadisMobileCanvasSnapshot;

	/** 取得中かどうか（UIのローディング表示用）。 */
	readonly loading: boolean;

	/** 一度だけ取り直す。 */
	refresh(): Promise<void>;

	/** UIが開いている間の定期取得を始める。戻り値をdisposeすると止まる。 */
	beginPolling(): IDisposable;

	attach(paneToken: string, deviceId: string, stateKey: string | undefined): Promise<void>;
	detach(paneToken: string): Promise<void>;
}

const POLL_INTERVAL_MS = 4000;
const EMPTY_SNAPSHOT: IParadisMobileCanvasSnapshot = { devices: [], attachments: [] };

/** Tracks the first load and publishes only structurally changed normalized snapshots. */
export class ParadisMobileCanvasSnapshotState {
	private current: IParadisMobileCanvasSnapshot = EMPTY_SNAPSHOT;
	private loaded = false;

	get snapshot(): IParadisMobileCanvasSnapshot { return this.current; }

	beginRefresh(): boolean { return !this.loaded; }

	complete(next: IParadisMobileCanvasSnapshot): boolean {
		this.loaded = true;
		if (equals(this.current, next)) {
			return false;
		}
		this.current = next;
		return true;
	}
}

export class ParadisMobileCanvasModel extends Disposable implements IParadisMobileCanvasModel {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _snapshotState = new ParadisMobileCanvasSnapshotState();
	private _loading = false;
	private _pollers = 0;
	private readonly _timer = this._register(new IntervalTimer());
	/** 取得の多重起動を防ぐ。ポーリングと手動refreshが重なっても1本にまとめる。 */
	private _inFlight: Promise<void> | undefined;

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	get snapshot(): IParadisMobileCanvasSnapshot { return this._snapshotState.snapshot; }
	get loading(): boolean { return this._loading; }

	refresh(): Promise<void> {
		this._inFlight ??= this._refresh().finally(() => { this._inFlight = undefined; });
		return this._inFlight;
	}

	beginPolling(): IDisposable {
		this._pollers++;
		if (this._pollers === 1) {
			this._timer.cancelAndSet(() => void this.refresh(), POLL_INTERVAL_MS);
		}
		void this.refresh();
		let stopped = false;
		return toDisposable(() => {
			if (stopped) {
				return;
			}
			stopped = true;
			this._pollers--;
			if (this._pollers === 0) {
				this._timer.cancel();
			}
		});
	}

	async attach(paneToken: string, deviceId: string, stateKey: string | undefined): Promise<void> {
		await this.sharedProcessService.getChannel(PARADIS_MOBILE_CANVAS_CHANNEL)
			.call<IParadisMobileAttachment>('attach', { paneToken, deviceId, stateKey });
		await this.refresh();
	}

	async detach(paneToken: string): Promise<void> {
		await this.sharedProcessService.getChannel(PARADIS_MOBILE_CANVAS_CHANNEL).call<void>('detach', { paneToken });
		await this.refresh();
	}

	private async _refresh(): Promise<void> {
		const publishLoading = this._snapshotState.beginRefresh();
		if (publishLoading) {
			this._loading = true;
			this._onDidChange.fire();
		}
		let next: IParadisMobileCanvasSnapshot;
		try {
			const snapshot = await this.sharedProcessService.getChannel(PARADIS_MOBILE_CANVAS_CHANNEL)
				.call<IParadisMobileCanvasSnapshot>('getSnapshot');
			next = normalizeSnapshot(snapshot);
		} catch (error) {
			// shared process が落ちている等。UIは理由を出せるよう空+理由にする。
			this.logService.warn('[paradis-mobile-canvas] could not read the device snapshot', error);
			next = { devices: [], attachments: [], unavailableReason: toMessage(error) };
		}
		const changed = this._snapshotState.complete(next);
		this._loading = false;
		if (changed || publishLoading) {
			this._onDidChange.fire();
		}
	}

}

/** IPC越しに来た値をUIが前提にしてよい形へ整える（欠けていても落ちないように）。 */
function normalizeSnapshot(snapshot: IParadisMobileCanvasSnapshot | undefined): IParadisMobileCanvasSnapshot {
	if (!snapshot) {
		return EMPTY_SNAPSHOT;
	}
	const devices = Array.isArray(snapshot.devices) ? snapshot.devices as IParadisMobileDevice[] : [];
	const attachments = Array.isArray(snapshot.attachments) ? snapshot.attachments as IParadisMobileAttachment[] : [];
	return snapshot.unavailableReason === undefined
		? { devices, attachments }
		: { devices, attachments, unavailableReason: snapshot.unavailableReason };
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

registerSingleton(IParadisMobileCanvasModel, ParadisMobileCanvasModel, InstantiationType.Delayed);
