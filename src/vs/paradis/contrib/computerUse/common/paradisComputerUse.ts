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
// ドラッグ・スクロール・文字入力・貼り付け・キー・ホットキー・値の変更）を持つ。設定画面での許可の取り消しは後の段で足す。
// 操作は、アクセシビリティで送れるもの（ボタンを押す・値を変える・欄へ文字を入れる）をマウスもカーソルも動かさず
// 前面にも出さずに送り、それ以外は前面に出して実カーソルとキーボードで送る（補助アプリの ParadisInputRoute.swift）。
// 回答済みの設問: Q97〜Q101 はすべて案 A（2026-09-28）。

// --- 設定 ---

/** Computer Use を使うか（既定オフ、利用者の設定でだけ変えられる）。 */
export const PARADIS_COMPUTER_USE_ENABLED_SETTING = 'paradis.computerUse.enabled';

/** 設定の生の値を読む。スキーマは画面側でしか登録されないので、shared process では型を確かめて既定（オフ）へ倒す。 */
export function paradisComputerUseEnabled(value: unknown): boolean {
	return value === true;
}

/**
 * 設定がオンになった知らせを出す通常ウィンドウの id を決める。どのウィンドウも同じ一覧から同じ答えを出すので、
 * 知らせは 1 つだけ出る。最後にフォーカスのあったウィンドウが通常ウィンドウならそこ、Agents ウィンドウなど
 * 知らせを出せないウィンドウ（または不明）なら、通常ウィンドウのうち id が最小のものにする。
 */
export function paradisComputerUseNoticeWindowId(activeWindowId: number | undefined, normalWindowIds: readonly number[]): number | undefined {
	if (activeWindowId !== undefined && normalWindowIds.includes(activeWindowId)) {
		return activeWindowId;
	}
	return normalWindowIds.length > 0 ? Math.min(...normalWindowIds) : undefined;
}

/**
 * 前面に出して実カーソルとキーボードを使う送り方（3 段目）の前に、利用者の承認を取るか（既定オン。オフにすると
 * 承認済みのアプリにはそのまま送る）。アクセシビリティ・背面で送れる操作（1・2 段目）には効かない。
 */
export const PARADIS_COMPUTER_USE_CONFIRM_FOREGROUND_SETTING = 'paradis.computerUse.confirmForegroundInput';

/** スキーマは画面側でしか登録されないので、shared process では明示のオフ（false）だけをオフにする（既定オン）。 */
export function paradisComputerUseConfirmForeground(value: unknown): boolean {
	return value !== false;
}

/** エージェントの独自のカーソル（名前の札つき）を画面に出すか（既定オン）。 */
export const PARADIS_COMPUTER_USE_SHOW_CURSOR_SETTING = 'paradis.computerUse.showCursorOverlay';

export function paradisComputerUseShowCursor(value: unknown): boolean {
	return value !== false;
}

/**
 * ブラウザ・リモートデスクトップ・取引アプリ（{@link paradisComputerUseReadOnlyReason}）も操作させるか（既定オフ。
 * オフの間は画面を読むだけ）。ペインのエージェントは settings.json を書き換えられるので、これは守りの境界ではない。
 * オンでも、アプリごとの「操作」の承認は必ず通る。
 */
export const PARADIS_COMPUTER_USE_ALLOW_OPERATING_READ_ONLY_APPS_SETTING = 'paradis.computerUse.allowOperatingReadOnlyApps';

/** スキーマは画面側でしか登録されないので、shared process では明示のオン（true）だけをオンにする（既定オフ）。 */
export function paradisComputerUseAllowOperatingReadOnlyApps(value: unknown): boolean {
	return value === true;
}

// --- 補助アプリ ---

export const PARADIS_COMPUTER_USE_APP_NAME = 'Para Code Computer Use.app';
export const PARADIS_COMPUTER_USE_EXECUTABLE = 'ParadisComputerUse';
/**
 * 補助アプリとの約束の版。Swift 側の `ParadisComputerUseVersion.protocolVersion`
 * （native/macos/Sources/ParadisComputerUseCore/ParadisProtocol.swift）と同じ値にする。
 */
export const PARADIS_COMPUTER_USE_PROTOCOL_VERSION = 9;
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

/**
 * 利用者が Esc の 2 回押しで止めた Computer Use を再開するコマンド。再開できるのは Para Code の画面での人の操作
 * （通知の「再開」・ステータスバー・このコマンド）だけで、MCP のツール・para CLI・設定からは再開できない。
 */
export const PARADIS_COMPUTER_USE_RESUME_COMMAND_ID = 'paradis.computerUse.resume';

// --- チャネル ---

/** shared process が持つ、状態を返すチャネル（設定画面・コマンドが読む）。 */
export const PARADIS_COMPUTER_USE_STATUS_CHANNEL = 'paradisComputerUseStatus';
export const PARADIS_COMPUTER_USE_STATUS_METHOD = 'getStatus';
/** 状態を確かめ直す（補助アプリを起動し直す）。 */
export const PARADIS_COMPUTER_USE_REFRESH_METHOD = 'refresh';

/** 止まっているか（{@link IParadisComputerUseActivity}）を返す。 */
export const PARADIS_COMPUTER_USE_ACTIVITY_METHOD = 'getActivity';
/** 止めた Computer Use を再開する（補助アプリの掛け金を外す）。ウィンドウの人の操作からだけ呼ぶ。 */
export const PARADIS_COMPUTER_USE_RESUME_METHOD = 'resume';
/** 止まった・再開した・入力を送ったときに全ウィンドウへ知らせるイベント（{@link IParadisComputerUseActivity}）。 */
export const PARADIS_COMPUTER_USE_ACTIVITY_EVENT = 'onDidChangeActivity';

/**
 * Computer Use の動き（ステータスバーと「止めました」の通知に使う）。
 * `stopped`: 利用者が Esc の 2 回押しで止めていて、再開するまで入力を送らない。
 * `input`: 今この知らせの時点で、入力の要求を補助アプリへ送った（ステータスバーの「操作中」を数秒出す）。
 */
export interface IParadisComputerUseActivity {
	readonly stopped: boolean;
	readonly input: boolean;
	/**
	 * その入力の的が、コマンドを打てるアプリ（{@link PARADIS_COMPUTER_USE_COMMAND_APPS}）のとき true。承認の画面が、
	 * その最中と直後の承認を聞き直すのに使う（paradisComputerUseInputClock.ts）。
	 */
	readonly commandApp?: boolean;
}

export function paradisParseComputerUseActivity(value: unknown): IParadisComputerUseActivity | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	return typeof record.stopped === 'boolean' ? { stopped: record.stopped, input: record.input === true, ...(record.input === true && record.commandApp === true ? { commandApp: true } : {}) } : undefined;
}

/** ステータスバーに出すもの。 */
export type ParadisComputerUseActivityView = 'stopped' | 'active' | undefined;

/** ウィンドウが覚えている状態。 */
export interface IParadisComputerUseActivityState {
	readonly stopped: boolean;
	/** 入力を送ってから数秒の間（ウィンドウ側が時間で下ろす）。 */
	readonly active: boolean;
}

/**
 * 知らせを受けたときの次の状態と、することを決める。
 * `notify`: 止まった（止まっていなかった状態から）。通知を 1 回出す。`closeNotice`: 再開した。通知を閉じる。
 * `armActiveTimer`: 入力を送った。「操作中」を出し、時間が来たら消す。止まっている間の入力の知らせでは「操作中」にしない。
 */
export function paradisComputerUseNextActivity(state: IParadisComputerUseActivityState, activity: IParadisComputerUseActivity): { readonly state: IParadisComputerUseActivityState; readonly notify: boolean; readonly closeNotice: boolean; readonly armActiveTimer: boolean } {
	const armActiveTimer = activity.input && !activity.stopped;
	return {
		state: { stopped: activity.stopped, active: activity.stopped ? false : armActiveTimer || state.active },
		notify: activity.stopped && !state.stopped,
		closeNotice: !activity.stopped && state.stopped,
		armActiveTimer,
	};
}

/** ステータスバーに何を出すか。設定がオフの間は何も出さない（使っていない機能の痕跡を残さない）。 */
export function paradisComputerUseActivityView(state: IParadisComputerUseActivityState, enabled: boolean): ParadisComputerUseActivityView {
	if (!enabled) {
		return undefined;
	}
	return state.stopped ? 'stopped' : state.active ? 'active' : undefined;
}

/** ウィンドウ側が持つ、承認ダイアログのチャネル（shared process が呼び出し元ペインのウィンドウへだけ送る）。 */
export const PARADIS_COMPUTER_USE_APPROVAL_CHANNEL = 'paradisComputerUseApproval';
export const PARADIS_COMPUTER_USE_APPROVAL_METHOD = 'requestAccess';
/** 前面に出して実カーソルとキーボードを使う前の承認（設定 {@link PARADIS_COMPUTER_USE_CONFIRM_FOREGROUND_SETTING}）。 */
export const PARADIS_COMPUTER_USE_FOREGROUND_METHOD = 'requestForeground';
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

/** 前面の承認ダイアログへ渡す中身。 */
export interface IParadisComputerUseForegroundPrompt {
	readonly appName: string;
	readonly bundleId: string;
	/** 求めている操作（`click`・`type_text` など、ツール名から `computer_` を外したもの）。 */
	readonly action: string;
}

/**
 * 前面の承認の結果。`once` はこの 1 回だけ、`pane` はこのターミナルからのこのアプリへの操作を Para Code を終了するまで
 * 聞かない。ほかは {@link ParadisComputerUseApprovalOutcome} と同じ意味（`read`・`operate` は来ない）。
 */
export type ParadisComputerUseForegroundOutcome = 'once' | 'pane' | Exclude<ParadisComputerUseApprovalOutcome, 'read' | 'operate'>;

const FOREGROUND_OUTCOMES: readonly ParadisComputerUseForegroundOutcome[] = ['once', 'pane', 'denied', 'cancelled', 'timedOut', 'unanswered', 'busy', 'recentlyDenied', 'paneUnresolved'];

export function paradisParseComputerUseForegroundOutcome(value: unknown): ParadisComputerUseForegroundOutcome | undefined {
	const outcome = value && typeof value === 'object' ? (value as Record<string, unknown>).outcome : undefined;
	return FOREGROUND_OUTCOMES.find(candidate => candidate === outcome);
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

// --- 読むだけにするアプリ ---
//
// 画面を読むのは許すが、入力は送らないアプリ。常に断るアプリ（上）と違い、利用者が設定
// {@link PARADIS_COMPUTER_USE_ALLOW_OPERATING_READ_ONLY_APPS_SETTING} をオンにすれば操作も許せる。
// 一覧は補助アプリの側（ParadisBlocklist.swift）と同じにする（突き合わせテストが見る）。補助アプリも同じ判定をして二重にする。
// 一覧は公開されている bundle id の知識から作った。【要確認】は実機で実在を確かめていないもの。

/** 読むだけにする理由。エージェントへの説明に使う。 */
export type ParadisComputerUseReadOnlyReason = 'remote-desktop' | 'browser' | 'trading';

/**
 * リモートデスクトップ・画面共有。遠隔先の画面の中では、常に断るアプリの一覧もアプリごとの承認も効かない。
 * 【要確認】com.apple.ScreenSharing・com.apple.RemoteDesktop・com.microsoft.rdc.macos・com.teamviewer.TeamViewer 以外の各 id の実在。
 */
export const PARADIS_COMPUTER_USE_READ_ONLY_REMOTE_DESKTOP_APPS: readonly string[] = [
	'com.apple.ScreenSharing',
	'com.apple.RemoteDesktop',
	'com.microsoft.rdc.macos',
	'com.teamviewer.TeamViewer',
	'com.philandro.anydesk',
	'com.realvnc.vncviewer',
	'tv.parsec.www',
	'com.p5sys.jump.mac.viewer',
	'com.edovia.screens*',
	'com.citrix.receiver.*',
	'com.vmware.horizon',
	'com.omnissa.horizon.client.mac',
	'com.carriez.rustdesk',
	'com.nomachine.nxplayer',
	'com.splashtop.*',
	'*chromeremotedesktop*',
];

/**
 * ブラウザ。ログイン中のサイトを利用者として操作できる。Para Code には内蔵ブラウザの道具があるので、そちらを使わせる。
 * 末尾が `*` のものは、派生の版（Beta・Dev・Canary）とブラウザが作るウェブアプリも含む。
 * 【要確認】company.thebrowser.dia・com.kagi.kagimacOS・app.zen-browser.zen・ai.perplexity.comet・com.openai.atlas の実在。
 */
export const PARADIS_COMPUTER_USE_READ_ONLY_BROWSERS: readonly string[] = [
	'com.apple.Safari*',
	'com.google.Chrome*',
	'org.chromium.Chromium',
	'org.mozilla.firefox*',
	'org.mozilla.nightly',
	'com.microsoft.edgemac*',
	'com.brave.Browser*',
	'company.thebrowser.Browser',
	'company.thebrowser.dia',
	'com.operasoftware.Opera*',
	'com.vivaldi.Vivaldi*',
	'com.duckduckgo.macos.browser',
	'org.torproject.torbrowser',
	'com.kagi.kagimacOS*',
	'app.zen-browser.zen',
	'ai.perplexity.comet',
	'com.openai.atlas',
];

/**
 * 証券・暗号資産の取引アプリとウォレット。注文と送金は取り消せない。
 * 【要確認】どの id も実機で確かめていない（名前を含むものに広く当てている）。
 */
export const PARADIS_COMPUTER_USE_READ_ONLY_TRADING_APPS: readonly string[] = [
	'com.tradingview.tradingviewapp.desktop',
	'*tradingview*',
	'*metatrader*',
	'*thinkorswim*',
	'*interactivebrokers*',
	'*webull*',
	'*moomoo*',
	'*binance*',
	'*coinbase*',
	'*bitflyer*',
	'*coincheck*',
	'com.kraken.desktop',
	'com.ledger.live',
	'io.trezor.TrezorSuite',
	'io.exodus.exodus',
	'*marketspeed*',
	'*hypersbi*',
];

/**
 * そのアプリを読むだけにするなら理由を返す。設定で操作を許しているかは呼び出し側が見る
 * （常に断るアプリかどうかは {@link paradisComputerUseBlockReason} が先に見る）。
 */
export function paradisComputerUseReadOnlyReason(bundleId: string): ParadisComputerUseReadOnlyReason | undefined {
	if (paradisComputerUseMatchesBundle(bundleId, PARADIS_COMPUTER_USE_READ_ONLY_REMOTE_DESKTOP_APPS)) {
		return 'remote-desktop';
	}
	if (paradisComputerUseMatchesBundle(bundleId, PARADIS_COMPUTER_USE_READ_ONLY_BROWSERS)) {
		return 'browser';
	}
	if (paradisComputerUseMatchesBundle(bundleId, PARADIS_COMPUTER_USE_READ_ONLY_TRADING_APPS)) {
		return 'trading';
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
