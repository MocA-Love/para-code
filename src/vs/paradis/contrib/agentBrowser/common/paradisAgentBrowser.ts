/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブラウザページ⇔ターミナル上のエージェントCLI（Claude Code / Codex）紐付け機能の共有定義。
// workbench（browser / electron-browser）と shared process（node）の両方から参照される。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import type { ParadisBindingAuthorityStableScope } from './paradisBindingAuthority.js';

/**
 * ターミナルのPTY環境へ注入する、ペインを一意に識別するトークンの環境変数名。
 * ターミナル内で起動されたエージェントCLI（およびそのstdio MCP子プロセス）に継承され、
 * MCPサーバーへの Bearer トークンとして使われる。
 */
export const PARADIS_PANE_TOKEN_ENV_VAR = 'PARA_CODE_TERMINAL_PANE_ID';

/**
 * MCPサーバーのポートファイル（絶対パス）を指す環境変数名。
 * stdioシムは毎起動時にこのファイルを読み直して現在のサーバーポートを解決する
 * （shared process再起動によるポート変化への追従）。
 */
export const PARADIS_MCP_PORT_FILE_ENV_VAR = 'PARA_CODE_MCP_PORT_FILE';

/** ペイン専用Codex app-serverのUnix socket絶対パス。 */
export const PARADIS_CODEX_APP_SERVER_SOCKET_ENV_VAR = 'PARA_CODE_CODEX_APP_SERVER_SOCKET';

/** 再帰せず実Codexを解決するため、ランチャー自身がPATHから除外するディレクトリ。 */
export const PARADIS_CODEX_LAUNCHER_DIR_ENV_VAR = 'PARA_CODE_CODEX_LAUNCHER_DIR';

/** CodexペインランチャーをPTY環境へ追加するための実行時情報。 */
export interface IParadisCodexPaneRuntime {
	readonly launcherDirectory: string;
	readonly socketPath: string;
	readonly pathDelimiter: string;
}

/**
 * userDataDir 直下に書き出されるポートファイルのファイル名。
 * 内容: protocolVersion、port、pid、instanceId、serviceStartedAtを持つ
 * restart-safeなowner record（厳密な型はnode層のIParadisMcpPortFileRecord）。
 */
export const PARADIS_MCP_PORT_FILE_NAME = 'paradis-browser-mcp.json';

/**
 * shared process上のMCP+CDPゲートウェイHTTPサーバーが最初に試す固定listenポート。
 * 使用中の場合は動的ポート（0）へフォールバックし、実ポートはポートファイルに書かれる。
 * 将来的にはParadis設定に載せる想定（現状はconst固定）。
 */
export const PARADIS_MCP_DEFAULT_PORT = 47286;

/**
 * userDataDir配下に、Unixのsun_path上限へ収まるペイン固有socketパスを作る。
 * パストラバーサルを防ぐため、復元された旧トークンも安全な文字だけを許可する。
 */
export function paradisCodexPaneSocketPath(userDataPath: string, token: string): string | undefined {
	if (userDataPath.length === 0 || !/^[A-Za-z0-9._-]{1,64}$/.test(token)) {
		return undefined;
	}
	const socketPath = join(userDataPath, 'pcx', `${token}.sock`);
	return new TextEncoder().encode(socketPath).length <= 100 ? socketPath : undefined;
}

/** shared processで起動済みのMCP+CDPゲートウェイ接続先。 */
export interface IParadisGatewayEndpoint {
	readonly port: number;
}

/** 起動済みゲートウェイの実ポートから、loopback限定のCDP URLを生成する。 */
export function paradisFormatCdpGatewayUrl(port: number): string {
	if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
		throw new Error('Invalid Para Browser gateway port');
	}
	return `http://127.0.0.1:${port}/cdp`;
}

/**
 * PTYの既存環境を保持したまま、内部MCPの動的ポート解決に必要な値だけを追加する。
 * ユーザーが明示した `PARA_CODE_CDP_URL` を含む未知の環境変数は上書きしない。
 */
export function paradisCreateTerminalPaneEnvironment(
	existing: Readonly<Record<string, string | null | undefined>> | undefined,
	token: string,
	portFilePath: string,
	codexRuntime?: IParadisCodexPaneRuntime,
): Record<string, string | null | undefined> {
	const environment: Record<string, string | null | undefined> = {
		...existing,
		[PARADIS_PANE_TOKEN_ENV_VAR]: token,
		[PARADIS_MCP_PORT_FILE_ENV_VAR]: portFilePath,
	};
	if (codexRuntime === undefined || codexRuntime.launcherDirectory.length === 0 || codexRuntime.socketPath.length === 0 || codexRuntime.pathDelimiter.length === 0) {
		return environment;
	}
	const pathPrefix = `${codexRuntime.launcherDirectory}${codexRuntime.pathDelimiter}`;
	const currentPath = existing?.['PATH'];
	const currentPathPrefix = existing?.['VSCODE_PATH_PREFIX'];
	environment['PATH'] = `${pathPrefix}${typeof currentPath === 'string' ? currentPath : '${env:PATH}'}`;
	environment['VSCODE_PATH_PREFIX'] = `${pathPrefix}${typeof currentPathPrefix === 'string' ? currentPathPrefix : ''}`;
	environment[PARADIS_CODEX_LAUNCHER_DIR_ENV_VAR] = codexRuntime.launcherDirectory;
	environment[PARADIS_CODEX_APP_SERVER_SOCKET_ENV_VAR] = codexRuntime.socketPath;
	return environment;
}

/**
 * workbench ⇔ shared process 間のバインディング操作用IPCチャネル名。
 */
export const PARADIS_AGENT_BROWSER_CHANNEL = 'paradisAgentBrowser';

/**
 * electron-main ⇔ shared process 間の「browserView viewId → Chromium DevTools targetId」
 * 解決用IPCチャネル名（CDPゲートウェイのターゲットフィルタが使う）。
 */
export const PARADIS_CDP_TARGET_CHANNEL = 'paradisCdpTarget';

/**
 * workbenchウィンドウが shared process の IPCServer へ登録する、ファイルプレビュー
 * オープン用IPCチャネル名。shared process 側（MCPの `preview_file` ツール）が
 * `ipcServer.getChannel(名前, ctxフィルタ)` で「呼び出し元ペインのウィンドウ」だけに
 * ルーティングして呼び出す（逆方向は使わない）。
 */
export const PARADIS_AGENT_PREVIEW_CHANNEL = 'paradisAgentPreview';

/**
 * {@link PARADIS_AGENT_PREVIEW_CHANNEL} の `previewFile` 呼び出し結果。
 * error は LLM がそのまま読む英語メッセージ。
 */
export interface IParadisPreviewFileResult {
	readonly ok: boolean;
	readonly error?: string;
}

/**
 * electron-main のフレーム購読(beginFrameSubscription)が発火する1フレーム
 * （{@link PARADIS_CDP_TARGET_CHANNEL} の `onDidFrame` イベントのペイロード）。
 */
export interface IParadisCdpFrameEvent {
	readonly targetId: string;
	/** base64エンコード済みJPEG。 */
	readonly data: string;
	/** フレームのピクセル寸法（アスペクト比・タップ座標の正規化用）。 */
	readonly w: number;
	readonly h: number;
}

/**
 * shared process から見た electron-main のフレーム購読プロキシ
 * （`ProxyChannel.toService` で {@link PARADIS_CDP_TARGET_CHANNEL} に接続する）。
 */
export interface IParadisCdpFrameSubscription {
	readonly onDidFrame: Event<IParadisCdpFrameEvent>;
	/** 購読開始。対象が見つからない場合は false（呼び出し側はポーリングに留まる）。 */
	startFrameSubscription(targetId: string): Promise<boolean>;
	stopFrameSubscription(targetId: string): Promise<void>;
	/** targetIdを所有するworkbench window ID。対象が既に閉じられていればnull。 */
	resolveTargetWindowId(targetId: string): Promise<number | null>;
	/**
	 * WebRTCミラー用: 次の1回の getDisplayMedia が指定targetIdのWebContentsView単体を
	 * キャプチャするよう electron-main を arm する（one-shot、TTL付き）。
	 * モバイルの webrtc-offer 受信時に shared process から呼ぶ。
	 */
	armMirrorCapture(targetId: string): Promise<void>;
}

/**
 * バインド済み共有ページの「ペイントークン ⇔ CDP targetId」対応を読むための最小
 * インターフェース。実体は ParadisAgentBrowserService。モバイルリレーのブラウザミラーが
 * targets 応答に「どのページがどのエージェントペインと共有中か」を添えるために使う
 * （同一 shared process 内の直接参照。sharedProcessMain.ts が生成順に依存注入する）。
 */
export interface IParadisSharedPageBindings {
	listBoundCdpTargets(): Promise<{ token: string; targetId: string }[]>;
	/**
	 * PC側でペインが確認済み（既読）になった際に、そのペイントークンで発火する。
	 * モバイルリレーがこれを購読し、対応する通知をモバイル側の履歴からも消す
	 * （dismissed-token、notify チャネル）。
	 */
	readonly onDidAcknowledgePane: Event<string>;
}

/**
 * CDPゲートウェイ経由のスクリーンショット委譲リクエスト
 * （shared process → electron-main、{@link PARADIS_CDP_TARGET_CHANNEL} の
 * `captureScreenshot` メソッド引数）。
 * upstream の `IBrowserViewCaptureScreenshotOptions`（vs/platform/browserView/common/browserView.ts）
 * のサブセット。CDP `Page.captureScreenshot` のパラメータから
 * paradisCdpFilterProxy.ts がマッピングして生成する。
 */
export interface IParadisCdpScreenshotOptions {
	readonly format?: 'jpeg' | 'png';
	/** JPEG品質（0-100、formatが'jpeg'のときのみ）。 */
	readonly quality?: number;
	/** CDP `clip` 由来のページ内矩形（CSSピクセル）。 */
	readonly pageRect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	/** `pageRect`をドキュメント座標としてビューポート外までCDP captureする。 */
	readonly captureBeyondViewport?: boolean;
	/** CDP `captureBeyondViewport`（clipなし）由来のフルページ指定。 */
	readonly fullPage?: boolean;
}

/** IPCへ公開するexact BrowserView descriptor各文字列の上限。 */
export const PARADIS_EXACT_VIEW_ID_MAX_LENGTH = 512;
export const PARADIS_EXACT_VIEW_TARGET_ID_MAX_LENGTH = 512;
export const PARADIS_EXACT_VIEW_LEASE_MAX_LENGTH = 200;

/**
 * Electron Mainが特定のBrowserView実体へ発行する、copy-ownedなexact descriptor。
 * viewIdが再利用されてもviewLeaseが異なるため、旧bindingを新しいviewへ流用できない。
 */
export interface IParadisExactBrowserViewDescriptor {
	readonly windowId: number;
	readonly viewId: string;
	readonly targetId: string;
	readonly viewLease: string;
}

/**
 * shared processからElectron Mainへ呼ぶexact BrowserView操作。
 * モバイルミラー専用のIParadisCdpFrameSubscriptionとは意図的に分離する。
 */
export interface IParadisCdpExactViewService {
	resolveExactViewDescriptor(windowId: unknown, viewId: unknown): Promise<IParadisExactBrowserViewDescriptor | null>;
	isExactViewVisible(descriptor: unknown): Promise<boolean | null>;
	captureExactViewScreenshot(descriptor: unknown, options: unknown): Promise<string | null>;
	setExactViewBackgroundThrottling(descriptor: unknown, enabled: unknown): Promise<boolean>;
	dispatchExactViewInput(descriptor: unknown, method: unknown, paramsJson: unknown): Promise<IParadisCdpInputDispatchResult>;
}

export const PARADIS_CDP_INPUT_MAX_PARAMS_BYTES = 1024 * 1024;
const PARADIS_CDP_INPUT_MAX_IDENTIFIER_LENGTH = 128;
const PARADIS_CDP_INPUT_MAX_TOUCH_POINTS = 32;
const PARADIS_CDP_INPUT_MAX_DRAG_ITEMS = 64;
const PARADIS_CDP_INPUT_MAX_COMMANDS = 32;
const PARADIS_CDP_INPUT_MAX_RESULT_MESSAGE_LENGTH = 1024;

export const PARADIS_CDP_INPUT_METHODS = Object.freeze([
	'Input.dispatchKeyEvent',
	'Input.insertText',
	'Input.imeSetComposition',
	'Input.dispatchMouseEvent',
	'Input.dispatchTouchEvent',
	'Input.dispatchDragEvent',
] as const);

export type ParadisCdpInputMethod = typeof PARADIS_CDP_INPUT_METHODS[number];

export interface IParadisCdpInputCommand {
	readonly method: ParadisCdpInputMethod;
	readonly params: Readonly<Record<string, unknown>>;
}

export type IParadisCdpInputDispatchResult =
	| { readonly status: 'success'; readonly result: unknown }
	| { readonly status: 'retryable'; readonly message: string }
	| { readonly status: 'outcome-unknown'; readonly message: string };

function paradisIsExactRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function paradisHasExactKeys(value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean {
	const keys = Reflect.ownKeys(value);
	return required.every(key => Object.hasOwn(value, key))
		&& keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)));
}

function paradisIsBoundedNonEmptyString(value: unknown, maximumLength: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function paradisIsBoundedString(value: unknown, maximumLength = PARADIS_CDP_INPUT_MAX_PARAMS_BYTES): value is string {
	return typeof value === 'string' && value.length <= maximumLength;
}

function paradisIsFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function paradisIsIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function paradisIsBoolean(value: unknown): value is boolean {
	return typeof value === 'boolean';
}

function paradisValidateOptionalFields(
	value: Readonly<Record<string, unknown>>,
	validators: Readonly<Record<string, (candidate: unknown) => boolean>>,
): boolean {
	return Object.entries(validators).every(([key, validate]) => !Object.hasOwn(value, key) || validate(value[key]));
}

function paradisValidateCdpInputModifiers(value: unknown): boolean {
	return paradisIsIntegerInRange(value, 0, 15);
}

function paradisValidateCdpInputTimestamp(value: unknown): boolean {
	return paradisIsFiniteNumber(value) && value >= 0;
}

function paradisValidateCdpKeyEvent(value: Readonly<Record<string, unknown>>): boolean {
	if (!paradisHasExactKeys(value, ['type', 'key', 'code'], [
		'modifiers', 'timestamp', 'text', 'unmodifiedText', 'windowsVirtualKeyCode', 'nativeVirtualKeyCode',
		'autoRepeat', 'isKeypad', 'isSystemKey', 'location', 'commands',
	])) {
		return false;
	}
	if (!['keyDown', 'keyUp', 'rawKeyDown', 'char'].includes(value.type as string)
		|| !paradisIsBoundedString(value.key, PARADIS_CDP_INPUT_MAX_IDENTIFIER_LENGTH)
		|| !paradisIsBoundedString(value.code, PARADIS_CDP_INPUT_MAX_IDENTIFIER_LENGTH)) {
		return false;
	}
	return paradisValidateOptionalFields(value, {
		modifiers: paradisValidateCdpInputModifiers,
		timestamp: paradisValidateCdpInputTimestamp,
		text: candidate => paradisIsBoundedString(candidate),
		unmodifiedText: candidate => paradisIsBoundedString(candidate),
		windowsVirtualKeyCode: candidate => paradisIsIntegerInRange(candidate, 0, 0x7fffffff),
		nativeVirtualKeyCode: candidate => paradisIsIntegerInRange(candidate, 0, 0x7fffffff),
		autoRepeat: paradisIsBoolean,
		isKeypad: paradisIsBoolean,
		isSystemKey: paradisIsBoolean,
		location: candidate => paradisIsIntegerInRange(candidate, 0, 3),
		commands: candidate => Array.isArray(candidate)
			&& candidate.length <= PARADIS_CDP_INPUT_MAX_COMMANDS
			&& candidate.every(command => paradisIsBoundedString(command, PARADIS_CDP_INPUT_MAX_IDENTIFIER_LENGTH)),
	});
}

function paradisValidateCdpImeComposition(value: Readonly<Record<string, unknown>>): boolean {
	if (!paradisHasExactKeys(value, ['text', 'selectionStart', 'selectionEnd'], ['replacementStart', 'replacementEnd'])
		|| !paradisIsBoundedString(value.text)
		|| !paradisIsIntegerInRange(value.selectionStart, 0, 0x7fffffff)
		|| !paradisIsIntegerInRange(value.selectionEnd, 0, 0x7fffffff)) {
		return false;
	}
	return paradisValidateOptionalFields(value, {
		replacementStart: candidate => paradisIsIntegerInRange(candidate, 0, 0x7fffffff),
		replacementEnd: candidate => paradisIsIntegerInRange(candidate, 0, 0x7fffffff),
	});
}

const paradisPointerOptionalValidators: Readonly<Record<string, (candidate: unknown) => boolean>> = {
	modifiers: paradisValidateCdpInputModifiers,
	timestamp: paradisValidateCdpInputTimestamp,
	button: candidate => typeof candidate === 'string' && ['none', 'left', 'middle', 'right', 'back', 'forward'].includes(candidate),
	buttons: candidate => paradisIsIntegerInRange(candidate, 0, 31),
	clickCount: candidate => paradisIsIntegerInRange(candidate, 0, 0x7fffffff),
	force: candidate => paradisIsFiniteNumber(candidate) && candidate >= 0 && candidate <= 1,
	tangentialPressure: candidate => paradisIsFiniteNumber(candidate) && candidate >= -1 && candidate <= 1,
	tiltX: candidate => paradisIsFiniteNumber(candidate) && candidate >= -90 && candidate <= 90,
	tiltY: candidate => paradisIsFiniteNumber(candidate) && candidate >= -90 && candidate <= 90,
	twist: candidate => paradisIsFiniteNumber(candidate) && candidate >= 0 && candidate <= 359,
	deltaX: paradisIsFiniteNumber,
	deltaY: paradisIsFiniteNumber,
	pointerType: candidate => candidate === 'mouse' || candidate === 'pen',
};

function paradisValidateCdpMouseEvent(value: Readonly<Record<string, unknown>>): boolean {
	if (!paradisHasExactKeys(value, ['type', 'x', 'y'], Object.keys(paradisPointerOptionalValidators))
		|| !['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(value.type as string)
		|| !paradisIsFiniteNumber(value.x)
		|| !paradisIsFiniteNumber(value.y)) {
		return false;
	}
	return paradisValidateOptionalFields(value, paradisPointerOptionalValidators);
}

function paradisValidateCdpTouchPoint(value: unknown): boolean {
	if (!paradisIsExactRecord(value)
		|| !paradisHasExactKeys(value, ['x', 'y'], ['radiusX', 'radiusY', 'rotationAngle', 'force', 'tangentialPressure', 'tiltX', 'tiltY', 'twist', 'id'])
		|| !paradisIsFiniteNumber(value.x)
		|| !paradisIsFiniteNumber(value.y)) {
		return false;
	}
	return paradisValidateOptionalFields(value, {
		radiusX: candidate => paradisIsFiniteNumber(candidate) && candidate >= 0,
		radiusY: candidate => paradisIsFiniteNumber(candidate) && candidate >= 0,
		rotationAngle: paradisIsFiniteNumber,
		force: candidate => paradisIsFiniteNumber(candidate) && candidate >= 0 && candidate <= 1,
		tangentialPressure: candidate => paradisIsFiniteNumber(candidate) && candidate >= -1 && candidate <= 1,
		tiltX: candidate => paradisIsFiniteNumber(candidate) && candidate >= -90 && candidate <= 90,
		tiltY: candidate => paradisIsFiniteNumber(candidate) && candidate >= -90 && candidate <= 90,
		twist: candidate => paradisIsFiniteNumber(candidate) && candidate >= 0 && candidate <= 359,
		id: candidate => paradisIsIntegerInRange(candidate, 0, 0x7fffffff),
	});
}

function paradisValidateCdpTouchEvent(value: Readonly<Record<string, unknown>>): boolean {
	if (!paradisHasExactKeys(value, ['type', 'touchPoints'], ['modifiers', 'timestamp'])
		|| !['touchStart', 'touchEnd', 'touchMove', 'touchCancel'].includes(value.type as string)
		|| !Array.isArray(value.touchPoints)
		|| value.touchPoints.length > PARADIS_CDP_INPUT_MAX_TOUCH_POINTS
		|| ((value.type === 'touchStart' || value.type === 'touchMove') && value.touchPoints.length === 0)
		|| !value.touchPoints.every(paradisValidateCdpTouchPoint)) {
		return false;
	}
	return paradisValidateOptionalFields(value, {
		modifiers: paradisValidateCdpInputModifiers,
		timestamp: paradisValidateCdpInputTimestamp,
	});
}

function paradisValidateCdpDragItem(value: unknown): boolean {
	return paradisIsExactRecord(value)
		&& paradisHasExactKeys(value, ['mimeType', 'data'], ['title', 'baseURL'])
		&& paradisIsBoundedString(value.mimeType, PARADIS_CDP_INPUT_MAX_IDENTIFIER_LENGTH)
		&& paradisIsBoundedString(value.data)
		&& paradisValidateOptionalFields(value, {
			title: candidate => paradisIsBoundedString(candidate),
			baseURL: candidate => paradisIsBoundedString(candidate),
		});
}

function paradisValidateCdpDragData(value: unknown): boolean {
	if (!paradisIsExactRecord(value)
		|| !paradisHasExactKeys(value, ['items', 'dragOperationsMask'], ['files'])
		|| !Array.isArray(value.items)
		|| value.items.length > PARADIS_CDP_INPUT_MAX_DRAG_ITEMS
		|| !value.items.every(paradisValidateCdpDragItem)
		|| !paradisIsIntegerInRange(value.dragOperationsMask, 0, 0x7fffffff)) {
		return false;
	}
	return !Object.hasOwn(value, 'files')
		|| (Array.isArray(value.files)
			&& value.files.length <= PARADIS_CDP_INPUT_MAX_DRAG_ITEMS
			&& value.files.every(file => paradisIsBoundedString(file)));
}

function paradisValidateCdpDragEvent(value: Readonly<Record<string, unknown>>): boolean {
	return paradisHasExactKeys(value, ['type', 'x', 'y', 'data'], ['modifiers'])
		&& typeof value.type === 'string'
		&& ['dragEnter', 'dragOver', 'drop', 'dragCancel'].includes(value.type)
		&& paradisIsFiniteNumber(value.x)
		&& paradisIsFiniteNumber(value.y)
		&& paradisValidateCdpDragData(value.data)
		&& paradisValidateOptionalFields(value, { modifiers: paradisValidateCdpInputModifiers });
}

function paradisDeepFreeze<T>(value: T): T {
	if ((typeof value !== 'object' && typeof value !== 'function') || value === null || Object.isFrozen(value)) {
		return value;
	}
	for (const key of Reflect.ownKeys(value)) {
		paradisDeepFreeze(Reflect.get(value as object, key));
	}
	return Object.freeze(value);
}

/** Strict, non-throwing parser for the only CDP input commands that can use focusless Main dispatch. */
export function paradisParseCdpInputCommand(methodValue: unknown, paramsJsonValue: unknown): IParadisCdpInputCommand | undefined {
	try {
		if (typeof methodValue !== 'string'
			|| !(PARADIS_CDP_INPUT_METHODS as readonly string[]).includes(methodValue)
			|| typeof paramsJsonValue !== 'string'
			|| VSBuffer.fromString(paramsJsonValue).byteLength > PARADIS_CDP_INPUT_MAX_PARAMS_BYTES) {
			return undefined;
		}
		const params: unknown = JSON.parse(paramsJsonValue);
		if (!paradisIsExactRecord(params)) {
			return undefined;
		}
		const valid = (() => {
			switch (methodValue as ParadisCdpInputMethod) {
				case 'Input.dispatchKeyEvent': return paradisValidateCdpKeyEvent(params);
				case 'Input.insertText': return paradisHasExactKeys(params, ['text']) && paradisIsBoundedString(params.text);
				case 'Input.imeSetComposition': return paradisValidateCdpImeComposition(params);
				case 'Input.dispatchMouseEvent': return paradisValidateCdpMouseEvent(params);
				case 'Input.dispatchTouchEvent': return paradisValidateCdpTouchEvent(params);
				case 'Input.dispatchDragEvent': return paradisValidateCdpDragEvent(params);
			}
		})();
		return valid
			? Object.freeze({ method: methodValue as ParadisCdpInputMethod, params: paradisDeepFreeze(params) })
			: undefined;
	} catch {
		return undefined;
	}
}

/** Strict, copy-owning parser for the Main input IPC result. */
export function paradisParseCdpInputDispatchResult(value: unknown): IParadisCdpInputDispatchResult | undefined {
	try {
		if (!paradisIsExactRecord(value) || typeof value.status !== 'string') {
			return undefined;
		}
		if (value.status === 'success') {
			if (!paradisHasExactKeys(value, ['status', 'result'])) {
				return undefined;
			}
			const json = JSON.stringify(value.result);
			if (json === undefined || VSBuffer.fromString(json).byteLength > PARADIS_CDP_INPUT_MAX_PARAMS_BYTES) {
				return undefined;
			}
			return Object.freeze({ status: 'success', result: paradisDeepFreeze(JSON.parse(json)) });
		}
		if (value.status !== 'retryable' && value.status !== 'outcome-unknown') {
			return undefined;
		}
		if (!paradisHasExactKeys(value, ['status', 'message'])
			|| typeof value.message !== 'string'
			|| value.message.length === 0
			|| value.message.length > PARADIS_CDP_INPUT_MAX_RESULT_MESSAGE_LENGTH) {
			return undefined;
		}
		const prefix = value.status === 'retryable' ? 'PARA_BROWSER_RETRYABLE:' : 'PARA_BROWSER_OUTCOME_UNKNOWN:';
		return value.message.startsWith(prefix)
			? Object.freeze({ status: value.status, message: value.message }) as IParadisCdpInputDispatchResult
			: undefined;
	} catch {
		return undefined;
	}
}

/** Strict, non-coercing parser for an exact BrowserView owner window ID. */
export function paradisParseExactBrowserViewWindowId(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Strict, non-coercing parser for an exact BrowserView resolver view ID. */
export function paradisParseExactBrowserViewId(value: unknown): string | undefined {
	return paradisIsBoundedNonEmptyString(value, PARADIS_EXACT_VIEW_ID_MAX_LENGTH) ? value : undefined;
}

/** Strict, non-throwing and copy-owning parser for exact BrowserView descriptors. */
export function paradisParseExactBrowserViewDescriptor(value: unknown): IParadisExactBrowserViewDescriptor | undefined {
	try {
		return paradisParseExactBrowserViewDescriptorUnsafe(value);
	} catch {
		return undefined;
	}
}

function paradisParseExactBrowserViewDescriptorUnsafe(value: unknown): IParadisExactBrowserViewDescriptor | undefined {
	if (!paradisIsExactRecord(value)
		|| !paradisHasExactKeys(value, ['windowId', 'viewId', 'targetId', 'viewLease'])) {
		return undefined;
	}
	const windowIdValue = value.windowId;
	const viewIdValue = value.viewId;
	const targetId = value.targetId;
	const viewLease = value.viewLease;
	const windowId = paradisParseExactBrowserViewWindowId(windowIdValue);
	const viewId = paradisParseExactBrowserViewId(viewIdValue);
	if (windowId === undefined
		|| viewId === undefined
		|| !paradisIsBoundedNonEmptyString(targetId, PARADIS_EXACT_VIEW_TARGET_ID_MAX_LENGTH)
		|| !paradisIsBoundedNonEmptyString(viewLease, PARADIS_EXACT_VIEW_LEASE_MAX_LENGTH)) {
		return undefined;
	}
	return Object.freeze({ windowId, viewId, targetId, viewLease });
}

const PARADIS_CDP_SCREENSHOT_MAX_EDGE = 8_192;
const PARADIS_CDP_SCREENSHOT_MAX_PIXELS = 16 * 1024 * 1024;

/** Strict, non-throwing and deeply copy-owning parser for exact screenshot options. */
export function paradisParseExactCdpScreenshotOptions(value: unknown): IParadisCdpScreenshotOptions | undefined {
	try {
		return paradisParseExactCdpScreenshotOptionsUnsafe(value);
	} catch {
		return undefined;
	}
}

function paradisParseExactCdpScreenshotOptionsUnsafe(value: unknown): IParadisCdpScreenshotOptions | undefined {
	if (!paradisIsExactRecord(value)
		|| !paradisHasExactKeys(value, [], ['format', 'quality', 'pageRect', 'captureBeyondViewport', 'fullPage'])) {
		return undefined;
	}
	const hasFormat = Object.hasOwn(value, 'format');
	const hasQuality = Object.hasOwn(value, 'quality');
	const hasPageRect = Object.hasOwn(value, 'pageRect');
	const hasCaptureBeyondViewport = Object.hasOwn(value, 'captureBeyondViewport');
	const hasFullPage = Object.hasOwn(value, 'fullPage');
	const format = hasFormat ? value.format : undefined;
	const quality = hasQuality ? value.quality : undefined;
	const pageRectValue = hasPageRect ? value.pageRect : undefined;
	const captureBeyondViewport = hasCaptureBeyondViewport ? value.captureBeyondViewport : undefined;
	const fullPage = hasFullPage ? value.fullPage : undefined;
	if (hasFormat && format !== 'jpeg' && format !== 'png') {
		return undefined;
	}
	if (hasQuality
		&& (typeof quality !== 'number' || !Number.isInteger(quality) || quality < 0 || quality > 100)) {
		return undefined;
	}
	if (hasCaptureBeyondViewport && typeof captureBeyondViewport !== 'boolean') {
		return undefined;
	}
	if (hasFullPage && typeof fullPage !== 'boolean') {
		return undefined;
	}

	let pageRect: IParadisCdpScreenshotOptions['pageRect'];
	if (hasPageRect) {
		if (!paradisIsExactRecord(pageRectValue)
			|| !paradisHasExactKeys(pageRectValue, ['x', 'y', 'width', 'height'])) {
			return undefined;
		}
		const x = pageRectValue.x;
		const y = pageRectValue.y;
		const width = pageRectValue.width;
		const height = pageRectValue.height;
		if (![x, y, width, height].every(candidate => typeof candidate === 'number' && Number.isFinite(candidate))
			|| (width as number) <= 0
			|| (height as number) <= 0
			|| (width as number) > PARADIS_CDP_SCREENSHOT_MAX_EDGE
			|| (height as number) > PARADIS_CDP_SCREENSHOT_MAX_EDGE
			|| (width as number) * (height as number) > PARADIS_CDP_SCREENSHOT_MAX_PIXELS) {
			return undefined;
		}
		pageRect = Object.freeze({ x: x as number, y: y as number, width: width as number, height: height as number });
	}
	if ((pageRect !== undefined && fullPage === true)
		|| (captureBeyondViewport === true && pageRect === undefined)) {
		return undefined;
	}

	return Object.freeze({
		...(hasFormat ? { format: format as 'jpeg' | 'png' } : {}),
		...(hasQuality ? { quality: quality as number } : {}),
		...(pageRect !== undefined ? { pageRect } : {}),
		...(hasCaptureBeyondViewport ? { captureBeyondViewport: captureBeyondViewport as boolean } : {}),
		...(hasFullPage ? { fullPage: fullPage as boolean } : {}),
	});
}

/**
 * バインド時に記録される共有ページの情報。
 */
export interface IParadisSharedPageInfo {
	readonly url: string;
	readonly title: string;
}

/**
 * ペイントークンと共有ブラウザページのバインディング（shared process側レジストリの1エントリ）。
 */
export interface IParadisPaneBinding {
	readonly token: string;
	/** ブラウザビューのID（PlaywrightService の pageId / viewId に相当）。 */
	readonly pageId: string;
	readonly pageInfo: IParadisSharedPageInfo;
	/** 同一トークンのrebind/unbindごとに進む世代。条件付き自動解除に使う。 */
	readonly generation: number;
	/** バインドされた時刻（epoch ms）。バインディングダイアログの「共有開始 N分前」表示に使う。 */
	readonly boundAt: number;
	/** Stable scope authenticated by the prepare/commit authority transaction. */
	readonly scope: ParadisBindingAuthorityStableScope;
}

/** Renderer → shared process bind preparation. All fields are copied and bounded at the IPC edge. */
export interface IParadisPrepareBindRequest {
	readonly revision: number;
	readonly token: string;
	readonly viewId: string;
	readonly pageInfo: IParadisSharedPageInfo;
}

/** Short-lived authority ticket. The exact BrowserView descriptor remains backend-private. */
export interface IParadisPrepareBindResult {
	readonly ticketId: string;
	readonly expiresAt: number;
	readonly revision: number;
	readonly scope: ParadisBindingAuthorityStableScope;
}

export interface IParadisBindingTicketRequest {
	readonly ticketId: string;
}

export interface IParadisCommitBindResult {
	readonly committed: true;
	readonly binding: IParadisPaneBinding;
}

export interface IParadisAbortBindResult {
	readonly aborted: true;
}

/** Rendererからshared processへ同期する、window単位のペイン/PTY生存manifest。 */
export interface IParadisPaneShellManifest {
	/**
	 * falseはterminal復元途中の増分snapshot。欠落tokenを終了扱いにしてはならない。
	 * trueはterminal backend再接続完了後のauthoritative snapshot。
	 */
	readonly complete: boolean;
	readonly entries: readonly { readonly token: string; readonly shellPid?: number }[];
}

// --- エージェント実行状態 (workspaceSwitch のスピナー表示用、Superset 移植) ---------------------

/**
 * ペインで動くエージェントCLIの実行状態。Superset (apps/desktop の shared/tabs-types.ts
 * PaneStatus) の4状態モデル + 質問状態。idle は「エントリなし」で表現する。
 * - working: エージェントがターン実行中 (スピナー表示)
 * - permission: 人間の対応が必要 (ツール実行の許可待ち。赤の脈動表示)
 * - question: エージェントからの選択式質問 (AskUserQuestion) に回答待ち (赤の脈動表示)。
 *   permission と分ける理由: モバイル通知は質問本文入りの専用経路 (transcriptミラー) が
 *   担当するため、状態遷移ベースの汎用通知と二重にならないよう発火元で区別が要る
 * - review: ターン完了、確認待ち (緑の静止ドット。スコープを開いたら idle へ確認遷移)
 */
export type ParadisAgentStatus = 'working' | 'permission' | 'question' | 'review';

export interface IParadisAgentPaneStatus {
	readonly token: string;
	readonly status: ParadisAgentStatus;
	/** 最終更新 (epoch ms) */
	readonly changedAt: number;
	/**
	 * hookが最後に報告した作業ディレクトリ。renderer側でトークン→ターミナルの解決が
	 * できない場合 (ウィンドウリロード後にpark中のエディタターミナルがまだ復元されていない等) の
	 * スコープ解決フォールバック (cwd→リポジトリ/worktreeルートの最長一致) に使う。
	 */
	readonly cwd?: string;
}

/**
 * 各エージェントCLIのhookイベント名を状態へ正規化する。Superset の
 * main/lib/notifications/map-event-type.ts の正規化テーブル移植 + Claude Code の
 * Notification イベント対応。undefined = 未知イベント (無視)、'idle' = エントリ削除。
 */
// --- ワンボタンMCPセットアップ（バインディングダイアログの「自動セットアップ」用） -----------------

/** セットアップ対象のエージェントCLI種別。 */
export type ParadisMcpCli = 'claude' | 'codex';

/** 1つのMCPサーバー登録の結果。 */
export type ParadisMcpSetupOutcome = 'success' | 'already' | 'error';

/** ワンボタンMCPセットアップの要求。shim pathはshared processだけが解決する。 */
export interface IParadisMcpSetupRequest {
	readonly cli: ParadisMcpCli;
}

/** 各MCPサーバー（para-browser / chrome-devtools）ごとのセットアップ結果。 */
export interface IParadisMcpSetupServerResult {
	readonly server: string;
	readonly outcome: ParadisMcpSetupOutcome;
	/** outcome==='error' のときの詳細（stderr/例外メッセージ、表示用）。 */
	readonly detail?: string;
}

/** ワンボタンMCPセットアップの結果全体。 */
export interface IParadisMcpSetupResult {
	readonly cli: ParadisMcpCli;
	/** claude CLIがPATH上に見つかったか（codexでは常にtrue）。falseなら手動セットアップへ誘導する。 */
	readonly cliAvailable: boolean;
	/** 設定を書き込んだ先の説明（例: config.tomlの絶対パス。表示用、任意）。 */
	readonly target?: string;
	readonly servers: readonly IParadisMcpSetupServerResult[];
}

// --- MCP接続設定ステータス（バインディングダイアログの「MCP接続設定」タブ用） -----------------

/**
 * 各エージェントCLIのMCP設定状態。
 * - configured: para-browser（shim方式）が設定済み（緑）
 * - unconfigured: 未設定（グレー・「自動セットアップ」で導入）
 * - needsFix: 古いポートを決め打ち参照するchrome-devtools系エントリを検出（黄・「ワンクリックで修正」）
 */
export type ParadisMcpConfigState = 'configured' | 'unconfigured' | 'needsFix';

/** 1つのCLIのMCP設定ステータス（shared processが実設定ファイルを読んで判定）。 */
export interface IParadisMcpCliConfigStatus {
	readonly cli: ParadisMcpCli;
	readonly state: ParadisMcpConfigState;
	/** needsFix時に検出した、決め打ちされた古いゲートウェイポート（表示用）。 */
	readonly detectedPort?: number;
	/** configured時に設定を検出したファイルの絶対パス（表示用、任意）。 */
	readonly configPath?: string;
	/** 判定自体が失敗した場合（設定ファイルが読めない等）。trueなら state は既定値でUIはエラー表示する。 */
	readonly failed?: boolean;
	/**
	 * unconfigured時、自動セットアップが安全に行えない（既存のMCP設定があり自動追記が
	 * 曖昧になる）ため手動セットアップへ誘導すべきか。trueならUIは「自動セットアップ」ボタンを
	 * 出さず、手動コマンドの折りたたみだけを見せる。
	 */
	readonly manualOnly?: boolean;
}

/** MCP接続設定タブ全体のステータス。 */
export interface IParadisMcpConfigStatus {
	readonly claude: IParadisMcpCliConfigStatus;
	readonly codex: IParadisMcpCliConfigStatus;
	/** 判定基準に使った現在のゲートウェイポート（表示・デバッグ用、任意）。 */
	readonly gatewayPort?: number;
}

/** 「ワンクリックで修正」/「自動セットアップ」の要求（cli種別のみ）。 */
export interface IParadisMcpFixRequest {
	readonly cli: ParadisMcpCli;
}

export function paradisNormalizeAgentHookEvent(eventType: string, message?: string): ParadisAgentStatus | 'idle' | undefined {
	switch (eventType) {
		// 完了系: Claude Code / Codex / OpenCode
		// StopFailure は「APIエラーでターンが終わった」(Claude Code)。実行中表示が
		// 残り続けるより「終わったので確認して」の方が実態に合うため review に畳む。
		// SubagentStop は含めない: サブエージェント完了は本体ターンの終了ではなく、
		// review に畳むと本体実行中に完了通知・完了ドットが誤発火する。状態不変（undefined）
		// に落とし、本体の Stop だけでターン終了を扱う（'working' を返す形にしないのは、
		// 本体 Stop 後に遅れて届いた場合に review を巻き戻さないため）。
		case 'Stop':
		case 'StopFailure':
		case 'agent-turn-complete':
		case 'task_complete':
		case 'SessionEnd':
			return 'review';
		// Claude Code の Notification は許可要求以外でも発火する（プロンプトが60秒以上
		// 入力待ちのままのアイドル通知 "Claude is waiting for your input" 等）。message が
		// 許可要求を示すときだけ permission として扱い、それ以外は状態を変えない（undefined）。
		// 本物の許可要求の検出は PermissionRequest hook が本線で、これはその
		// フォールバック（PermissionRequest 未対応の旧 Claude Code 向け）。
		case 'Notification':
			return message !== undefined && /permission/i.test(message) ? 'permission' : undefined;
		// 要対応系: 許可要求・ユーザー入力要求
		case 'PermissionRequest':
		case 'exec_approval_request':
		case 'apply_patch_approval_request':
		case 'request_user_input':
		case 'permission.ask':
			return 'permission';
		// セッション開始はエージェント起動直後（プロンプト表示のみでターン未実行）にも発火する。
		// working にするとCLIを起動しただけで「実行中」表示になるため、状態は変えない
		// （実行中への遷移は UserPromptSubmit / PreToolUse 等の実際の活動イベントで行う）。
		case 'SessionStart':
			return undefined;
		// 実行中系
		// PostToolUseFailure / PermissionDenied はどちらも「ツールは失敗/拒否されたが
		// ターンは継続中」(Claude Code) なので実行中扱い (permission の解除にも効く)。
		case 'UserPromptSubmit':
		case 'PreToolUse':
		case 'PostToolUse':
		case 'PostToolUseFailure':
		case 'PermissionDenied':
		case 'task_started':
		case 'Start':
			return 'working';
		// 終了 (プロセス消滅)
		case 'TerminalExit':
			return 'idle';
		default:
			return undefined;
	}
}
