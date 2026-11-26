/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「どのペインがどの Bot か」の表。shared process のメモリだけに持ち、ペイントークンは保存しない。
//
// 表に書けるのは起動の経路だけにする。Bot のサービスが起動の番号（launchId）を発行し、ウィンドウが
// 起動したターミナルのペイントークンをその番号付きで報告したときだけ結び付く。発行していない番号、
// 2 回目の報告、もう別の Bot に結び付いているトークンは断る。Bot の道具（bot_item_*）は引数で Bot を
// 受けず、この表から引くので、ほかのペインのエージェントが Bot を名乗って項目を書くことはできない。

import { paradisNormalizeAgentHookEvent } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisBotPaneState, ParadisBotPanePurpose } from '../common/paradisBotsApi.js';

/** 起動の番号が有効な時間。起動に失敗して報告が来なかった番号を残さない。 */
export const PARADIS_BOT_LAUNCH_TTL_MS = 5 * 60_000;

interface IPending {
	readonly botId: string;
	readonly purpose: ParadisBotPanePurpose;
	readonly issuedAt: number;
}

interface IPane {
	readonly botId: string;
	readonly purpose: ParadisBotPanePurpose;
	working: boolean;
	lastSeenAt: number;
}

export class ParadisBotPanes {

	private readonly pending = new Map<string, IPending>();
	private readonly panes = new Map<string, IPane>();

	/** 起動の番号を控える（番号はサービスが作る）。 */
	issue(launchId: string, botId: string, purpose: ParadisBotPanePurpose, now: number): void {
		for (const [id, entry] of this.pending) {
			if (now - entry.issuedAt > PARADIS_BOT_LAUNCH_TTL_MS) {
				this.pending.delete(id);
			}
		}
		this.pending.set(launchId, { botId, purpose, issuedAt: now });
	}

	/** 起動の報告。結び付けたら Bot の id、断ったら undefined。番号は 1 回で使い切る。 */
	report(launchId: string, paneToken: string, now: number): string | undefined {
		const entry = this.pending.get(launchId);
		if (entry === undefined) {
			return undefined;
		}
		this.pending.delete(launchId);
		if (now - entry.issuedAt > PARADIS_BOT_LAUNCH_TTL_MS || paneToken.length === 0 || this.panes.has(paneToken)) {
			return undefined;
		}
		this.panes.set(paneToken, { botId: entry.botId, purpose: entry.purpose, working: false, lastSeenAt: now });
		return entry.botId;
	}

	/** 起動をやめた（失敗した）番号を捨てる。 */
	cancel(launchId: string): boolean {
		return this.pending.delete(launchId);
	}

	botOf(paneToken: string): string | undefined {
		return this.panes.get(paneToken)?.botId;
	}

	statesOf(botId: string): IParadisBotPaneState[] {
		return [...this.panes.values()].filter(pane => pane.botId === botId).map(pane => ({ purpose: pane.purpose, working: pane.working, lastSeenAt: pane.lastSeenAt }));
	}

	tokensOf(botId: string): string[] {
		return [...this.panes].filter(([, pane]) => pane.botId === botId).map(([token]) => token);
	}

	/** ペインが閉じた。結び付けがあれば Bot の id。 */
	release(paneToken: string): string | undefined {
		const botId = this.panes.get(paneToken)?.botId;
		this.panes.delete(paneToken);
		return botId;
	}

	/** Bot を消した・止めた。そのペインの結び付けと、使っていない番号を全部外す。 */
	releaseBot(botId: string): boolean {
		let changed = false;
		for (const [token, pane] of this.panes) {
			if (pane.botId === botId) {
				this.panes.delete(token);
				changed = true;
			}
		}
		for (const [id, entry] of this.pending) {
			if (entry.botId === botId) {
				this.pending.delete(id);
			}
		}
		return changed;
	}

	/**
	 * hook を 1 つ見る。Bot のペインのものなら、その Bot の id と、様子（動いている・待っている）が変わったか。
	 * hook の名前は CLI ごとに違うので、ペインの状態と同じ正規化（paradisNormalizeAgentHookEvent）を通す。
	 * 許可待ち・質問中・完了は「待っている」、知らない hook は様子を変えない。
	 */
	noteHook(paneToken: string, event: string, now: number): { readonly botId: string; readonly changed: boolean } | undefined {
		const pane = this.panes.get(paneToken);
		if (pane === undefined) {
			return undefined;
		}
		pane.lastSeenAt = now;
		const status = paradisNormalizeAgentHookEvent(event);
		const working = status === undefined ? pane.working : status === 'working';
		const changed = working !== pane.working;
		pane.working = working;
		return { botId: pane.botId, changed };
	}
}
