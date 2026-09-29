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
// 読み取り（状態・アプリとウィンドウの一覧・スクショ・アクセシビリティのツリー）と、操作（前面に出す・クリック・
// ドラッグ・スクロール・文字入力・貼り付け・キー・ホットキー）を持つ。設定画面での許可の取り消しは後の段で足す。
// 回答済みの設問: Q97〜Q101 はすべて案 A（2026-09-28）。

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
export const PARADIS_COMPUTER_USE_PROTOCOL_VERSION = 6;
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
 * （押せても何も増えないうえ、説明が事実と合わなくなるため）。
 */
export const PARADIS_COMPUTER_USE_OPERATE_AVAILABLE = true;

/** 承認ダイアログへ渡す中身。文字列はダイアログ側でもう一度削る。 */
export interface IParadisComputerUseApprovalPrompt {
	readonly appName: string;
	readonly bundleId: string;
	/** 求める許可。見出しの文言が変わる。 */
	readonly requested: 'read' | 'operate';
	/** 読み取りを許可済みのアプリの格上げ。「拒否」と「操作も許可」だけを出す。 */
	readonly upgrade: boolean;
	/** 「操作も許可」を選べるようにするか。 */
	readonly offerOperate: boolean;
}

/**
 * 承認の結果。`read` / `operate` / `denied` は台帳に記録する。ほかは記録しない。
 * `paneUnresolved` はウィンドウがそのペインを知らない（閉じた・別のウィンドウ）。
 * `timedOut` は締め切りまでに答えが無かった、`cancelled` は呼び出し側が取り消した。
 */
export type ParadisComputerUseApprovalOutcome = ParadisComputerUseGrant | 'cancelled' | 'timedOut' | 'unanswered' | 'busy' | 'recentlyDenied' | 'paneUnresolved';

const APPROVAL_OUTCOMES: readonly ParadisComputerUseApprovalOutcome[] = ['read', 'operate', 'denied', 'cancelled', 'timedOut', 'unanswered', 'busy', 'recentlyDenied', 'paneUnresolved'];

export function paradisParseComputerUseApprovalOutcome(value: unknown): ParadisComputerUseApprovalOutcome | undefined {
	const outcome = value && typeof value === 'object' ? (value as Record<string, unknown>).outcome : undefined;
	return APPROVAL_OUTCOMES.find(candidate => candidate === outcome);
}

// --- 常に操作させないアプリ（設計書 6.2） ---

/** 拒否の分類。エージェントへの説明と設定画面の表示に使う。 */
export type ParadisComputerUseBlockReason = 'password-manager' | 'authenticator' | 'keychain' | 'para-code' | 'system';

// 一覧は補助アプリの側（native/macos/Sources/ParadisComputerUseCore/ParadisBlocklist.swift）と同じにする（レビュー M1。
// 補助アプリも同じ判定をして二重にする）。build/paradis/computerUse/buildHelper.test.ts が突き合わせる。
// 末尾が `*` のものは、その手前で始まる bundle id 全部に当たる。前後が `*` のものは、その間を含む bundle id 全部に当たる。

/**
 * パスワードマネージャーとワンタイムコードのアプリ（Q64 で決定）。Orca の 8 件（main.swift:523-550）との和に、
 * KeePassXC・Enpass・Keeper などを足したもの（レビュー M8）。
 * 【要確認】各 id の実在（設計書 8 章 6 番。実機の `osascript -e 'id of app "..."'` で確かめる）。
 */
export const PARADIS_COMPUTER_USE_PASSWORD_MANAGERS: readonly string[] = [
	'com.1password.1password',
	'com.1password.safari',
	'com.1password.1password-launcher',
	'com.agilebits.onepassword7',
	'com.agilebits.onepassword-osx',
	'com.agilebits.onepassword4',
	'com.bitwarden.desktop',
	'com.8bit.bitwarden',
	'com.dashlane.dashlanephonefinal',
	'com.dashlane.Dashlane',
	'com.lastpass.LastPass',
	'com.lastpass.lastpassmacdesktop',
	'com.nordsec.nordpass',
	'me.proton.pass.electron',
	'me.proton.pass.catalyst',
	'com.apple.Passwords',
	'org.keepassxc.keepassxc',
	'in.sinew.Enpass-Desktop',
	'com.keepersecurity.passwordmanager',
	'com.markmcguill.strongbox.mac',
	'com.hicknhacksoftware.MacPass',
	'com.siber.roboform',
];

/**
 * 2 段階認証（ワンタイムコード）のアプリ。パスワードマネージャーと同じ扱い（ベータの実機で Proton Authenticator が
 * 通っていた）。前後が `*` のものは、その間を含む bundle id 全部に当たる。【要確認】各 id の実在。
 */
export const PARADIS_COMPUTER_USE_AUTHENTICATORS: readonly string[] = [
	'me.proton.authenticator',
	'com.authy.authy-mac',
	'com.google.Authenticator',
	'com.microsoft.azureauthenticator',
	'com.bitwarden.authenticator',
	'io.ente.auth',
	'*authenticator*',
	'*2fas*',
	'*raivo*',
	'*otpauth*',
	'*steptwo*',
	'*twofas*',
	'com.duosecurity.DuoMobile',
	'*duomobile*',
	'com.authy',
	'com.okta.mobile',
	'com.yubico.yubioath',
	'*yubioath*',
];

/** キーチェーンアクセス（Q64 で決定）。 */
export const PARADIS_COMPUTER_USE_KEYCHAIN_APPS: readonly string[] = [
	'com.apple.keychainaccess',
];

/**
 * Para Code 自身（Q64 で決定）。main と、その下の helper と Computer Use の補助アプリ。
 * 開発時の `com.github.Electron` は入れない（手元の `.build/electron` も `ltd.paradis.paracode` で、素の Electron を
 * Para Code とみなす理由が無いため。レビュー L1）。
 */
export const PARADIS_COMPUTER_USE_PARA_CODE_APPS: readonly string[] = [
	'ltd.paradis.paracode',
	'ltd.paradis.paracode.*',
];

/**
 * システム設定と認証・同意のダイアログ（Q97 の回答 A で「常に操作させない」に入れた）。
 * エージェントが「プライバシーとセキュリティ」で許可を足したり、管理者パスワードの入力欄に打ったりできないように。
 * 認証・同意のダイアログは通常のアプリとして一覧に出ないので、実際の守りは補助アプリの入力のフェンス
 * （出ている間は入力を送らない。レビュー M3）が担う。
 */
export const PARADIS_COMPUTER_USE_SYSTEM_SURFACES: readonly string[] = [
	'com.apple.systempreferences*',
	'com.apple.settings.*',
	'com.apple.SecurityAgent',
	'com.apple.LocalAuthentication.UIAgent',
	'com.apple.loginwindow',
	'com.apple.coreservices.uiagent',
	'com.apple.UserNotificationCenter',
	'com.apple.universalaccessAuthWarn',
];

/** システム設定と認証のダイアログも常に断る（Q97 の回答 A）。 */
export const PARADIS_COMPUTER_USE_BLOCK_SYSTEM_SURFACES = true;

export interface IParadisComputerUseBlockOptions {
	/** Q97 の分も断るか（既定は {@link PARADIS_COMPUTER_USE_BLOCK_SYSTEM_SURFACES}）。テストで切り替える。 */
	readonly blockSystemSurfaces?: boolean;
}

/** bundle id が一覧のどれかに当たるか（大文字小文字は区別しない。末尾の `*` は前方一致）。 */
export function paradisComputerUseMatchesBundle(bundleId: string, patterns: readonly string[]): boolean {
	const id = bundleId.toLowerCase();
	return patterns.some(pattern => {
		const lower = pattern.toLowerCase();
		if (lower.length > 2 && lower.startsWith('*') && lower.endsWith('*')) {
			return id.includes(lower.slice(1, -1));
		}
		return lower.endsWith('*') ? id.startsWith(lower.slice(0, -1)) : id === lower;
	});
}

/** そのアプリを常に断るなら理由を返す。 */
export function paradisComputerUseBlockReason(bundleId: string, options: IParadisComputerUseBlockOptions = {}): ParadisComputerUseBlockReason | undefined {
	if (paradisComputerUseMatchesBundle(bundleId, PARADIS_COMPUTER_USE_PASSWORD_MANAGERS)) {
		return 'password-manager';
	}
	if (paradisComputerUseMatchesBundle(bundleId, PARADIS_COMPUTER_USE_AUTHENTICATORS)) {
		return 'authenticator';
	}
	if (paradisComputerUseMatchesBundle(bundleId, PARADIS_COMPUTER_USE_KEYCHAIN_APPS)) {
		return 'keychain';
	}
	if (paradisComputerUseMatchesBundle(bundleId, PARADIS_COMPUTER_USE_PARA_CODE_APPS)) {
		return 'para-code';
	}
	if ((options.blockSystemSurfaces ?? PARADIS_COMPUTER_USE_BLOCK_SYSTEM_SURFACES) && paradisComputerUseMatchesBundle(bundleId, PARADIS_COMPUTER_USE_SYSTEM_SURFACES)) {
		return 'system';
	}
	return undefined;
}

// --- コマンドを打てるアプリ（Q98） ---

/**
 * 操作を許可すると任意のコマンドを打てるアプリ（ターミナル類とスクリプトエディタ）。Q98 の回答 A で、
 * 拒否リストには入れず、承認ダイアログに警告の一文を出すだけにした（Claude Code や Codex はもともと利用者の
 * 権限でコマンドを実行できるので、新しく危険が増えるわけではないため）。
 */
export const PARADIS_COMPUTER_USE_COMMAND_APPS: readonly string[] = [
	'com.apple.Terminal',
	'com.googlecode.iterm2',
	'com.mitchellh.ghostty',
	'dev.warp.Warp-Stable',
	'dev.warp.Warp-Preview',
	'net.kovidgoyal.kitty',
	'org.alacritty',
	'io.alacritty',
	'com.github.wez.wezterm',
	'co.zeit.hyper',
	'com.raphaelamorim.rio',
	'com.apple.ScriptEditor2',
	'com.apple.Automator',
	// ディスク上のスクリプトやアプリを開いて動かせる（レビュー N12）
	'com.apple.finder',
	// ターミナルを内蔵したエディタと、シェルを実行できるランチャー（レビュー L11。【要確認】各 id の実在）
	'com.microsoft.VSCode',
	'com.microsoft.VSCodeInsiders',
	'com.todesktop.230313mzl4w4u92',
	'dev.zed.Zed',
	'com.apple.dt.Xcode',
	'com.jetbrains.*',
	'com.apple.shortcuts',
	'com.raycast.macos',
	'com.runningwithcrayons.Alfred',
];

/** 操作を許可するとコマンドを打てるアプリか（承認ダイアログの警告に使う）。 */
export function paradisComputerUseRunsCommands(bundleId: string): boolean {
	return paradisComputerUseMatchesBundle(bundleId, PARADIS_COMPUTER_USE_COMMAND_APPS);
}
