// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { isAgentWaiting } from './store.js';

/**
 * iOS の通知センター（ロック画面を含む）に残っている Para Code の通知の後始末。
 *
 * **どれを消すかの判断はここ1か所に置く。** OS を触る部分（一覧の取得・削除）は
 * `platform.ts` の薄い関数で、ここは純関数だけにしてテストで固定する。
 *
 * 消す根拠は2つ（W2-02。Orca の push-tray-dismissal.ts / push-dismissal-reconciliation.ts に倣う）:
 *  1. PCが「処理済み」と知らせてきた（`dismissed` の通知ID、`dismissed-token` のエージェント）
 *  2. 前面復帰・再接続のあとに届いた**いまのPCの状態**で、そのエージェントがもう待っていない
 *     （完了通知なら PC で確認済み、質問なら回答済み）
 *
 * 2 は PC に問い合わせない（PC側の変更が要らず、旧PCでも効く）。代わりに誤って消さないよう
 * 次の条件を全部満たすものだけにする:
 *  - エージェントが特定できる（エージェントトークンで一致。ターミナルキーでの一致は送信元PCが
 *    はっきりしているときだけ）。見つからないものは消さない（一覧から外れているだけかもしれない）
 *  - 突き合わせを頼んだ時刻より前に届いた通知だけ。それより後に届いた通知は、手元の状態より
 *    新しい出来事の知らせかもしれない
 */

/** 通知センターの1件（expo-notifications の Notification から必要なところだけ）。 */
export interface TrayNotification {
	readonly identifier: string;
	/** 届いた時刻（epoch ms）。 */
	readonly date: number;
	/** 通知に載せた識別子（ローカル通知の data / プッシュの userInfo）。 */
	readonly data: Readonly<Record<string, unknown>> | undefined;
}

/** 突き合わせに使うターミナル（WorkspaceState.terminals の一部）。 */
export interface TrayTerminal {
	readonly terminalKey: string;
	readonly agentToken?: string;
	readonly agentStatus?: string;
}

/**
 * expo-notifications の通知から、載せた識別子を取り出す（通知センターの後始末と、タップの遷移の両方が使う）。
 *
 * **`content.data` だけを見てはいけない。** expo の iOS 実装（NotificationRecords.swift の
 * `serializedNotificationData`）は、リモートプッシュの `content.data` に userInfo["body"] しか入れない。
 * Para Code のプッシュは暗号文 `e` だけを載せ、通知拡張（NSE）が復号して識別子を userInfo の
 * 最上位に書き足すので、`content.data` は空になる。userInfo 全体（NSE が書き換えた後のもの）は
 * `trigger.payload`（trigger.type === 'push'）にある。ローカル通知は `content.data` に入る。
 * 両方を読み、重なる項目はプッシュの userInfo を採る。
 */
export function readTrayData(request: { readonly content: { readonly data?: unknown }; readonly trigger?: unknown }): Readonly<Record<string, unknown>> | undefined {
	const data = asRecord(request.content.data);
	const trigger = request.trigger;
	const payload = trigger !== null && typeof trigger === 'object' && (trigger as { type?: unknown }).type === 'push'
		? asRecord((trigger as { payload?: unknown }).payload)
		: undefined;
	if (data === undefined || payload === undefined) {
		return payload ?? data;
	}
	return { ...data, ...payload };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** iOS は届いた時刻を秒で返す（Android はミリ秒）。ミリ秒へ揃える。 */
export function trayDateMs(date: number): number {
	return date < 100_000_000_000 ? date * 1000 : date;
}

function text(data: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
	const value = data?.[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 別のPCの通知と明示されていないか（送信元が書かれていない古い通知は「分からない」として通す）。 */
function mayBelongTo(data: Readonly<Record<string, unknown>> | undefined, pcId: string): boolean {
	const owner = text(data, 'pcId');
	return owner === undefined || owner === pcId;
}

/** PCが処理済みと知らせてきた通知（通知ID、またはエージェントトークンで一致）。 */
export function selectHandledByPc(presented: readonly TrayNotification[], handled: { readonly pcId: string; readonly ids: readonly string[]; readonly tokens: readonly string[]; readonly before: number }): string[] {
	const ids = new Set(handled.ids);
	const tokens = new Set(handled.tokens);
	return presented
		.filter(notification => notification.date <= handled.before && mayBelongTo(notification.data, handled.pcId))
		.filter(notification => {
			const notifyId = text(notification.data, 'notifyId');
			const agentToken = text(notification.data, 'agentToken');
			return (notifyId !== undefined && ids.has(notifyId)) || (agentToken !== undefined && tokens.has(agentToken));
		})
		.map(notification => notification.identifier);
}

/** いまのPCの状態から見て、もう用の済んだ通知。 */
export function selectSettledByState(presented: readonly TrayNotification[], snapshot: { readonly pcId: string; readonly terminals: readonly TrayTerminal[]; readonly before: number }): string[] {
	const byToken = new Map<string, TrayTerminal>();
	const byKey = new Map<string, TrayTerminal>();
	for (const terminal of snapshot.terminals) {
		if (terminal.agentToken !== undefined) {
			byToken.set(terminal.agentToken, terminal);
		}
		byKey.set(terminal.terminalKey, terminal);
	}
	return presented
		.filter(notification => {
			if (notification.date >= snapshot.before || !mayBelongTo(notification.data, snapshot.pcId)) {
				return false;
			}
			const kind = text(notification.data, 'kind');
			if (kind !== 'agent-done' && kind !== 'agent-question') {
				return false;
			}
			const agentToken = text(notification.data, 'agentToken');
			const terminalKey = text(notification.data, 'terminalKey');
			// エージェントトークンはペインごとの乱数なのでPCをまたいで重ならない。ターミナルキーは
			// 同じ構成の2台で重なりうるので、送信元が書かれているときだけ使う。
			const terminal = agentToken !== undefined
				? byToken.get(agentToken)
				: terminalKey !== undefined && text(notification.data, 'pcId') === snapshot.pcId ? byKey.get(terminalKey) : undefined;
			if (terminal === undefined) {
				return false;
			}
			return kind === 'agent-done' ? terminal.agentStatus !== 'review' : !isAgentWaiting(terminal.agentStatus);
		})
		.map(notification => notification.identifier);
}

/**
 * 同じエージェントの通知を1件に置き換えるための鍵（W2-08）。作業中→質問→完了が積み上がらない。
 *
 * **通知拡張（NSE。`native/NotifyExtension/NotificationService.swift` の collapseKey）と同じ規則。
 * 変えるときは両方直すこと。** 端末の中だけで使い、リレーやAPNsへは出さない（エージェント
 * トークンはPCのMCP接続に使う値なので、そのままでもハッシュでも外へ出さない）。
 */
export function notifyCollapseKey(pcId: string, agentToken: string | undefined, terminalKey: string | undefined): string | undefined {
	const subject = agentToken !== undefined && agentToken.length > 0 ? `a:${agentToken}`
		: terminalKey !== undefined && terminalKey.length > 0 ? `t:${terminalKey}` : undefined;
	if (subject === undefined) {
		return undefined;
	}
	return hashKey(`para.notify.collapse\n${pcId}\n${subject}`);
}

/** 置き換え対象（同じ鍵を持つ、いま通知センターにあるもの）。 */
export function selectSameCollapse(presented: readonly TrayNotification[], collapseKey: string): string[] {
	return presented.filter(notification => text(notification.data, 'collapse') === collapseKey).map(notification => notification.identifier);
}

function hashKey(input: string): string {
	return bytesToHex(sha256(new TextEncoder().encode(input))).slice(0, 32);
}
