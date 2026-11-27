/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot 同士の伝言を、宛先の会話のペインを持つウィンドウで受け付ける手順（窓口 `paradisBotGroupsWindow` の `deliver` が呼ぶ）。
// サービスに触れない形にして、断りの順・読み込み待ちを単体テストで固定する。

import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IParadisBotGroup, paradisBotGroupDeliverRefusal, paradisBotGroupDeliverRefusalMessage } from '../common/paradisBotGroups.js';
import { ParadisBotGroupDeliverResult } from '../common/paradisBotMessages.js';

/** 台帳をまだ読み込んでいないときに待つ上限（ミリ秒）。道具の側の呼び出しの時間切れより十分短くする。 */
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
	/** ペイントークンのハッシュから Bot の id（ハッシュはそのまま照らす）。 */
	botIdByPaneHash(paneHash: string): Promise<string | undefined>;
}

/**
 * 伝言を受け付ける（受け箱の方式）。宛先のペインには何も打ち込まない。伝言は道具の側がグループの台帳の記録として
 * 残し、宛先の Bot の受け箱（未読の伝言）に入る。宛先は道具 `bot_inbox` で読む。ここでは台帳を読み込んでから、送り手と
 * 宛先が同じグループのメンバーか（自分宛てでないか）だけを確かめ、通れば `queued`（受け箱に入れた）を返す。
 * 宛先が動いていない・作業中・一時停止中でも受け箱には入る。
 */
export async function paradisBotGroupDeliver(deps: IParadisBotGroupDeliverDependencies, callerHash: string, to: string): Promise<ParadisBotGroupDeliverResult> {
	if (!(await deps.waitForLoaded())) {
		return { kind: 'refused', reason: 'Para Code in that bot\'s window has not finished loading the bot groups yet' };
	}
	const from = await deps.botIdByPaneHash(callerHash);
	const group = deps.groups().find(candidate => from !== undefined && candidate.members.includes(from) && candidate.members.includes(to));
	const refusal = paradisBotGroupDeliverRefusal({ group, from, to });
	return refusal !== undefined ? { kind: 'refused', reason: paradisBotGroupDeliverRefusalMessage(refusal) } : { kind: 'queued' };
}
