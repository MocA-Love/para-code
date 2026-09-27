/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知の台帳（受信箱）の契約。
//
// エージェントの完了・許可待ち・質問の通知は、ペインを持っているウィンドウの renderer が
// 1件ずつ判断して出す（paradisNotificationTrigger.contribution.ts）。ここではその判断の結果を、
// 鳴らさなかったものも含めて shared process の台帳へ1か所に集める。台帳はタイトルバーのベルと
// 受信箱、Dock の件数、メニューバーのアイコンのデータ源になる。
//
// 台帳は shared process のメモリにだけ持つ。ウィンドウを再読み込みしても残り（ペイントークンは
// 再読み込みをまたいで同じものが戻る）、アプリを終了すると消える。

import { Event } from '../../../../base/common/event.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { paradisOneLine } from '../../agentInsights/common/paradisAgentInsights.js';

export const PARADIS_NOTIFICATION_INBOX_CHANNEL = 'paradisNotificationInbox';

/** 台帳に残す件数の上限。超えたら古いものから捨てる。 */
export const PARADIS_NOTIFICATION_INBOX_LIMIT = 200;

/** OS 通知の本文に載せる、最後の発言の長さ（80 字程度）。 */
export const PARADIS_NOTIFICATION_PREVIEW_LENGTH = 80;

// ---- 設定 ------------------------------------------------------------------------------------

/** OS 通知の本文に、エージェントの最後の発言の冒頭を載せるか（既定オン。ユーザーが通知の中身を読める方を選んだ）。 */
export const PARADIS_NOTIFICATION_INCLUDE_MESSAGE_SETTING = 'paradis.notifications.osIncludeMessage';
/** タイトルバーにベル（受信箱）を出すか（既定オン）。 */
export const PARADIS_NOTIFICATION_INBOX_TITLE_BAR_SETTING = 'paradis.notifications.inbox.titleBar.enabled';
/** Dock（macOS）・ランチャー（Linux）・タスクバー（Windows）のアイコンに要対応の数を出すか（既定オン）。 */
export const PARADIS_NOTIFICATION_DOCK_BADGE_SETTING = 'paradis.notifications.dockBadge.enabled';
/** メニューバー（Windows は通知領域）に Para Code のアイコンを出すか（既定オフ。メニューバーの幅を使わない人のため）。 */
export const PARADIS_NOTIFICATION_MENU_BAR_SETTING = 'paradis.notifications.menuBarIcon.enabled';

// ---- 台帳の中身 ------------------------------------------------------------------------------

/** 通知の種類。エージェントの状態（ParadisAgentStatus）のうち、通知を出すものと同じ語。 */
export type ParadisInboxKind = 'review' | 'permission' | 'question';

/**
 * 通知をどう扱ったか。
 *
 * - `notified`: OS 通知を出した
 * - `silent`: OS 通知は設定で切っていた（音・読み上げは鳴ったかもしれない）
 * - `focused`: そのスペースを見ていたので鳴らさなかった
 * - `doNotDisturb`: おやすみモード中だったので鳴らさなかった
 */
export type ParadisInboxDelivery = 'notified' | 'silent' | 'focused' | 'doNotDisturb';

/** renderer が台帳へ書く1件。id・時刻・既読は台帳が決める（`read` だけは初期値を渡せる）。 */
export interface IParadisInboxRecordInput {
	readonly kind: ParadisInboxKind;
	/**
	 * ペインを指す鍵。ペイントークンそのものではなく、そのハッシュ（{@link paradisInboxPaneKey}）。
	 * 台帳は全ウィンドウへ配られるので、エージェントの認証にも使うトークンを渡さない。
	 */
	readonly paneKey: string;
	/** 記録した時点のターミナルのインスタンス ID（そのウィンドウの中でだけ意味がある）。 */
	readonly instanceId: number;
	/** ペインを持っているウィンドウ（INativeHostService.windowId）。 */
	readonly windowId: number;
	/** スペースの状態キー。スペースに属さないペインは undefined。 */
	readonly stateKey?: string;
	/** スペースの表示名。 */
	readonly space: string;
	/** worktree の名前（メインのチェックアウトならブランチ名）。space と同じなら省く。 */
	readonly worktree?: string;
	/** ターミナルのタブ名。 */
	readonly tab?: string;
	/** 最後の発言、または待っている内容（1行）。 */
	readonly message?: string;
	readonly delivery: ParadisInboxDelivery;
	/** 最初から既読にするか（見ていたスペースで起きたもの）。 */
	readonly read?: boolean;
}

export interface IParadisInboxEntry extends IParadisInboxRecordInput {
	readonly id: string;
	readonly at: number;
	readonly read: boolean;
	/** ペインがいまもどれかのウィンドウに開いているか。閉じたペインは件数に数えない。 */
	readonly live: boolean;
}

export interface IParadisInboxSnapshot {
	/** 新しい順。 */
	readonly entries: readonly IParadisInboxEntry[];
	/** 未読の通知があり、いまも開いているペインの数（通知の件数ではなく「対応が必要なペインの数」で数える）。 */
	readonly attentionPaneCount: number;
	/** 未読の通知の件数（閉じたペインの分も含む）。 */
	readonly unreadCount: number;
	/** 台帳が変わるたびに増える番号。遅れて届いた古いスナップショットを見分けるのに使う。 */
	readonly revision: number;
}

export const EMPTY_PARADIS_INBOX_SNAPSHOT: IParadisInboxSnapshot = Object.freeze({ entries: [], attentionPaneCount: 0, unreadCount: 0, revision: 0 });

/** ペイントークンから台帳の鍵を作る（SHA-1。トークンは十分に長い乱数なので元には戻せない）。 */
export function paradisInboxPaneKey(token: string): string {
	const sha = new StringSHA1();
	sha.update(`paradis-inbox:${token}`);
	return sha.digest();
}

/** ペインの今の状態（台帳へ知らせる用）。`undefined` は待機中（通知の対象外の状態）。 */
export interface IParadisInboxPaneStatus {
	readonly paneKey: string;
	readonly status: 'working' | ParadisInboxKind | undefined;
}

/** 受信箱の行（またはメニューバーの項目）を押して、そのペインへ移動してほしいという依頼。 */
export interface IParadisInboxRevealRequest {
	readonly entryId: string;
	readonly paneKey: string;
	readonly windowId: number;
	readonly stateKey?: string;
}

// ---- renderer 側のサービス ---------------------------------------------------------------------

export const IParadisNotificationInboxService = createDecorator<IParadisNotificationInboxService>('paradisNotificationInboxService');

/**
 * 台帳の renderer 側の窓口。書き込みは shared process へ送り、読み取りは手元に写した最新の
 * スナップショットを返す（台帳が変わるたびに shared process から届く）。
 */
export interface IParadisNotificationInboxService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly snapshot: IParadisInboxSnapshot;
	/** どこかのウィンドウ（メニューバーのアイコンを含む）が、あるペインへの移動を頼んだ。 */
	readonly onDidRequestReveal: Event<IParadisInboxRevealRequest>;
	/** メニューバーのアイコンが、このウィンドウで受信箱を開くよう頼んだ。 */
	readonly onDidRequestOpenInbox: Event<void>;

	record(input: IParadisInboxRecordInput): Promise<void>;
	markRead(ids: readonly string[]): Promise<void>;
	markUnread(id: string): Promise<void>;
	markAllRead(): Promise<void>;
	markPanesRead(paneKeys: readonly string[]): Promise<void>;
	remove(id: string): Promise<void>;
	/** 行を押したときの移動。ペインを持っているウィンドウが受け取って移動する。 */
	reveal(entry: IParadisInboxEntry): Promise<void>;
	/** 受信箱を開くよう、このウィンドウの UI（ベル）へ伝える。 */
	requestOpenInbox(): void;
	/** このウィンドウのペインの今の状態を知らせる（状態が通知の種類から変わった未読を既読にする）。 */
	syncPaneStatuses(statuses: readonly IParadisInboxPaneStatus[]): Promise<void>;
	/** このウィンドウがいま開いているペインを知らせる（件数は開いているペインだけを数える）。 */
	setLivePanes(paneKeys: readonly string[]): Promise<void>;
}

// ---- 表示の補助 --------------------------------------------------------------------------------

export function paradisInboxKindLabel(kind: ParadisInboxKind): string {
	switch (kind) {
		case 'review': return localize('paradis.inbox.kind.review', "完了");
		case 'permission': return localize('paradis.inbox.kind.permission', "許可待ち");
		case 'question': return localize('paradis.inbox.kind.question', "質問");
	}
}

/** 行の見出し（「スペース ／ タブ名」）。 */
export function paradisInboxEntryLocation(entry: Pick<IParadisInboxRecordInput, 'space' | 'worktree' | 'tab'>): string {
	const space = entry.worktree && entry.worktree !== entry.space ? `${entry.space} (${entry.worktree})` : entry.space;
	// allow-any-unicode-next-line
	return entry.tab ? `${space} ／ ${entry.tab}` : space;
}

/** 発言を OS 通知の本文用に1行・80字程度へ縮める。空なら undefined。 */
export function paradisNotificationPreview(text: string | undefined, max = PARADIS_NOTIFICATION_PREVIEW_LENGTH): string | undefined {
	if (text === undefined) {
		return undefined;
	}
	const preview = paradisOneLine(text, max);
	return preview.length > 0 ? preview : undefined;
}

/**
 * OS 通知の本文。従来の本文（スペース名、worktree があれば括弧書き）に、発言の冒頭を
 * 「スペース: 発言」の形で続ける（例「main: ビルドが通るように…」）。
 */
export function paradisNotificationBody(location: string | undefined, preview: string | undefined): string | undefined {
	if (!preview) {
		return location;
	}
	return location ? `${location}: ${preview}` : preview;
}

/** 要対応のペインのうち、`paneKeys`（あるウィンドウが持っているペインの鍵）に入るものの数。 */
export function paradisInboxAttentionPaneCount(snapshot: Pick<IParadisInboxSnapshot, 'entries'>, paneKeys?: ReadonlySet<string>): number {
	const panes = new Set<string>();
	for (const entry of snapshot.entries) {
		if (!entry.read && entry.live && (paneKeys === undefined || paneKeys.has(entry.paneKey))) {
			panes.add(entry.paneKey);
		}
	}
	return panes.size;
}

/**
 * 要対応の一覧（ペインごとに最新の未読1件、新しい順）。メニューバーのメニューに使う。
 */
export function paradisInboxAttentionEntries(snapshot: IParadisInboxSnapshot, limit: number): IParadisInboxEntry[] {
	const seen = new Set<string>();
	const result: IParadisInboxEntry[] = [];
	for (const entry of snapshot.entries) {
		if (entry.read || !entry.live || seen.has(entry.paneKey)) {
			continue;
		}
		seen.add(entry.paneKey);
		result.push(entry);
		if (result.length >= limit) {
			break;
		}
	}
	return result;
}

// ---- 通知に載せる文の選び方と、秘密らしい値の伏せ字 -------------------------------------------------

/** 伏せた部分の印。 */
const REDACTED = '***';

/**
 * 値として伏せる文字。ASCII の記号・英数字だけに限る（引用符と `&;|` は区切りとして除く）。
 * 日本語の文は空白で区切られないので、「次の空白まで」を値にすると文の残りまで消えてしまう。
 */
const VALUE = `[!#-%(-:<-{}~]+`;
const QUOTED_OR_VALUE = `("[^"]*"|'[^']*'|${VALUE})`;

/** 既知の形のトークンの接頭辞（切り詰めの境目で断片だけ残ったものを伏せるのにも使う）。 */
const KNOWN_TOKEN_PREFIXES = `(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|sk-|sk_|pk_|rk_|AKIA|ASIA|xox[abprs]-|AIza|npm_|glpat-|hf_|eyJ)`;

const SECRET_PATTERNS: readonly [RegExp, string][] = [
	// URL に埋め込んだ認証情報（https://user:pass@host）と、キーだけのもの（Sentry の DSN など）
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
	[/\b(https?:\/\/)[0-9a-f]{16,}@/gi, `$1${REDACTED}@`],
	// Webhook の URL（パスそのものが秘密）
	[/\b(https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9/]+/g, `$1${REDACTED}`],
	[/\b(https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/)[A-Za-z0-9/_-]+/g, `$1${REDACTED}`],
	// PEM の秘密鍵（1行に畳まれて届くので、ヘッダーより後ろを全部伏せる）
	[/(-----BEGIN [A-Z ]*PRIVATE KEY-----).*/g, `$1 ${REDACTED}`],
	// Authorization ヘッダー・Bearer / Basic の値
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
	// 大文字の環境変数（STRIPE_SECRET_KEY=... / OPENAI_KEY=... / SENTRY_DSN=...）
	[new RegExp(`\\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASS(?:WORD)?|PWD|DSN|CREDENTIALS?))(\\s*=\\s*)${QUOTED_OR_VALUE}`, 'g'), `$1$2${REDACTED}`],
	// api_key: ... / password=... / secret_key_base: ... など（右辺だけ伏せる）
	[new RegExp(`\\b([A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|secret|token|passw(?:or)?d|pwd|credentials?|authorization)[A-Za-z0-9_]*)(["']?\\s*[:=]\\s*)${QUOTED_OR_VALUE}`, 'gi'), `$1$2${REDACTED}`],
	// 空白区切りで値を渡す設定（aws configure set aws_secret_access_key <値>）
	[new RegExp(`\\b([a-z0-9]+_(?:secret_access_key|session_token|secret_key|api_key|access_token))(\\s+)${QUOTED_OR_VALUE}`, 'gi'), `$1$2${REDACTED}`],
	// --password xxx / --api-key=xxx などのコマンドライン引数（行頭か空白の直後のものだけ）
	[new RegExp(`(^|\\s)(--?(?:[a-z0-9-]*-)?(?:api-key|access-key|secret-key|secret|token|password|passwd|pass)(?:=|\\s+))${QUOTED_OR_VALUE}`, 'gi'), `$1$2${REDACTED}`],
	// mysql -phunter2（値を空けずに付ける形）と docker login -p hunter2
	[new RegExp(`\\b((?:mysql|mysqldump|mariadb|mysqladmin)\\b[^|;&]*?\\s-p)${VALUE}`, 'g'), `$1${REDACTED}`],
	[new RegExp(`\\b(login\\b[^|;&]*?\\s-p\\s+)${QUOTED_OR_VALUE}`, 'g'), `$1${REDACTED}`],
	// curl -u user:pass
	[new RegExp(`(^|\\s)(-u|--user)(\\s+|=)([^\\s:"']+):${VALUE}`, 'g'), `$1$2$3$4:${REDACTED}`],
	// よく知られた形のトークン
	[/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, REDACTED],
	[/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, REDACTED],
	[/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}/g, REDACTED],
	[/\bgithub_pat_[A-Za-z0-9_]{12,}/g, REDACTED],
	[/\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g, REDACTED],
	[/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, REDACTED],
	[/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
	[/\bnpm_[A-Za-z0-9]{20,}/g, REDACTED],
	[/\bglpat-[A-Za-z0-9_-]{16,}/g, REDACTED],
	[/\bhf_[A-Za-z0-9]{20,}/g, REDACTED],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
	// 中継が長い文を切り詰めたとき（末尾が省略記号）、境目で既知の接頭辞の断片だけが残っていれば伏せる
	[new RegExp(`\\b${KNOWN_TOKEN_PREFIXES}[A-Za-z0-9_-]*(?=\\u2026$)`, 'g'), REDACTED],
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]*(?=…$)/gi, `$1 ${REDACTED}`],
];

/**
 * 通知や受信箱に出す文から、秘密らしい値を伏せる。通知はロック画面・通知センターの履歴・
 * 画面共有に出るので、エージェントのコマンドに含まれるトークンやパスワードをそのまま載せない。
 * 見落としはありうる（形の決まっていない秘密は拾えない）ので、確実に隠したい人のために
 * 設定で本文そのものを切れるようにしてある。
 */
export function paradisRedactSecrets(text: string): string {
	let result = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		result = result.replace(pattern, replacement);
	}
	return result;
}

/**
 * 許可待ちの要約を「ツール名: 伏せ字を入れた要約」に整える。
 * 中継の要約（paradisSummarizePermissionInput）は Bash のときだけツール名を付けないので補う。
 */
export function paradisPermissionPreview(text: string): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	const prefixed = /^(?<tool>[A-Za-z][\w.-]*): (?<detail>.*)$/.exec(oneLine);
	if (prefixed?.groups) {
		return `${prefixed.groups.tool}: ${paradisRedactSecrets(prefixed.groups.detail)}`;
	}
	if (/^[A-Za-z][\w.-]*$/.test(oneLine)) {
		return oneLine; // ツール名だけ
	}
	return `Bash: ${paradisRedactSecrets(oneLine)}`;
}

/** 中継から読んだペインの様子のうち、通知に使う部分。 */
export interface IParadisNotificationMessageSource {
	readonly lastMessage?: { readonly text: string; readonly at?: number };
	readonly interaction?: { readonly text: string; readonly at: number };
}

/**
 * 通知に載せる文を選ぶ。完了は最後の発言、許可待ち・質問は待っている内容（無ければ最後の発言）。
 *
 * 完了の発言は、そのターンの作業が始まった時刻（`since`）以降のものだけを「新しい」とする。
 * 会話ログの読み取りが遅れていると前のターンの発言が返るので、`fresh: false` なら取り直す。
 * 返す文は伏せ字済み。
 */
export function paradisPickNotificationMessage(source: IParadisNotificationMessageSource | undefined, kind: ParadisInboxKind, since: number): { readonly text?: string; readonly fresh: boolean } {
	if (kind !== 'review' && source?.interaction !== undefined) {
		const text = kind === 'permission' ? paradisPermissionPreview(source.interaction.text) : paradisRedactSecrets(source.interaction.text);
		return { text, fresh: true };
	}
	const message = source?.lastMessage;
	if (message === undefined) {
		// セッションが確定していないペインは待っても出てこない。確定していれば、まだ読めていないだけ。
		return { fresh: kind !== 'review' || source === undefined };
	}
	const fresh = kind !== 'review' || message.at === undefined || message.at >= since;
	return { text: fresh ? paradisRedactSecrets(message.text) : undefined, fresh };
}
