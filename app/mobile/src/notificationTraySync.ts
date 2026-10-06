// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { dismissPresentedNotifications, listPresentedNotifications, presentLocalNotification } from './platform.js';
import { selectHandledByPc, selectSameCollapse, selectSettledByState, type TrayTerminal } from './notificationTray.js';

/**
 * 通知センターの後始末を OS へ流す部分（判断は notificationTray.ts の純関数）。
 * どれも best-effort で、失敗しても通知の受け取りや画面には影響させない。
 */

/** PCが処理済みと知らせてきた通知を通知センターから消す。 */
export async function dismissTrayHandledByPc(pcId: string, handled: { readonly ids: readonly string[]; readonly tokens: readonly string[]; readonly keepPrompts?: boolean }): Promise<void> {
	const before = Date.now();
	const presented = await listPresentedNotifications();
	const stale = selectHandledByPc(presented, { pcId, ids: handled.ids, tokens: handled.tokens, before, keepPrompts: handled.keepPrompts === true });
	if (stale.length > 0) {
		await dismissPresentedNotifications(stale);
	}
}

/**
 * 突き合わせを頼んだ時刻から、さらにこれだけ前に届いた通知だけを対象にする。
 * 頼んだ直後に届く State は、PCが頼まれる少し前に作って送り出していたものかもしれない。
 * その間にエージェントの状態が変わってプッシュが先に届くと、古い State で新しい通知を消してしまう。
 */
const TRAY_STATE_MARGIN_MS = 5_000;

/**
 * いまのPCの状態で、もう待っていないエージェントの通知を消す。
 * @param requestedAt 突き合わせを頼んだ時刻（その後に届いた State が terminals）
 */
export async function reconcileTrayWithState(pcId: string, terminals: readonly TrayTerminal[], requestedAt: number): Promise<void> {
	const presented = await listPresentedNotifications();
	const stale = selectSettledByState(presented, { pcId, terminals, before: requestedAt - TRAY_STATE_MARGIN_MS });
	if (stale.length > 0) {
		await dismissPresentedNotifications(stale);
	}
}

/**
 * ローカル通知を出す。同じエージェントの前の通知（プッシュで届いたものを含む）は消して置き換える。
 */
export async function presentCollapsedNotification(title: string, subtitle: string | undefined, body: string, data: Record<string, unknown>, collapseKey: string | undefined, categoryIdentifier?: string): Promise<void> {
	if (collapseKey === undefined) {
		await presentLocalNotification(title, subtitle, body, data, undefined, categoryIdentifier);
		return;
	}
	const identifier = `para-c-${collapseKey}`;
	const previous = selectSameCollapse(await listPresentedNotifications(), collapseKey).filter(id => id !== identifier);
	if (previous.length > 0) {
		await dismissPresentedNotifications(previous);
	}
	await presentLocalNotification(title, subtitle, body, { ...data, collapse: collapseKey }, identifier, categoryIdentifier);
}

/**
 * 「前面へ戻った / 繋がり直した」ときの突き合わせを、**その後に届いたPCの状態**まで待たせる台帳。
 *
 * 手元に残っている状態は古いかもしれない（iOSはバックグラウンドでソケットを黙って殺す）。
 * 頼んだ時点の State 受信数を覚えておき、それより後の State が来たら1回だけ実行する。
 */
export class TrayReconcileRequests {
	private readonly pending = new Map<string, { readonly frames: number; readonly at: number }>();

	/**
	 * 突き合わせを頼む。既に頼んでいれば頼み直す（基準の時刻と State を両方新しくする。
	 * 時刻だけ進めると、頼み直す前に届いた古い State で新しい時刻までの通知を判断してしまう）。
	 */
	request(pcId: string, framesReceived: number, now: number): void {
		this.pending.set(pcId, { frames: framesReceived, at: now });
	}

	/**
	 * 頼んだあとに State が届いていれば、突き合わせの基準時刻（頼んだ時刻）を返して台帳から外す。
	 * まだなら undefined。
	 */
	take(pcId: string, framesReceived: number): number | undefined {
		const entry = this.pending.get(pcId);
		if (entry === undefined || framesReceived <= entry.frames) {
			return undefined;
		}
		this.pending.delete(pcId);
		return entry.at;
	}

	forget(pcId: string): void {
		this.pending.delete(pcId);
	}
}
