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
	/** 例: `booted` / `shutdown`。ホストの表記をそのまま通す。 */
	readonly state: string;
	readonly isRunning: boolean;
}

/** 1ペイン分のアタッチ状態。 */
export interface IParadisMobileAttachment {
	/** アタッチ元のターミナルペインを表すトークン。 */
	readonly paneToken: string;
	readonly deviceId: string;
	readonly deviceName: string;
	/**
	 * アタッチした時点でそのペインが属していたスペースの識別子。
	 * スペースを跨いだアタッチを拒むためと、スペース破棄時に解除するために持つ。
	 * スペース管理下でないペインの場合は `undefined`。
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
}
