/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot 同士の伝言を、宛先の会話のペインを持つウィンドウで届ける手順（窓口 `paradisBotGroupsWindow` の `deliver` が呼ぶ）。
// サービスに触れない形にして、断りの順・順番待ち・読み込み待ちを単体テストで固定する。

import { SequencerByKey } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { IParadisAgentChatDeliverOptions, ParadisAgentChatSendOutcome } from '../../agentChat/browser/paradisAgentChatInput.js';
import { IParadisBotGroup, ParadisBotGroupRelayLimiter, paradisBotGroupDeliverRefusal, paradisBotGroupDeliverRefusalMessage, paradisBotGroupNeutralizeCommand } from '../common/paradisBotGroups.js';
import { ParadisBotGroupDeliverResult } from '../common/paradisBotMessages.js';

/**
 * 台帳をまだ読み込んでいないときに待つ上限（ミリ秒）。道具の側の呼び出しの時間切れ（時間切れは「届いたか分からない」に
 * なる）より十分短くする。
 */
export const PARADIS_BOT_GROUP_DELIVER_LOAD_WAIT = 3000;

/** 読み込みの番号（取得の前は 0）と変わった知らせを持つ台帳。 */
interface IParadisLoadable {
	readonly snapshot: { readonly revision: number };
	readonly onDidChange: Event<void>;
}

/** 台帳が一度でも読み込まれるまで待つ。上限までに読めなければ false。 */
export async function paradisWaitForLoaded(services: readonly IParadisLoadable[], timeout: number): Promise<boolean> {
	const loaded = () => services.every(service => service.snapshot.revision > 0);
	if (loaded()) {
		return true;
	}
	const store = new DisposableStore();
	try {
		return await new Promise<boolean>(resolve => {
			const timer = setTimeout(() => resolve(loaded()), timeout);
			store.add({ dispose: () => clearTimeout(timer) });
			for (const service of services) {
				store.add(service.onDidChange(() => {
					if (loaded()) {
						resolve(true);
					}
				}));
			}
		});
	} finally {
		store.dispose();
	}
}

export interface IParadisBotGroupDeliverDependencies {
	/** 台帳（Bot とグループ）を読み込むまで待つ。読めなければ false。 */
	waitForLoaded(): Promise<boolean>;
	groups(): readonly Pick<IParadisBotGroup, 'members'>[];
	bot(botId: string): { readonly paused: boolean; readonly activity: 'stopped' | 'idle' | 'working' | 'patrolling' } | undefined;
	/** ペイントークンのハッシュから Bot の id（ハッシュはそのまま照らす）。 */
	botIdByPaneHash(paneHash: string): Promise<string | undefined>;
	/** 宛先の会話のペインがこのウィンドウにあるか。 */
	whereIs(botId: string): Promise<'here' | 'elsewhere' | 'none'>;
	/** 宛先の会話のペインへ送る（チャット表示と同じ確認に `options` を足す。入力欄の履歴には残さない）。 */
	send(botId: string, text: string, options: IParadisAgentChatDeliverOptions): Promise<ParadisAgentChatSendOutcome>;
	readonly limiter: ParadisBotGroupRelayLimiter;
	now(): number;
}

/** 打ち込みで安全に届けられない宛先への断り（送り直しても通らない）。 */
export const PARADIS_BOT_GROUP_UNSAFE_REASON = 'Para Code cannot deliver bot messages safely to that bot\'s agent (it needs Claude Code with Para Code\'s input mod), so do not send it again';

/**
 * 伝言を届ける。順は「台帳の読み込み → 送り手と宛先が同じグループ → 宛先がこのウィンドウで動いている → 回数の上限 →
 * 送る」。届けるのは打ち込みで安全に届けられる宛先だけ（作業中の発言を次の番まで待たせられ、入力欄の書きかけを読める:
 * 今は入力欄の mod のある Claude Code）。宛先が作業中なら `queued`（今のターンを止めない）。ほかのエージェント・mod の
 * 無い Claude Code・入力欄に利用者の書きかけがある・許可や質問の画面が出ているときは、届ける口がペインへ何も書かずに
 * 断るので `refused` にして回数を戻す。文を書いたかもしれない失敗（貼り付けた後に Enter を送れなかった等）は `unknown`
 * （送り直すと重なる）。同じ宛先へ並んで来た伝言は {@link ParadisBotGroupDeliverQueue} で 1 つずつにする。
 */
export async function paradisBotGroupDeliver(deps: IParadisBotGroupDeliverDependencies, callerHash: string, to: string, text: string): Promise<ParadisBotGroupDeliverResult> {
	if (!(await deps.waitForLoaded())) {
		return { kind: 'refused', reason: 'Para Code in that bot\'s window has not finished loading the bot groups yet' };
	}
	const from = await deps.botIdByPaneHash(callerHash);
	const group = deps.groups().find(candidate => from !== undefined && candidate.members.includes(from) && candidate.members.includes(to));
	const target = deps.bot(to);
	const activity = target === undefined ? undefined : target.paused ? 'stopped' : target.activity;
	const refusal = paradisBotGroupDeliverRefusal({
		group,
		from,
		to,
		toActivity: activity,
		toRunningHere: await deps.whereIs(to) !== 'none',
		takeRate: () => deps.limiter.take(to, deps.now()),
	});
	if (refusal !== undefined) {
		return { kind: 'refused', reason: paradisBotGroupDeliverRefusalMessage(refusal) };
	}
	// 先頭の / と ! はコマンド・シェルとして動くので崩してから届ける（利用者が部屋から送る文はそのまま）
	const working = activity === 'working';
	const outcome = await deps.send(to, paradisBotGroupNeutralizeCommand(text), { safeOnly: true });
	switch (outcome.kind) {
		case 'sent':
			return working ? { kind: 'queued' } : { kind: 'delivered' };
		case 'refused':
			// ペインへ何も書いていないので回数を戻す。理由は英文だけ（エージェントが読む。画面向けの文は入れない）
			deps.limiter.refund(to);
			return {
				kind: 'refused',
				reason: outcome.code === 'unsafe' ? PARADIS_BOT_GROUP_UNSAFE_REASON
					: outcome.code === 'draft' ? 'its owner is typing in that bot\'s input'
						: 'that bot cannot take a message now, for example while a question or permission prompt is open',
			};
		case 'unknown':
			return { kind: 'unknown', reason: 'Para Code may have typed the message into that bot\'s input without sending it' };
	}
}

/** 同じ宛先への伝言を 1 つずつ届ける（並んだ 2 通が入力欄で 1 つの発言にまとまらないように）。 */
export class ParadisBotGroupDeliverQueue {

	private readonly sequencer = new SequencerByKey<string>();

	constructor(private readonly deps: IParadisBotGroupDeliverDependencies) { }

	deliver(callerHash: string, to: string, text: string): Promise<ParadisBotGroupDeliverResult> {
		return this.sequencer.queue(to, () => paradisBotGroupDeliver(this.deps, callerHash, to, text));
	}
}
