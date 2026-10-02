// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { NotifyPayload } from '@para/protocol';

/**
 * アプリの外から来る出来事（承認・質問の到着、接続の結果と切断）で、どの触覚を鳴らすかを決める純関数。
 * 鳴らす本体は `haptics.ts`、呼ぶのは `appState.ts`。
 */

/**
 * 前面にいる間に承認・質問が届いたとき、触覚（`knock`）で知らせるかを決める。
 * 3 秒以内に続けて届いたものを 1 回にまとめるのは `haptics.ts` の間引き（`knock` の 3 秒）。
 *
 * 鳴らさないのは次のとき:
 * - 質問・承認以外（完了・エラー・切断）
 * - アプリが前面でない（背面はプッシュの担当。inactive も通知センターを引き下げているだけなので鳴らさない）
 * - 出来事から `KNOCK_MAX_AGE_MS` より経っている（繋がり直したときに流れてくる取り置きの通知）
 * - PC が「鳴らす必要は無い」と言った（`quiet: 'muted'`。種別オフ・PC 操作中）、または旧 PC 向けの設定でオフ
 * - 同じ出来事のバナーを OS に出させる（バナーの音・振動と二重になるため）。アプリが出すときと、PC がプッシュを
 *   送っていて前面でも OS が出すとき（`quiet: 'pushed'` かつプッシュを受け取れる端末）
 *
 * つまり主に「そのエージェントの画面を開いていて、バナーが抑えられた」ときに鳴る。カードが見えていても鳴らす。
 */
/** これより古い通知では knock を鳴らさない。 */
export const KNOCK_MAX_AGE_MS = 60_000;

export function shouldKnockOnNotify(payload: Pick<NotifyPayload, 'kind' | 'quiet' | 'at'>, ctx: {
	readonly appState: string;
	readonly now: number;
	readonly questionsEnabled: boolean;
	/** この通知でアプリがバナーを出すか（`shouldPresentNotifyBanner` の結果）。 */
	readonly bannerPresented: boolean;
	readonly pushRegistered: boolean | undefined;
}): boolean {
	if (payload.kind !== 'agent-question' || ctx.appState !== 'active') {
		return false;
	}
	// 繋がり直した直後に PC が流す取り置きの通知は、いま届いた出来事ではないので鳴らさない
	if (ctx.now - payload.at > KNOCK_MAX_AGE_MS) {
		return false;
	}
	if (payload.quiet === 'muted' || !ctx.questionsEnabled) {
		return false;
	}
	if (ctx.bannerPresented) {
		return false;
	}
	if (payload.quiet === 'pushed' && ctx.pushRegistered !== false) {
		return false;
	}
	return true;
}

/** 「接続」を押してから結果（つながった・拒否された）を触覚で返すまでの待ち時間。これを過ぎたら返さない。 */
export const CONNECT_RESULT_WINDOW_MS = 30_000;

/**
 * いま見ている PC の接続の変化で鳴らす触覚。
 *
 * - 利用者が「接続」を押した後（`userRequested`）につながった → `success`、ペアリングを拒否された → `error`
 * - つながっていたのに、手動の切断ではなく切れた → `warning`（間引きは呼び出し側が `DISCONNECT_WARNING` で 30 秒）
 * - 自動の再接続でつながったときは鳴らさない
 */
export function connectionHaptic(change: {
	readonly wasOnline: boolean;
	readonly online: boolean;
	readonly wasRejected: boolean;
	readonly rejected: boolean;
	readonly manualOffline: boolean;
	readonly userRequested: boolean;
}): 'success' | 'error' | 'warning' | undefined {
	if (change.userRequested && !change.wasOnline && change.online) {
		return 'success';
	}
	if (change.userRequested && !change.wasRejected && change.rejected) {
		return 'error';
	}
	if (change.wasOnline && !change.online && !change.manualOffline) {
		return 'warning';
	}
	return undefined;
}
