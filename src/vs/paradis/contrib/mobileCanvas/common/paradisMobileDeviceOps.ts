/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エミュレータ操作の追加（B13）で shared process と renderer の両方が使う型と、引数の検査・
// ジェスチャーの座標計算（副作用の無い関数だけ）。
//
// 端末へ渡す値（アプリの ID・権限名・向き）は、ここで決めた形に合うものしか通さない。
// Android の `adb shell` は引数をつないで端末側のシェルに解釈させるので、引数配列で呼んでも
// 値に空白や `;` があれば端末側でコマンドとして動いてしまう。形の検査がその唯一の防ぎになる。

/** 端末の割り当ての承認を、呼び出し元ペインを所有するウィンドウへ頼むチャネル。 */
export const PARADIS_MOBILE_DEVICE_REQUEST_CHANNEL = 'paradisMobileDeviceRequest';
export const PARADIS_MOBILE_DEVICE_REQUEST_METHOD = 'requestDevice';

/** 承認ダイアログに出す中身（shared process が端末一覧から組み立てる。表示前に renderer で無害化する）。 */
export interface IParadisMobileDeviceRequestPrompt {
	readonly deviceName: string;
	/** 例: `iOS 26.5`。 */
	readonly runtime?: string;
	/** エージェントが書いた理由。 */
	readonly reason?: string;
	/** 承認するとこのペインから外れる端末の名前（別の端末を持っているとき）。 */
	readonly replacingDeviceName?: string;
}

/**
 * 承認の結果。
 *  - approved: 利用者が承認した
 *  - denied: 利用者が断った（しばらくは同じペインからの求めを自動で断る）
 *  - cancelled: 締め切り・MCP の取り消し
 *  - unanswered: 表示直後やショートカットでの承認が続き、確かな答えが得られなかった
 *  - busy: 同じペインの別の求めがまだ答えを待っている
 *  - recentlyDenied: 同じペインの求めを少し前に利用者が断った
 *  - paneUnresolved: そのペインがこのウィンドウに見つからない
 */
export type ParadisMobileDeviceRequestOutcome = 'approved' | 'denied' | 'cancelled' | 'unanswered' | 'busy' | 'recentlyDenied' | 'paneUnresolved';

export interface IParadisMobileDeviceRequestAnswer {
	readonly outcome: ParadisMobileDeviceRequestOutcome;
	/** 承認したときの、ペインが属するスペース（台帳に残す）。 */
	readonly stateKey?: string;
}

const REQUEST_OUTCOMES: ReadonlySet<string> = new Set<ParadisMobileDeviceRequestOutcome>(['approved', 'denied', 'cancelled', 'unanswered', 'busy', 'recentlyDenied', 'paneUnresolved']);

/** IPC 越しに来た答えを確かめる。形が違えば undefined（承認として扱わない）。 */
export function paradisParseMobileDeviceRequestAnswer(value: unknown): IParadisMobileDeviceRequestAnswer | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.outcome !== 'string' || !REQUEST_OUTCOMES.has(record.outcome)) {
		return undefined;
	}
	const stateKey = typeof record.stateKey === 'string' && record.stateKey ? record.stateKey : undefined;
	return { outcome: record.outcome as ParadisMobileDeviceRequestOutcome, ...(stateKey !== undefined ? { stateKey } : {}) };
}

// --- 端末の種類 ---

export type ParadisMobilePlatform = 'ios' | 'android';

/** ホストの表記（`iOS` / `ios` / `Android` など）を2種類に寄せる。分からなければ undefined。 */
export function paradisMobilePlatformOf(platform: string | undefined): ParadisMobilePlatform | undefined {
	const value = (platform ?? '').toLowerCase();
	if (value.includes('android')) {
		return 'android';
	}
	if (value.includes('ios') || value.includes('iphone') || value.includes('ipad')) {
		return 'ios';
	}
	return undefined;
}

/**
 * コマンドへ渡す端末の番号（iOS の UDID、Android のシリアル）として使ってよい形か。
 * `-` で始まるものは option と取り違えられるので通さない。
 */
export function paradisIsValidNativeDeviceId(platform: ParadisMobilePlatform, id: string | undefined): id is string {
	if (typeof id !== 'string' || id.length === 0 || id.length > 128 || id.startsWith('-')) {
		return false;
	}
	return platform === 'ios' ? /^[A-Za-z0-9-]+$/.test(id) : /^[A-Za-z0-9._:-]+$/.test(id);
}

// --- 向き ---

export type ParadisMobileOrientation = 'portrait' | 'portrait-upside-down' | 'landscape-left' | 'landscape-right';

const ORIENTATION_ALIASES: ReadonlyMap<string, ParadisMobileOrientation> = new Map([
	['portrait', 'portrait'],
	['portrait-upside-down', 'portrait-upside-down'],
	['upside-down', 'portrait-upside-down'],
	['landscape-left', 'landscape-left'],
	['landscape', 'landscape-left'],
	['landscape-right', 'landscape-right'],
]);

/** 向きの名前を Mobile Canvas ホストの表記へ寄せる（`_` と大文字も受ける）。 */
export function paradisNormalizeOrientation(value: unknown): ParadisMobileOrientation | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	return ORIENTATION_ALIASES.get(value.trim().toLowerCase().replace(/_/g, '-'));
}

// --- アプリの ID ---

/**
 * アプリの ID（iOS のバンドル ID、Android のパッケージ名）として通してよい形か。
 * 2つ以上の区切りを持ち、英数字と決まった記号だけ（空白・シェルの記号・`-` 始まりは通さない）。
 */
export function paradisIsValidAppId(platform: ParadisMobilePlatform, appId: unknown): appId is string {
	if (typeof appId !== 'string' || appId.length === 0 || appId.length > 255) {
		return false;
	}
	return platform === 'ios'
		? /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/.test(appId)
		: /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(appId);
}

/** OS に入っているアプリか。権限はこれらへは付けない（作業中のアプリに限るため）。 */
export function paradisIsSystemAppId(platform: ParadisMobilePlatform, appId: string): boolean {
	const lower = appId.toLowerCase();
	if (platform === 'ios') {
		return lower.startsWith('com.apple.');
	}
	return lower === 'android' || lower.startsWith('android.') || lower.startsWith('com.android.') || lower.startsWith('com.google.android.');
}

// --- 権限 ---

/** `xcrun simctl privacy` が受ける項目のうち、1つのアプリへの付与として意味があるもの（`all` は入れない）。 */
const IOS_PRIVACY_SERVICES: ReadonlySet<string> = new Set([
	'calendar', 'contacts-limited', 'contacts', 'location', 'location-always', 'photos-add', 'photos',
	'media-library', 'microphone', 'motion', 'reminders', 'siri',
]);

/** 両方の端末で同じ名前で頼めるようにする、Android 側の対応。 */
const ANDROID_PERMISSION_ALIASES: ReadonlyMap<string, string> = new Map([
	['camera', 'android.permission.CAMERA'],
	['microphone', 'android.permission.RECORD_AUDIO'],
	['location', 'android.permission.ACCESS_FINE_LOCATION'],
	['location-always', 'android.permission.ACCESS_BACKGROUND_LOCATION'],
	['contacts', 'android.permission.READ_CONTACTS'],
	['calendar', 'android.permission.READ_CALENDAR'],
	['photos', 'android.permission.READ_MEDIA_IMAGES'],
	['notifications', 'android.permission.POST_NOTIFICATIONS'],
	['motion', 'android.permission.ACTIVITY_RECOGNITION'],
]);

/** 付与できる権限の名前の一覧（ツールの説明とエラーに出す）。 */
export function paradisMobilePermissionNames(platform: ParadisMobilePlatform): readonly string[] {
	return platform === 'ios' ? [...IOS_PRIVACY_SERVICES] : [...ANDROID_PERMISSION_ALIASES.keys(), 'android.permission.<NAME>'];
}

/** 権限の名前をその端末のコマンドへ渡す名前にする。付与できない名前なら undefined。 */
export function paradisResolveMobilePermission(platform: ParadisMobilePlatform, permission: unknown): string | undefined {
	if (typeof permission !== 'string') {
		return undefined;
	}
	const trimmed = permission.trim();
	if (platform === 'ios') {
		const lower = trimmed.toLowerCase();
		return IOS_PRIVACY_SERVICES.has(lower) ? lower : undefined;
	}
	const alias = ANDROID_PERMISSION_ALIASES.get(trimmed.toLowerCase());
	if (alias) {
		return alias;
	}
	return /^android\.permission\.[A-Z][A-Z0-9_]*$/.test(trimmed) ? trimmed : undefined;
}

// --- インストールするファイル ---

/** インストールするものの種類。`.app` はフォルダ、`.ipa` / `.apk` はファイル。 */
export type ParadisMobileInstallKind = 'app' | 'ipa' | 'apk';

/** 拡張子から種類を決める。その端末で入れられない種類なら undefined。 */
export function paradisMobileInstallKindFor(platform: ParadisMobilePlatform, path: string): ParadisMobileInstallKind | undefined {
	const lower = path.toLowerCase().replace(/[\\/]+$/, '');
	if (platform === 'ios') {
		return lower.endsWith('.app') ? 'app' : lower.endsWith('.ipa') ? 'ipa' : undefined;
	}
	return lower.endsWith('.apk') ? 'apk' : undefined;
}

// --- 画面の寸法とジェスチャー ---

export interface IParadisPoint {
	readonly x: number;
	readonly y: number;
}

/** 入力に使う画面の大きさ（ポイント）。 */
export interface IParadisPointSize {
	readonly width: number;
	readonly height: number;
}

/** ホストの `/display` の応答から、ポイントの大きさと向きを読む。 */
export function paradisParseDisplaySize(raw: unknown): (IParadisPointSize & { readonly orientation?: string; readonly scale?: number }) | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const width = record.pointWidth;
	const height = record.pointHeight;
	if (typeof width !== 'number' || typeof height !== 'number' || !(width > 0) || !(height > 0)) {
		return undefined;
	}
	return {
		width,
		height,
		...(typeof record.orientation === 'string' ? { orientation: record.orientation } : {}),
		...(typeof record.scale === 'number' ? { scale: record.scale } : {}),
	};
}

/** 点が画面の中にあるか（端ちょうどは外。OS の端のジェスチャーを誤って起こさないため）。 */
export function paradisIsInsideScreen(point: IParadisPoint, size: IParadisPointSize): boolean {
	return point.x > 0 && point.y > 0 && point.x < size.width && point.y < size.height;
}

export type ParadisSwipeDirection = 'up' | 'down' | 'left' | 'right';

export function paradisParseSwipeDirection(value: unknown): ParadisSwipeDirection | undefined {
	return value === 'up' || value === 'down' || value === 'left' || value === 'right' ? value : undefined;
}

/**
 * 向きだけで指定されたスワイプの始点と終点。指が動く向きで数える（`up` は下から上へ動かし、
 * 一覧を下へ送る）。始点が無ければ画面の中央、距離が無ければ画面の短い辺の 40%。
 * 端から 2% 以内には寄せない（ホーム・通知センターのような OS の端のジェスチャーにしない）。
 */
export function paradisSwipeEndpoints(direction: ParadisSwipeDirection, size: IParadisPointSize, start?: IParadisPoint, distance?: number): { start: IParadisPoint; end: IParadisPoint } {
	const from = start ?? { x: size.width / 2, y: size.height / 2 };
	const length = distance !== undefined && distance > 0 ? distance : Math.min(size.width, size.height) * 0.4;
	const dx = direction === 'left' ? -length : direction === 'right' ? length : 0;
	const dy = direction === 'up' ? -length : direction === 'down' ? length : 0;
	return { start: from, end: clampInside({ x: from.x + dx, y: from.y + dy }, size) };
}

/**
 * ピンチの2本の指の動き。中心を挟んで左右に並べ、指の間の距離を `startSpan` から `endSpan` へ
 * `steps` 回で変える（広げると拡大、狭めると縮小）。指は画面の中に収める。
 */
export function paradisPinchFrames(center: IParadisPoint, startSpan: number, endSpan: number, steps: number, size: IParadisPointSize): readonly (readonly [IParadisPoint, IParadisPoint])[] {
	const frames: (readonly [IParadisPoint, IParadisPoint])[] = [];
	const count = Math.max(1, Math.round(steps));
	for (let index = 0; index <= count; index++) {
		const span = startSpan + (endSpan - startSpan) * (index / count);
		frames.push([
			clampInside({ x: center.x - span / 2, y: center.y }, size),
			clampInside({ x: center.x + span / 2, y: center.y }, size),
		]);
	}
	return frames;
}

function clampInside(point: IParadisPoint, size: IParadisPointSize): IParadisPoint {
	const marginX = Math.max(1, size.width * 0.02);
	const marginY = Math.max(1, size.height * 0.02);
	return {
		x: Math.round(Math.min(size.width - marginX, Math.max(marginX, point.x)) * 10) / 10,
		y: Math.round(Math.min(size.height - marginY, Math.max(marginY, point.y)) * 10) / 10,
	};
}
