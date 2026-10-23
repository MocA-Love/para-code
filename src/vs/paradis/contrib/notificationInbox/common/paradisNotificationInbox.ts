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
import { paradisRedactSecrets } from '../../../common/paradisSecretRedaction.js';

// 伏せ字の規則は Sentry へ送る文と共用するので、依存の無い共通のファイルに置いてある。
export { paradisRedactSecrets };

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

/**
 * ある状態（再読み込みの前から続いているもの）の通知を、台帳にもう書いたか。そのペインのいちばん新しい記録が
 * 同じ種類で、その状態になった後に書かれた（hook が同じ状態のまま時刻を書き直すこともあるので、まだ既読に
 * なっていないものも含める）なら書き済み。台帳には鳴らさなかった通知も書くので、書き済みなら前のウィンドウが
 * 判断を済ませている。前の完了のように、別の状態へ移ったときに既読になった古い記録は数えない。
 */
export function paradisInboxHasRecorded(entries: readonly IParadisInboxEntry[], paneKey: string, kind: ParadisInboxKind, changedAt: number): boolean {
	const latest = entries.find(entry => entry.paneKey === paneKey);
	return latest !== undefined && latest.kind === kind && (latest.at >= changedAt || !latest.read);
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
	/** 台帳から今のスナップショットを取り直す（起動直後で手元の写しがまだ届いていないときに使う）。取れなければ手元の写し。 */
	getLatestSnapshot(): Promise<IParadisInboxSnapshot>;
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
