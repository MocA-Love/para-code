/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// mobile_* のツールが話す「Mobile Canvas ホストの REST」を、端末ごとに振り分ける（q.html Q585 の ③、案A）。
//
//  - 設定 paradis.simulator.enabled がオフ・macOS 以外: すべて今の Mobile Canvas へ（今までと同じ）
//  - オン: iOS のシミュレータ（`ios:core-simulator:<udid>`）は serve-sim（paradisServeSimDeviceHost.ts）、
//    Android は Mobile Canvas。一覧は Mobile Canvas の一覧から iOS を外し、serve-sim の一覧を足す
//    （同じ iOS の端末を両方の仕組みがつかまないように。D2）。片方が使えなくても、もう片方の一覧は返す。
// Mobile Canvas を外す ⑦ で、この振り分けと Mobile Canvas の側を畳む。

import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisMobileHostRequester } from '../../mobileCanvas/node/paradisMobileDeviceOpsToolProvider.js';
import { ParadisServeSimDeviceHost } from './paradisServeSimDeviceHost.js';

const DEVICES_PATH = '/api/v1/devices';

function isIosEntry(entry: unknown): boolean {
	const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
	return typeof record.platform === 'string' && /ios|iphone|ipad/i.test(record.platform);
}

function deviceIdOf(path: string): string | undefined {
	const match = /^\/api\/v1\/devices\/(?<id>[^/?]+)/.exec(path);
	if (!match?.groups) {
		return undefined;
	}
	try {
		return decodeURIComponent(match.groups.id);
	} catch {
		return undefined;
	}
}

export class ParadisMobileHostRouter implements IParadisMobileHostRequester {

	constructor(
		private readonly _mobileCanvas: IParadisMobileHostRequester,
		private readonly _serveSim: ParadisServeSimDeviceHost,
		/** serve-sim を使うか（設定がオンで macOS）。呼ぶたびに読む。 */
		private readonly _useServeSim: () => boolean,
		private readonly _logService: ILogService,
	) { }

	async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
		if (!this._useServeSim()) {
			return this._mobileCanvas.request(method, path, body, signal);
		}
		if (method === 'GET' && path === DEVICES_PATH) {
			return this._listDevices(signal);
		}
		const deviceId = deviceIdOf(path);
		if (deviceId !== undefined && this._serveSim.owns(deviceId)) {
			return this._serveSim.request(method, path, body, signal);
		}
		return this._mobileCanvas.request(method, path, body, signal);
	}

	async requestBinary(path: string, signal?: AbortSignal): Promise<Uint8Array> {
		const deviceId = deviceIdOf(path);
		if (this._useServeSim() && deviceId !== undefined && this._serveSim.owns(deviceId)) {
			return this._serveSim.requestBinary(path);
		}
		return this._mobileCanvas.requestBinary(path, signal);
	}

	private async _listDevices(signal?: AbortSignal): Promise<unknown[]> {
		const [canvas, serveSim] = await Promise.allSettled([this._mobileCanvas.request('GET', DEVICES_PATH, undefined, signal), this._serveSim.listDevices()]);
		if (canvas.status === 'rejected' && serveSim.status === 'rejected') {
			throw canvas.reason;
		}
		if (canvas.status === 'rejected') {
			// Android の SDK や Mobile Canvas のランタイムが無いだけのことが多い。iOS は serve-sim で出せる
			this._logService.trace('[paradis-simulator] Mobile Canvas did not list devices; showing the iOS simulators only', canvas.reason);
		}
		if (serveSim.status === 'rejected') {
			this._logService.warn('[paradis-simulator] could not list the iOS simulators', serveSim.reason);
		}
		const android = canvas.status === 'fulfilled' && Array.isArray(canvas.value) ? canvas.value.filter(entry => !isIosEntry(entry)) : [];
		return [...(serveSim.status === 'fulfilled' ? serveSim.value : []), ...android];
	}
}
