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
//    Android は利用者の adb（android/paradisAdbDeviceHost.ts。⑥a）。Mobile Canvas は使わない（同じ端末を両方の
//    仕組みがつかまないように。D2）。片方が使えなくても、もう片方の一覧は返す。
// Mobile Canvas を外す ⑦ で、この振り分けと Mobile Canvas の側を畳む。

import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisMobileHostRequester } from '../../mobileCanvas/node/paradisMobileDeviceOpsToolProvider.js';
import { ParadisServeSimDeviceHost } from './paradisServeSimDeviceHost.js';
import { ParadisAdbDeviceHost } from './android/paradisAdbDeviceHost.js';

const DEVICES_PATH = '/api/v1/devices';

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
		/** Android の受け持ち（オンのとき）。 */
		private readonly _adb: Pick<ParadisAdbDeviceHost, 'owns' | 'listDevices' | 'request' | 'requestBinary'>,
	) { }

	async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
		if (!this._useServeSim()) {
			return this._mobileCanvas.request(method, path, body, signal);
		}
		if (method === 'GET' && path === DEVICES_PATH) {
			return this._listDevices();
		}
		const deviceId = deviceIdOf(path);
		if (deviceId !== undefined && this._serveSim.owns(deviceId)) {
			return this._serveSim.request(method, path, body, signal);
		}
		if (deviceId !== undefined && this._adb.owns(deviceId)) {
			return this._adb.request(method, path, body);
		}
		throw new Error(`Unknown mobile device: ${deviceId ?? path}`);
	}

	async requestBinary(path: string, signal?: AbortSignal): Promise<Uint8Array> {
		const deviceId = deviceIdOf(path);
		if (this._useServeSim() && deviceId !== undefined) {
			if (this._serveSim.owns(deviceId)) {
				return this._serveSim.requestBinary(path);
			}
			if (this._adb.owns(deviceId)) {
				return this._adb.requestBinary(path);
			}
			throw new Error(`Unknown mobile device: ${deviceId}`);
		}
		return this._mobileCanvas.requestBinary(path, signal);
	}

	private async _listDevices(): Promise<unknown[]> {
		const [serveSim, android] = await Promise.allSettled([this._serveSim.listDevices(), this._adb.listDevices()]);
		if (serveSim.status === 'rejected' && android.status === 'rejected') {
			throw android.reason;
		}
		if (serveSim.status === 'rejected') {
			this._logService.warn('[paradis-simulator] could not list the iOS simulators', serveSim.reason);
		}
		if (android.status === 'rejected') {
			// adb が無い（Android SDK を入れていない）だけのことが多い。iOS は serve-sim で出せる
			this._logService.trace('[paradis-simulator] could not list Android devices with adb', android.reason);
		}
		return [...(serveSim.status === 'fulfilled' ? serveSim.value : []), ...(android.status === 'fulfilled' ? android.value : [])];
	}
}
