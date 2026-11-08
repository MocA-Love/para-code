/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータ（Mobile Canvas の作り直し。設計は q.html Q582・Q585）の、プロセスをまたいで使う型と名前。
//
// 層は 4 つ: ターミナルのペイン（MCP）→ shared process（台帳・backend）→ ホストの子プロセス
// （serve-sim のミドルウェアを組み込み、Unix ソケットだけで待ち受ける。macOS だけ）、と renderer。
// ここには純粋な値と関数だけを置く（どのプロセスからも読めるように）。

import { VSBuffer } from '../../../../base/common/buffer.js';

/** renderer ⇔ shared process のチャネル名。 */
export const PARADIS_SIMULATOR_CHANNEL = 'paradisSimulator';

/**
 * エージェントの端末の要求を承認したときに renderer で呼ぶコマンド（引数はペインのトークンと端末の id）。
 * その端末が新しい仕組みのシミュレータなら、画面をペインのターミナルの右に開き、止まっていれば起動する。
 */
export const PARADIS_SIMULATOR_OPEN_FOR_PANE_COMMAND_ID = 'paradis.simulator.openForPane';

/** ホストの子プロセスの入口（`bootstrap-fork` が `VSCODE_ESM_ENTRYPOINT` で読む）。 */
export const PARADIS_SIMULATOR_HOST_ENTRY = 'vs/paradis/contrib/simulator/node/paradisSimulatorHostMain';

/**
 * ホストの argv に付ける印。前回のホストの止め残しを片付けるとき、pid の記録だけでなく
 * argv にこの印（と専用フォルダ）があることを確かめてから止める（他人のプロセスを止めないため）。
 */
export const PARADIS_SIMULATOR_HOST_MARKER = '--paradis-simulator-host';

/** 同梱している serve-sim の版（`build/paradis/simulator/vendorServeSim.ts` と合わせる）。 */
export const PARADIS_SERVE_SIM_VERSION = '0.1.49';

/** ホストが起動し、待ち受けを始めたことを stdout の 1 行で知らせる印。 */
export const PARADIS_SIMULATOR_HOST_READY = 'paradis-simulator-host-ready';

/** ホストの起動時に stdin の 1 行目で渡すもの（token は環境変数に置かない: 同じ利用者の `ps -E` で読めるため）。 */
export interface IParadisSimulatorHostHandshake {
	readonly token: string;
	readonly socketPath: string;
}

// --- 端末 ---

export type ParadisSimulatorDeviceState = 'Booted' | 'Shutdown' | 'Booting' | 'ShuttingDown' | 'Unknown';

/** `xcrun simctl list devices -j` の 1 台。 */
export interface IParadisSimulatorDevice {
	readonly udid: string;
	readonly name: string;
	/** 表示用の OS の名前（例 `iOS 27.1`）。 */
	readonly runtime: string;
	readonly state: ParadisSimulatorDeviceState;
}

/** 映している画面の大きさと向き（serve-sim の `/helper/<udid>/config`）。 */
export interface IParadisSimulatorScreenConfig {
	readonly width: number;
	readonly height: number;
	readonly orientation: string;
	/** 折りたたみの端末だけ。 */
	readonly hingeDegrees?: number;
}

/** チャネルの `getStatus` の答え。 */
export interface IParadisSimulatorStatus {
	/** この OS で動くか（iOS のシミュレータは macOS だけ）。 */
	readonly supported: boolean;
	readonly hostRunning: boolean;
	/** ホストが起動できなかった・落ち続けているときの理由。 */
	readonly hostError?: string;
}

/** チャネルの `frames` のイベントで届く 1 枚（受け取ったら `ackFrame` を返す）。 */
export interface IParadisSimulatorFrameEvent {
	readonly udid: string;
	readonly jpeg: VSBuffer;
}

// --- 開閉（iPhone Duo） ---

export type ParadisSimulatorPose = 'closed' | 'book' | 'open';

/** serve-sim 0.1.49 の `DUO_POSES` に合わせた 3 つの姿勢。名前は Para Code 側で持つ（版の間で名前が変わったため）。 */
export const PARADIS_SIMULATOR_POSES: readonly { readonly id: ParadisSimulatorPose; readonly hingeDegrees: number }[] = [
	{ id: 'closed', hingeDegrees: 0 },
	{ id: 'book', hingeDegrees: 130 },
	{ id: 'open', hingeDegrees: 180 },
];

/** 開閉の要求。姿勢の名前か角度（0〜180）のどちらか 1 つ。 */
export type ParadisSimulatorFold = { readonly kind: 'pose'; readonly pose: ParadisSimulatorPose } | { readonly kind: 'hinge'; readonly hinge: number };

export type ParadisSimulatorOrientation = 'portrait' | 'portrait_upside_down' | 'landscape_left' | 'landscape_right';

export const PARADIS_SIMULATOR_ORIENTATIONS: readonly ParadisSimulatorOrientation[] = ['portrait', 'portrait_upside_down', 'landscape_left', 'landscape_right'];

/**
 * renderer（人の入力）や開発用のコマンドからチャネルで送る入力。shared process が形を確かめてから
 * フレームにする（`paradisSimulatorInputFrame`）。座標は画面の幅・高さに対する 0〜1。
 */
export type ParadisSimulatorInput =
	| { readonly kind: 'touch'; readonly phase: 'begin' | 'move' | 'end'; readonly x: number; readonly y: number; /** 端の印（下端のホームのジェスチャーなど）。 */ readonly edge?: number }
	| { readonly kind: 'key'; readonly type: 'down' | 'up'; readonly usage: number }
	| { readonly kind: 'button'; readonly button: string }
	| { readonly kind: 'rotate'; readonly orientation: ParadisSimulatorOrientation };

// --- ハードウェアのボタン ---

/** serve-sim に送るボタン。名前で送るもの（HIDInjector の `sendButton`）と、HID の page/usage で送るもの（音量）。 */
export type ParadisSimulatorButton =
	| { readonly kind: 'named'; readonly name: 'home' | 'side_button' | 'lock' | 'siri' | 'app_switcher' }
	| { readonly kind: 'hid'; readonly name: 'volume_up' | 'volume_down'; readonly page: number; readonly usage: number };

/** HID の consumer page（音量のボタン）。 */
const HID_CONSUMER_PAGE = 0x0c;

const BUTTONS: { readonly [name: string]: ParadisSimulatorButton } = {
	home: { kind: 'named', name: 'home' },
	side_button: { kind: 'named', name: 'side_button' },
	lock: { kind: 'named', name: 'lock' },
	siri: { kind: 'named', name: 'siri' },
	app_switcher: { kind: 'named', name: 'app_switcher' },
	volume_up: { kind: 'hid', name: 'volume_up', page: HID_CONSUMER_PAGE, usage: 0xe9 },
	volume_down: { kind: 'hid', name: 'volume_down', page: HID_CONSUMER_PAGE, usage: 0xea },
};

/** 受け付ける別名（今の mobile_press_button の説明にある例を含む）。 */
const BUTTON_ALIASES: { readonly [name: string]: string } = {
	power: 'lock',
	side: 'side_button',
	appswitcher: 'app_switcher',
	multitask: 'app_switcher',
};

/** `mobile_press_button` が受け付けるボタンの名前（エラーで知らせる一覧）。 */
export function paradisSimulatorButtonNames(): string[] {
	return Object.keys(BUTTONS);
}

/**
 * ボタンの名前を対応表に当てる。大文字・`-`・camelCase（`volumeUp`）も受ける。知らない名前は undefined。
 */
export function paradisResolveSimulatorButton(raw: string): ParadisSimulatorButton | undefined {
	const snake = raw.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
	const name = BUTTON_ALIASES[snake] ?? BUTTON_ALIASES[snake.replace(/_/g, '')] ?? snake;
	return Object.prototype.hasOwnProperty.call(BUTTONS, name) ? BUTTONS[name] : undefined;
}

// --- ホストが通すルート ---

/** ホストが serve-sim のミドルウェアへ渡す要求の種類。これ以外はすべて 404。 */
export type ParadisSimulatorHostEndpoint = 'stream.mjpeg' | 'stream.avcc' | 'ax' | 'config' | 'health' | 'ws';

export interface IParadisSimulatorHostRoute {
	readonly udid: string;
	readonly endpoint: ParadisSimulatorHostEndpoint;
	/** ミドルウェアへ渡す URL（クエリは落とす。`?device=` で別の端末へ向け直させないため）。 */
	readonly url: string;
}

const HTTP_ENDPOINTS: ReadonlySet<string> = new Set(['stream.mjpeg', 'stream.avcc', 'ax', 'config', 'health']);
const SIMULATOR_UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/** simctl の UDID の形か。 */
export function paradisIsSimulatorUdid(value: string): boolean {
	return SIMULATOR_UDID.test(value);
}

/**
 * mobile_* のツールでの iOS のシミュレータの端末の id の頭（Mobile Canvas と同じ形 `ios:core-simulator:<udid>`。
 * 2026-11-08 に Mac の mobile_list_devices で確かめた）。
 */
export const PARADIS_SIMULATOR_DEVICE_ID_PREFIX = 'ios:core-simulator:';

/** `ios:core-simulator:<udid>` の udid。形が違えば undefined。 */
export function paradisSimulatorUdidOfDeviceId(deviceId: string): string | undefined {
	if (!deviceId.startsWith(PARADIS_SIMULATOR_DEVICE_ID_PREFIX)) {
		return undefined;
	}
	const udid = deviceId.slice(PARADIS_SIMULATOR_DEVICE_ID_PREFIX.length);
	return paradisIsSimulatorUdid(udid) ? udid : undefined;
}

/**
 * ホストへ来た要求のうち、通してよいものだけをルートにする。
 *
 * 通すのは `GET /helper/<udid>/{stream.mjpeg,stream.avcc,ax,config,health}` と、upgrade の
 * `GET /helper/<udid>/ws`（入力）だけ。`/exec`・`/exec-ws`（ホストのシェル）、`/devtools*`
 * （inspect-webkit が TCP の橋を起こす）、`/api/diagnostics`、grid の start・shutdown、
 * 録画、`/auth` などは許可の一覧の外に置く（設計書 2 節）。パスは文字のまま比べ、
 * `..`・`%2e`・`//` などの入った要求は正規化せずに断る。
 */
export function paradisSimulatorHostRoute(method: string | undefined, rawUrl: string | undefined, upgrade: boolean): IParadisSimulatorHostRoute | undefined {
	if ((method ?? 'GET').toUpperCase() !== 'GET' || !rawUrl) {
		return undefined;
	}
	const queryIndex = rawUrl.indexOf('?');
	const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
	const segments = path.split('/');
	// '', 'helper', '<udid>', '<endpoint>'
	if (segments.length !== 4 || segments[0] !== '' || segments[1] !== 'helper') {
		return undefined;
	}
	const udid = segments[2];
	const endpoint = segments[3];
	if (!paradisIsSimulatorUdid(udid)) {
		return undefined;
	}
	if (upgrade ? endpoint !== 'ws' : !HTTP_ENDPOINTS.has(endpoint)) {
		return undefined;
	}
	return { udid, endpoint: endpoint as ParadisSimulatorHostEndpoint, url: `/helper/${udid}/${endpoint}` };
}

/** `Authorization: Bearer <token>` から token を取り出す。 */
export function paradisBearerToken(header: string | string[] | undefined): string | undefined {
	const value = Array.isArray(header) ? header[0] : header;
	const match = value ? /^Bearer\s+(?<token>\S+)\s*$/i.exec(value) : null;
	return match?.groups?.token;
}
