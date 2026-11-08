/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// mobile_* のツールが話す端末の口（`/api/v1/devices/...` の道。もとは Mobile Canvas ホストの REST の形）を、
// 端末ごとに振り分ける（q.html Q585・⑦で Mobile Canvas を外した後の形）。
//
//  - iOS のシミュレータ（`ios:core-simulator:<udid>`）: serve-sim（paradisServeSimDeviceHost.ts）
//  - Android（`android:serial:<serial>`・`android:avd:<name>`）: 利用者の adb（android/paradisAdbDeviceHost.ts）
// 一覧は両方を合わせ、片方が使えなくてももう片方は返す。Android を出せなかった理由（adb が無いなど）は
// {@link androidNotice} に持ち、mobile_list_devices と共有ダイアログに出す。

import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisAdbDeviceHost } from './android/paradisAdbDeviceHost.js';
import { IParadisMobileHostRequester } from './paradisSimulatorDeviceOps.js';
import { ParadisServeSimDeviceHost } from './paradisServeSimDeviceHost.js';

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

export class ParadisSimulatorDeviceRouter implements IParadisMobileHostRequester {

	private _androidNotice: string | undefined;

	constructor(
		private readonly _serveSim: Pick<ParadisServeSimDeviceHost, 'owns' | 'listDevices' | 'request' | 'requestBinary'>,
		private readonly _adb: Pick<ParadisAdbDeviceHost, 'owns' | 'listDevices' | 'request' | 'requestBinary'>,
		/** iOS のシミュレータを出すか（macOS だけ）。 */
		private readonly _iosAvailable: () => boolean,
		/** Android を出すか。 */
		private readonly _androidAvailable: () => boolean,
		private readonly _logService: ILogService,
	) { }

	/** 直前の一覧で Android を出せなかった理由（adb が無いなど）。出せていれば undefined。 */
	get androidNotice(): string | undefined {
		return this._androidNotice;
	}

	async request(method: string, path: string, body?: unknown): Promise<unknown> {
		if (method === 'GET' && path === DEVICES_PATH) {
			return this._listDevices();
		}
		const deviceId = deviceIdOf(path);
		if (deviceId !== undefined && this._iosAvailable() && this._serveSim.owns(deviceId)) {
			return this._serveSim.request(method, path, body);
		}
		if (deviceId !== undefined && this._androidAvailable() && this._adb.owns(deviceId)) {
			return this._adb.request(method, path, body);
		}
		throw new Error(`Unknown mobile device: ${deviceId ?? path}`);
	}

	async requestBinary(path: string): Promise<Uint8Array> {
		const deviceId = deviceIdOf(path);
		if (deviceId !== undefined && this._iosAvailable() && this._serveSim.owns(deviceId)) {
			return this._serveSim.requestBinary(path);
		}
		if (deviceId !== undefined && this._androidAvailable() && this._adb.owns(deviceId)) {
			return this._adb.requestBinary(path);
		}
		throw new Error(`Unknown mobile device: ${deviceId ?? path}`);
	}

	private async _listDevices(): Promise<unknown[]> {
		const ios = this._iosAvailable();
		const android = this._androidAvailable();
		const [serveSim, adb] = await Promise.allSettled([
			ios ? this._serveSim.listDevices() : Promise.resolve([]),
			android ? this._adb.listDevices() : Promise.resolve([]),
		]);
		if (ios && android && serveSim.status === 'rejected' && adb.status === 'rejected') {
			throw adb.reason;
		}
		if (serveSim.status === 'rejected') {
			this._logService.warn('[paradis-simulator] could not list the iOS simulators', serveSim.reason);
		}
		// adb が無い（Android SDK を入れていない）だけのことが多い。理由は一覧の知らせで利用者と LLM に見せる
		this._androidNotice = android && adb.status === 'rejected'
			? `Android devices are not listed: ${adb.reason instanceof Error ? adb.reason.message : String(adb.reason)}`
			: undefined;
		if (adb.status === 'rejected') {
			this._logService.trace('[paradis-simulator] could not list Android devices with adb', adb.reason);
		}
		return [...(serveSim.status === 'fulfilled' ? serveSim.value : []), ...(adb.status === 'fulfilled' ? adb.value : [])];
	}
}
