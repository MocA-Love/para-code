/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイル端末（iOSシミュレータ / Androidエミュレータ）⇔ ターミナルペインのアタッチに関する
// 共有の型とチャネル名。shared process 側（node/）と renderer 側（electron-browser/）の両方から使う。

/** shared process 側のサービスへ renderer から話すための IPC チャネル名。 */
export const PARADIS_MOBILE_CANVAS_CHANNEL = 'paradisMobileCanvas';

/** Mobile Canvas ホストが返す1台分の端末情報のうち、Para Code が使う部分。 */
export interface IParadisMobileDevice {
	/** `mobile_list_devices` などで使うプロバイダ修飾済みID。アタッチのキーもこれ。 */
	readonly id: string;
	/** 実機配備コマンドへ渡すためのネイティブUDID / シリアル。 */
	readonly udid?: string;
	readonly name: string;
	/** `ios` / `android`。ホストの表記をそのまま通す。 */
	readonly platform: string;
	/** 例: `iOS 18.4`。無い場合もある。 */
	readonly runtime?: string;
	/**
	 * 画面の寸法。**ピクセルと「ポイント」の両方を持つのが要点**で、
	 * スクリーンショットはピクセル、入力系（tap/swipe）はポイントを使う。
	 * この対応が分からないとスクリーンショットを見て座標を出しても必ず外れる。
	 */
	readonly display?: IParadisMobileDisplay;
	/** 例: `booted` / `shutdown`。ホストの表記をそのまま通す。 */
	readonly state: string;
	readonly isRunning: boolean;
	/**
	 * 動いている Android のエミュレータだけ: 起動する前の id（`android:avd:<name>`）。起動すると一覧の id は
	 * `android:serial:<serial>` に替わるので、起動前に割り当てた端末を引き当てるのに使う。
	 */
	readonly avdId?: string;
}

/**
 * 割り当ての `deviceId` が指す端末を一覧から引く。id が同じもの、無ければ、起動して id が替わった Android の
 * エミュレータ（`avdId` が同じもの）。台帳に残る id は書き換えない。
 */
export function paradisFindMobileDevice<T extends { readonly id: string; readonly avdId?: string }>(devices: readonly T[], deviceId: string | undefined): T | undefined {
	if (deviceId === undefined) {
		return undefined;
	}
	return devices.find(candidate => candidate.id === deviceId) ?? devices.find(candidate => candidate.avdId !== undefined && candidate.avdId === deviceId);
}

/**
 * 割り当ての `deviceId`（{@link attachedDeviceId}）が、一覧のその端末（{@link deviceId}）を指すか。
 * 起動前の AVD で割り当てた Android は、起動すると一覧の id が替わるので、id の一致だけでは見ない
 * （共有ダイアログとタブの名前が、起動後の端末を「未割り当て」と出さないように）。
 */
export function paradisMobileAttachmentIsFor(devices: readonly { readonly id: string; readonly avdId?: string }[], attachedDeviceId: string, deviceId: string): boolean {
	return attachedDeviceId === deviceId || paradisFindMobileDevice(devices, attachedDeviceId)?.id === deviceId;
}

/** 端末画面の寸法。ピクセル空間とポイント空間の対応を表す。 */
export interface IParadisMobileDisplay {
	readonly pixelWidth: number;
	readonly pixelHeight: number;
	readonly pointWidth: number;
	readonly pointHeight: number;
	/** ピクセル = ポイント × scale。 */
	readonly scale: number;
	readonly orientation?: string;
}

/** 1ペイン分のアタッチ状態。 */
export interface IParadisMobileAttachment {
	/** アタッチ元のターミナルペインを表すトークン。 */
	readonly paneToken: string;
	readonly deviceId: string;
	readonly deviceName: string;
	/**
	 * アタッチした時点でそのペインが属していたスペースの識別子。スペース管理下でなければ `undefined`。
	 *
	 * スペースを切り替えてもアタッチは解除しない（ターミナルとエージェントが生き続ける以上、
	 * 端末だけ黙って取り上げると作業途中の相手が壊れるため）。この値は「どのスペースの作業で
	 * 渡した端末か」を後から辿るための記録として持つ。
	 */
	readonly stateKey: string | undefined;
	readonly attachedAt: number;
}

/** renderer 側のアタッチUIが1回のポーリングで受け取る内容。 */
export interface IParadisMobileCanvasSnapshot {
	readonly devices: readonly IParadisMobileDevice[];
	readonly attachments: readonly IParadisMobileAttachment[];
	/**
	 * 端末一覧を取れなかった理由（ホストが起動できない、Xcode/Android SDK が無い等）。
	 * UI はこれをそのまま出して、ユーザーが次に何をすればよいか分かるようにする。
	 */
	readonly unavailableReason?: string;
	/**
	 * 一覧は取れたが、一部の端末を出せなかった理由（例: adb が無いので Android が出ない。シミュレータの作り直し ⑥a）。
	 * 端末があっても UI に出す。
	 */
	readonly notice?: string;
}
