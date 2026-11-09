/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「モバイル」のタブ（paradisMobileEditor.ts）に出す中身を、リレーの状態と設定から組み立てる。
// 文言は持たず、どの状態か・どの端末を出すか・どのボタンを押せるかだけを決める（画面はこれを描くだけ）。

import { IParadisMobileDeviceNotifySettings, IParadisMobileDeviceStatus, IParadisMobileStatus } from './paradisMobileRelay.js';

/**
 * タブの上の札とお知らせの種類。ステータスバーの項目と同じ優先順で決める
 * （無効 → 鍵を読めない → 再ペアリングが要る → 接続の状態）。
 * - `unregistered`: まだ一度もペアリングしていない（リレーに PC を登録していない）ので繋ぎに行っていない
 */
export type ParadisMobileTabState =
	| 'disabled'
	| 'storeUnreadable'
	| 'storeUndecryptable'
	| 'unauthorized'
	| 'connecting'
	| 'disconnected'
	| 'unregistered'
	| 'waiting'
	| 'connected';

/** 端末の表の 1 行。 */
export interface IParadisMobileTabDevice {
	readonly mobileId: string;
	/** 表に出す名前（PC 側の別名、無ければ端末が名乗った名前）。 */
	readonly displayName: string;
	/** 別名を付けているときだけ、端末が名乗った名前。 */
	readonly deviceName: string | undefined;
	readonly online: boolean;
	readonly lastSeenAt: number | undefined;
	readonly pairedAt: number | undefined;
	readonly notify: IParadisMobileDeviceNotifySettings | undefined;
}

export interface IParadisMobileTabModel {
	readonly state: ParadisMobileTabState;
	/** いま繋がっている端末の数（札の「接続中 (n)」）。 */
	readonly onlineCount: number;
	/** ペアリングした端末の数（見出しと、作り直す・登録し直すときに外れる台数）。 */
	readonly pairedCount: number;
	/**
	 * 表に出す端末。`undefined` は表も空の案内も出さない（鍵と台帳を読めないときは台帳が手元に無く、
	 * 0 台と出すと事実と違うため）。
	 */
	readonly devices: readonly IParadisMobileTabDevice[] | undefined;
	/** 「新しく接続」を出すか（無効・鍵を読めない・再ペアリングが要るときは、お知らせのボタンから進む）。 */
	readonly canPair: boolean;
	/** 「リレーを止める」を出すか。 */
	readonly canStop: boolean;
	/** 端末の表を薄く出すか（リレーを止めている間）。 */
	readonly dimDevices: boolean;
}

function tabStateOf(status: IParadisMobileStatus, enabled: boolean): ParadisMobileTabState {
	if (!enabled) {
		return 'disabled';
	}
	if (status.storeProblem === 'unreadable') {
		return 'storeUnreadable';
	}
	if (status.storeProblem === 'undecryptable') {
		return 'storeUndecryptable';
	}
	if (status.unauthorized === true) {
		return 'unauthorized';
	}
	switch (status.state) {
		case 'online':
			return status.onlineMobiles > 0 ? 'connected' : 'waiting';
		case 'disconnected':
			// 登録が無いと繋ぎに行かない（shared process は「切断」と言う）。ペアリングすれば登録して繋がる
			return status.deviceId === undefined ? 'unregistered' : 'disconnected';
		default:
			// 'connecting'。設定は有効なのに shared process がまだ 'disabled' のとき（初期化の途中）も同じに見せる
			return 'connecting';
	}
}

/** リレーの状態と「接続を許可する」の設定から、タブの中身を組み立てる。 */
export function paradisBuildMobileTabModel(status: IParadisMobileStatus, enabled: boolean): IParadisMobileTabModel {
	const state = tabStateOf(status, enabled);
	const relayOnline = state === 'connected' || state === 'waiting';
	const mobiles: readonly IParadisMobileDeviceStatus[] = status.pairedMobiles ?? status.pairedDevices.map(name => ({ mobileId: name, name }));
	const devices = state === 'storeUnreadable' ? undefined : mobiles.map((mobile): IParadisMobileTabDevice => ({
		mobileId: mobile.mobileId,
		displayName: mobile.alias ?? mobile.name,
		deviceName: mobile.alias !== undefined ? mobile.name : undefined,
		online: relayOnline && mobile.online === true,
		lastSeenAt: mobile.lastSeenAt,
		pairedAt: mobile.pairedAt,
		notify: mobile.notify,
	}));
	return {
		state,
		onlineCount: relayOnline ? status.onlineMobiles : 0,
		pairedCount: status.pairedDevices.length,
		devices,
		canPair: state === 'connected' || state === 'waiting' || state === 'connecting' || state === 'disconnected' || state === 'unregistered',
		canStop: enabled,
		dimDevices: state === 'disabled',
	};
}
