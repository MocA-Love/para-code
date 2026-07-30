// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 受け取った通知でバナー（OS通知）を出すかどうかを決める。通知一覧へ入れるかどうかは
 * ここでは扱わない（届いた通知は種別・設定にかかわらず必ず一覧へ入る）。
 *
 * 役割分担: PC側（`paradisNotifyDelivery.ts`）が「この通知はユーザーの注意を引くべきか」を
 * 決め、鳴らす必要が無いものには `quiet` を立ててくる。こちらはPCが知り得ない
 * 「いまの画面状況で鳴らす意味があるか」だけを見る。
 */

import type { NotifyPayload } from '@para/protocol';
import type { MobileAppState } from './appLifecycle.js';

/**
 * これより古い通知はバナーを出さない（一覧には入る）。
 *
 * 重複防止はPC側の `quiet` が担うので、この閾値の役目は「本当に大昔の通知が
 * いまバナーとして降ってくる」のを止めるだけの緩い歯止め。以前は60秒だったが、
 * それは重複防止を兼ねていたための短さで、PCとスマホの時計が数分ずれているだけで
 * 新しい通知まで落ちる状態だった。プッシュ側のTTL（4時間）より十分短く、
 * 時計ずれには十分寛容な30分に置く。
 */
export const NOTIFY_BANNER_MAX_AGE_MS = 30 * 60_000;

export interface NotifyBannerContext {
	readonly appState: MobileAppState;
	readonly prefs: { readonly agentDone: boolean; readonly agentQuestion: boolean };
	/** いま開いているエージェント画面のターミナルキー。開いていなければ `undefined`。 */
	readonly viewingTerminalKey: string | undefined;
	/** この端末がAPNsプッシュを受け取れるか（`undefined` は未判定）。 */
	readonly pushRegistered: boolean | undefined;
	readonly now: number;
}

export function shouldPresentNotifyBanner(payload: NotifyPayload, ctx: NotifyBannerContext): boolean {
	// 鳴らす必要が無いとPCが判断した（種別オフ、PC操作中）。これは必ず従う。
	if (payload.quiet === 'muted') {
		return false;
	}
	// PCはプッシュを送ったので重ねるな、と言っている。ただしPCはプッシュが実際に届いたかを
	// 知らない。この端末がプッシュを受け取れないと分かっているなら、従うと誰も気づけないので
	// 自分で鳴らす（未判定のうちは二重に鳴らさない側へ倒す）。
	if (payload.quiet === 'pushed' && ctx.pushRegistered !== false) {
		return false;
	}
	// `quiet` を知らない旧PCからのフレーム向けの保険。新しいPCならここへ来る前に quiet が立つ。
	if ((payload.kind === 'agent-done' && !ctx.prefs.agentDone) || (payload.kind === 'agent-question' && !ctx.prefs.agentQuestion)) {
		return false;
	}
	// バックグラウンド中はプッシュの担当。ここで出すとアプリ復帰時に鳴り直すことになる。
	// inactive（通知センターを引き下げた等の短い中断）はソケットを維持するので出す。
	if (ctx.appState !== 'active' && ctx.appState !== 'inactive') {
		return false;
	}
	// そのエージェントの画面を開いている最中に、同じ内容をバナーで被せない。
	// 抑制するのは作業の進捗（完了・質問）だけ: エラーや切断は画面を見ているかどうかに
	// 関係なく知らせるべきなので、PC側の線引き（paradisNotifyDelivery.ts）と揃える。
	const screenSuppressible = payload.kind === 'agent-done' || payload.kind === 'agent-question';
	if (screenSuppressible && ctx.viewingTerminalKey !== undefined && ctx.viewingTerminalKey === payload.terminalKey) {
		return false;
	}
	return ctx.now - payload.at <= NOTIFY_BANNER_MAX_AGE_MS;
}
