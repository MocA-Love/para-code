/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Computer Use（B3、フェーズ7）の共通の定義。
//
// エージェントが macOS のほかのアプリの画面を読む（将来は操作する）機能。実際に OS へ触れるのは
// 同梱の補助アプリ「Para Code Computer Use.app」で、TCC の許可もそちらに付く。shared process が
// 補助アプリを起動して Unix ソケットで話し、para-browser MCP へツールを足す。
// 設計: phase7-b3/design.md（リポジトリ外）。安全の決め事は同 6 章。
//
// 今の版は読み取りだけ（状態・アプリとウィンドウの一覧・スクショ・アクセシビリティのツリー）。
// クリック・文字入力などの操作と、設定画面の許可の取り消しは後の段で足す。

// --- 設定 ---

/** Computer Use を使うか（既定オフ、利用者の設定でだけ変えられる）。 */
export const PARADIS_COMPUTER_USE_ENABLED_SETTING = 'paradis.computerUse.enabled';

/** 設定の生の値を読む。スキーマは画面側でしか登録されないので、shared process では型を確かめて既定（オフ）へ倒す。 */
export function paradisComputerUseEnabled(value: unknown): boolean {
	return value === true;
}

// --- 補助アプリ ---

export const PARADIS_COMPUTER_USE_APP_NAME = 'Para Code Computer Use.app';
export const PARADIS_COMPUTER_USE_EXECUTABLE = 'ParadisComputerUse';
/**
 * 補助アプリとの約束の版。Swift 側の `ParadisComputerUseVersion.protocolVersion`
 * （native/macos/Sources/ParadisComputerUseCore/ParadisProtocol.swift）と同じ値にする。
 */
export const PARADIS_COMPUTER_USE_PROTOCOL_VERSION = 1;
/** 対応する macOS の最低の Darwin の版（macOS 14 = Darwin 23）。ScreenCaptureKit の単一ウィンドウ撮影に要る。 */
export const PARADIS_COMPUTER_USE_MIN_DARWIN_MAJOR = 23;

/**
 * 補助アプリの状態（設計書 5.3）。`ok` 以外ではツールを出さない。
 * - `unchecked`: まだ確かめていない（機能がオフの間もこれ）
 * - `unsupported-os`: macOS 以外、または macOS 14 未満
 * - `missing`: 補助アプリがこのビルドに入っていない
 * - `launch-failed`: 起動・接続・handshake に失敗した
 * - `incompatible`: 約束の版が合わない
 * - `misattributed`: TCC の許可が補助アプリではなく別のプロセス（Para Code 本体など）で評価される
 */
export type ParadisComputerUseAvailability = 'unchecked' | 'unsupported-os' | 'missing' | 'launch-failed' | 'incompatible' | 'misattributed' | 'ok';

export const PARADIS_COMPUTER_USE_AVAILABILITIES: readonly ParadisComputerUseAvailability[] = ['unchecked', 'unsupported-os', 'missing', 'launch-failed', 'incompatible', 'misattributed', 'ok'];

/** OS の許可の状態（補助アプリ自身の値）。 */
export interface IParadisComputerUsePermissions {
	readonly accessibility: boolean;
	readonly screenRecording: boolean;
}

/** 画面側へ渡す状態。 */
export interface IParadisComputerUseStatus {
	readonly enabled: boolean;
	readonly availability: ParadisComputerUseAvailability;
	/** 失敗の理由（英語のログ向け。画面には出さない）。 */
	readonly detail?: string;
	readonly helperVersion?: string;
	readonly permissions?: IParadisComputerUsePermissions;
}

export function paradisParseComputerUseStatus(value: unknown): IParadisComputerUseStatus | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const availability = PARADIS_COMPUTER_USE_AVAILABILITIES.find(candidate => candidate === record.availability);
	if (!availability || typeof record.enabled !== 'boolean') {
		return undefined;
	}
	const permissions = record.permissions && typeof record.permissions === 'object' ? record.permissions as Record<string, unknown> : undefined;
	return {
		enabled: record.enabled,
		availability,
		...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
		...(typeof record.helperVersion === 'string' ? { helperVersion: record.helperVersion } : {}),
		...(permissions && typeof permissions.accessibility === 'boolean' && typeof permissions.screenRecording === 'boolean'
			? { permissions: { accessibility: permissions.accessibility, screenRecording: permissions.screenRecording } }
			: {}),
	};
}

// --- コマンド ---

/** 状態（補助アプリ・OS の許可）を確かめて見せるコマンド。設定画面の行から呼ぶ。 */
export const PARADIS_COMPUTER_USE_SHOW_STATUS_COMMAND_ID = 'paradis.computerUse.showStatus';

// --- チャネル ---

/** shared process が持つ、状態を返すチャネル（設定画面・コマンドが読む）。 */
export const PARADIS_COMPUTER_USE_STATUS_CHANNEL = 'paradisComputerUseStatus';
export const PARADIS_COMPUTER_USE_STATUS_METHOD = 'getStatus';
/** 状態を確かめ直す（補助アプリを起動し直す）。 */
export const PARADIS_COMPUTER_USE_REFRESH_METHOD = 'refresh';

/** ウィンドウ側が持つ、承認ダイアログのチャネル（shared process が呼び出し元ペインのウィンドウへだけ送る）。 */
export const PARADIS_COMPUTER_USE_APPROVAL_CHANNEL = 'paradisComputerUseApproval';
export const PARADIS_COMPUTER_USE_APPROVAL_METHOD = 'requestAccess';
/** 承認を待つ上限（設計書 3.5: 2 分）。 */
export const PARADIS_COMPUTER_USE_APPROVAL_TIMEOUT_MS = 2 * 60_000;

// --- 許可 ---

/** ペインとアプリの組ごとの決定。 */
export type ParadisComputerUseGrant = 'read' | 'operate' | 'denied';

/**
 * 操作系のツールがこの版にあるか。無い間は承認ダイアログで「操作も許可」を出さない
 * （押せても何も増えないうえ、「クリックと文字入力もします」という説明が事実と合わなくなるため）。
 * 操作系のツールを足す段（設計書 7 章 S3）で true にする。
 */
export const PARADIS_COMPUTER_USE_OPERATE_AVAILABLE = false;

/** 承認ダイアログへ渡す中身。文字列はダイアログ側でもう一度削る。 */
export interface IParadisComputerUseApprovalPrompt {
	readonly appName: string;
	readonly bundleId: string;
	/** 求める許可。`operate` は読み取りを許可済みのアプリの格上げ（「読み取りのみ」を出さない）。 */
	readonly requested: 'read' | 'operate';
	/** 「操作も許可」を選べるようにするか。 */
	readonly offerOperate: boolean;
}

/**
 * 承認の結果。`read` / `operate` / `denied` は台帳に記録する。ほかは記録しない。
 * `paneUnresolved` はウィンドウがそのペインを知らない（閉じた・別のウィンドウ）。
 */
export type ParadisComputerUseApprovalOutcome = ParadisComputerUseGrant | 'cancelled' | 'unanswered' | 'busy' | 'recentlyDenied' | 'paneUnresolved';

const APPROVAL_OUTCOMES: readonly ParadisComputerUseApprovalOutcome[] = ['read', 'operate', 'denied', 'cancelled', 'unanswered', 'busy', 'recentlyDenied', 'paneUnresolved'];

export function paradisParseComputerUseApprovalOutcome(value: unknown): ParadisComputerUseApprovalOutcome | undefined {
	const outcome = value && typeof value === 'object' ? (value as Record<string, unknown>).outcome : undefined;
	return APPROVAL_OUTCOMES.find(candidate => candidate === outcome);
}

// --- 常に操作させないアプリ（設計書 6.2） ---

/** 拒否の分類。エージェントへの説明と設定画面の表示に使う。 */
export type ParadisComputerUseBlockReason = 'password-manager' | 'keychain' | 'para-code' | 'system';

/**
 * パスワードマネージャー（Q64 で決定）。Orca の 8 件（main.swift:523-550）に、macOS 15 以降の「パスワード」と
 * 1Password 7・1Password の起動補助を足したもの。
 * 【要確認】`com.apple.Passwords` / `com.agilebits.onepassword7` / `com.1password.1password-launcher` の実在（設計書 8 章 6 番）。
 */
export const PARADIS_COMPUTER_USE_PASSWORD_MANAGERS: readonly string[] = [
	'com.1password.1password',
	'com.1password.safari',
	'com.1password.1password-launcher',
	'com.agilebits.onepassword7',
	'com.bitwarden.desktop',
	'com.dashlane.dashlanephonefinal',
	'com.lastpass.LastPass',
	'com.nordsec.nordpass',
	'me.proton.pass.electron',
	'me.proton.pass.catalyst',
	'com.apple.Passwords',
];

/** キーチェーンアクセス（Q64 で決定）。 */
export const PARADIS_COMPUTER_USE_KEYCHAIN_APPS: readonly string[] = [
	'com.apple.keychainaccess',
];

/** Para Code 自身の bundle id（Q64 で決定）。この id と、その下（`<id>.helper` など）の全部。 */
export const PARADIS_COMPUTER_USE_PARA_CODE_BUNDLE_ID = 'ltd.paradis.paracode';
/** 開発時（`./scripts/code.sh`）の Para Code。 */
export const PARADIS_COMPUTER_USE_DEVELOPMENT_BUNDLE_ID = 'com.github.Electron';

/**
 * システム設定と認証のダイアログ（Q97、回答待ち。推しは「常に操作させない」に足す案 A）。
 * 回答が A なら {@link PARADIS_COMPUTER_USE_BLOCK_SYSTEM_SURFACES} を true にするだけで効く。
 * `prefix` は、その id で始まるもの全部（`com.apple.settings.*` の拡張など）。
 */
export const PARADIS_COMPUTER_USE_SYSTEM_SURFACES: readonly { readonly id: string; readonly prefix?: boolean }[] = [
	{ id: 'com.apple.systempreferences' },
	{ id: 'com.apple.settings.', prefix: true },
	{ id: 'com.apple.SecurityAgent' },
	{ id: 'com.apple.LocalAuthentication.UIAgent' },
	{ id: 'com.apple.loginwindow' },
];

/** Q97 の回答で決める。true でシステム設定と認証のダイアログも常に断る。 */
export const PARADIS_COMPUTER_USE_BLOCK_SYSTEM_SURFACES = false;

export interface IParadisComputerUseBlockOptions {
	/** Q97 の分も断るか（既定は {@link PARADIS_COMPUTER_USE_BLOCK_SYSTEM_SURFACES}）。テストで切り替える。 */
	readonly blockSystemSurfaces?: boolean;
}

/** そのアプリを常に断るなら理由を返す。bundle id の大文字小文字は区別しない。 */
export function paradisComputerUseBlockReason(bundleId: string, options: IParadisComputerUseBlockOptions = {}): ParadisComputerUseBlockReason | undefined {
	const id = bundleId.toLowerCase();
	if (PARADIS_COMPUTER_USE_PASSWORD_MANAGERS.some(candidate => candidate.toLowerCase() === id)) {
		return 'password-manager';
	}
	if (PARADIS_COMPUTER_USE_KEYCHAIN_APPS.some(candidate => candidate.toLowerCase() === id)) {
		return 'keychain';
	}
	const self = PARADIS_COMPUTER_USE_PARA_CODE_BUNDLE_ID.toLowerCase();
	const development = PARADIS_COMPUTER_USE_DEVELOPMENT_BUNDLE_ID.toLowerCase();
	if (id === self || id.startsWith(`${self}.`) || id === development || id.startsWith(`${development}.`)) {
		return 'para-code';
	}
	if (options.blockSystemSurfaces ?? PARADIS_COMPUTER_USE_BLOCK_SYSTEM_SURFACES) {
		const blocked = PARADIS_COMPUTER_USE_SYSTEM_SURFACES.some(surface => surface.prefix ? id.startsWith(surface.id.toLowerCase()) : id === surface.id.toLowerCase());
		if (blocked) {
			return 'system';
		}
	}
	return undefined;
}
