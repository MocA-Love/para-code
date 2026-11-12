/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントのカーソルの持ち主（ペイン × タブ）ごとの名前と色を決める台帳（shared process）。
// q.html Q272〜Q274 A・Q636 A、agent-cursor-after-mock.html の「名前の規則」。
//
// - 名前は LLM が `set_cursor_label`（または `open_browser_tab`・`select_browser_tab` の `label`）で
//   決めたもの。決めていなければ CLI の名前（Claude・Codex）。サブエージェントの種類は推測になるので使わない
// - 色は同じページの持ち主ごとに必ず変える。1 つ目は CLI の色、2 つ目以降は紫・桃・青の順
// - 番号はページに来たときに、同じ名前の持ち主の中で空いている一番小さいものを取る（1 は番号を出さない、
//   2 から「Claude 2」）。番号は持ち主に固定し、先の持ち主が休んで外れても、名前を変えても保つ。
//   外れた持ち主の番号は空けておき、後から来た持ち主が使い回す。ただし名前を変えた結果、ほかの持ち主と
//   表示まで同じになったときだけ、名前を変えた方が新しい名前の中で空いている番号を取り直す
// - 保存はしない。名前は持ち主（ペイン × ビュー）の鍵で覚え、上限（{@link MAX_LABELS}）を越えたら古いものから捨てる。
//   共有をやめたタブの名前は、その鍵で入力が来なくなるので使われなくなる

import { createHash } from 'crypto';
import { localize } from '../../../../nls.js';
import { IParadisCursorOwner } from '../common/paradisCursorOverlay.js';
import { PARADIS_CURSOR_LABEL_RATE_LIMIT, PARADIS_CURSOR_LABEL_RATE_WINDOW_MS, ParadisCursorLabelResult, paradisNormalizeCursorLabel } from '../common/paradisCursorLabel.js';

/** ペインで動いている CLI。分からなければ undefined（名前は「エージェント」相当の既定）。 */
export type ParadisCursorCli = 'claude' | 'codex' | 'opencode';

const CLI_NAME: Readonly<Record<ParadisCursorCli, string>> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
const CLI_MARK: Readonly<Record<ParadisCursorCli, string>> = { claude: 'C', codex: 'X', opencode: 'O' };
const CLI_COLOR: Readonly<Record<ParadisCursorCli, string>> = { claude: '#d97757', codex: '#10a37f', opencode: '#5b8cff' };
/** CLI の分からない持ち主の 1 つ目の色（ワークベンチのアクセント）。 */
const UNKNOWN_COLOR = '#5b8cff';
/** 2 つ目以降の持ち主の色（紫・桃・青）。 */
const MORE_COLORS: readonly string[] = ['#8250df', '#bf3989', '#0969da'];
/** 同じページの持ち主を覚えておく時間（ms）。これだけ入力が無い持ち主は並びから外す。 */
const OWNER_IDLE_MS = 10 * 60_000;
/** 覚えるページ・名前の上限（溢れたら古いものから捨てる。演出の台帳なので害は無い）。 */
const MAX_PAGES = 64;
const MAX_LABELS = 256;

interface IOwnerSeen {
	readonly ownerKey: string;
	readonly cli: ParadisCursorCli | undefined;
	/** 色の枠（0 は CLI の色、1 以降は {@link MORE_COLORS}）。来たときに決め、休んで外れるまで変えない。 */
	readonly slot: number;
	/** 名前の番号（1 は番号を出さない）。来たときに決め、休んで外れるまで変えない（Q636 A）。 */
	number: number;
	/** {@link number} を決めたときの名前。名前を変えた持ち主を見分ける（表示が重なったときに譲る側）。 */
	numberedAs: string;
	at: number;
}

interface ILabelEntry {
	label: string;
	changes: number[];
}

/** 持ち主の鍵（ページのスコープキー＝ペインのトークンかトークンとタブ）から、トークンを含まない id を作る。 */
export function paradisCursorOwnerId(ownerKey: string): string {
	return createHash('sha256').update(`paradis-cursor-owner\0${ownerKey}`).digest('hex').slice(0, 16);
}

export class ParadisCursorOwners {

	private readonly labels = new Map<string, ILabelEntry>();
	/** ページ（exactView の JSON）→ そのページに入力した持ち主（来た順）。 */
	private readonly pages = new Map<string, IOwnerSeen[]>();

	constructor(private readonly now: () => number = Date.now) { }

	/**
	 * 名前を決める（`set_cursor_label`）。1 分に 3 回を超えた変更は断らずに前の名前のまま返す。
	 * 断った名前（URL・予約語など）は既定に戻す。
	 */
	setLabel(ownerKey: string, raw: string): ParadisCursorLabelResult & { readonly rateLimited?: boolean } {
		const result = paradisNormalizeCursorLabel(raw);
		const entry = this.labels.get(ownerKey);
		const at = this.now();
		if (entry) {
			entry.changes = entry.changes.filter(changedAt => at - changedAt < PARADIS_CURSOR_LABEL_RATE_WINDOW_MS);
			if (entry.changes.length >= PARADIS_CURSOR_LABEL_RATE_LIMIT) {
				return { ok: true, label: entry.label, truncated: false, rateLimited: true };
			}
		}
		if (!result.ok) {
			// 断った回も数える（有効な名前と断られる名前を交互に送って、回数の上限を越えさせない）
			if (entry) {
				entry.label = '';
				entry.changes.push(at);
			} else {
				this.labels.set(ownerKey, { label: '', changes: [at] });
			}
			return result;
		}
		if (!entry && this.labels.size >= MAX_LABELS) {
			const oldest = this.labels.keys().next().value;
			if (oldest !== undefined) {
				this.labels.delete(oldest);
			}
		}
		this.labels.set(ownerKey, { label: result.label, changes: [...(entry?.changes ?? []), at] });
		return result;
	}

	/** 持ち主が決めた名前（無ければ undefined）。 */
	labelOf(ownerKey: string): string | undefined {
		return this.labels.get(ownerKey)?.label || undefined;
	}

	/**
	 * このページに入力する持ち主の名前と色。入力のたびに呼ぶ（呼んだ順に色が決まる）。
	 */
	resolve(ownerKey: string, pageKey: string, cli: ParadisCursorCli | undefined): IParadisCursorOwner {
		const at = this.now();
		let seen = this.pages.get(pageKey);
		if (!seen) {
			if (this.pages.size >= MAX_PAGES) {
				const oldest = this.pages.keys().next().value;
				if (oldest !== undefined) {
					this.pages.delete(oldest);
				}
			}
			seen = [];
			this.pages.set(pageKey, seen);
		}
		const live = seen.filter(owner => owner.ownerKey === ownerKey || at - owner.at < OWNER_IDLE_MS);
		let self = live.find(owner => owner.ownerKey === ownerKey);
		if (!self) {
			// 先に来た持ち主が休んで外れても、残りの持ち主の色が途中で変わらないよう、空いた枠のうち一番前を使う
			let slot = 0;
			while (live.some(owner => owner.slot === slot)) {
				slot++;
			}
			const name = this.baseName(ownerKey, cli);
			self = { ownerKey, cli, slot, number: this.freeNumber(live, name, undefined), numberedAs: name, at };
			live.push(self);
		}
		self.at = at;
		this.pages.set(pageKey, live);
		this.settleRename(live, self);
		const color = self.slot === 0
			? (cli ? CLI_COLOR[cli] : UNKNOWN_COLOR)
			: MORE_COLORS[(self.slot - 1) % MORE_COLORS.length];
		const base = this.baseName(ownerKey, self.cli);
		const name = self.number > 1 ? `${base} ${self.number}` : base;
		return { id: paradisCursorOwnerId(ownerKey), name, mark: cli ? CLI_MARK[cli] : '', color };
	}

	/** 持ち主の番号を除いた名前（決めた名前、無ければ CLI の名前）。 */
	private baseName(ownerKey: string, cli: ParadisCursorCli | undefined): string {
		return this.labels.get(ownerKey)?.label || (cli ? CLI_NAME[cli] : defaultName());
	}

	/** `name` の持ち主（`except` を除く）が使っていない一番小さい番号。 */
	private freeNumber(live: readonly IOwnerSeen[], name: string, except: IOwnerSeen | undefined): number {
		let number = 1;
		while (live.some(owner => owner !== except && owner.number === number && this.baseName(owner.ownerKey, owner.cli) === name)) {
			number++;
		}
		return number;
	}

	/**
	 * `self` の表示（名前と番号）がほかの持ち主と同じなら、名前を変えた方に番号を取り直させる。
	 * 名前を変えただけで重ならなければ番号は保つ。
	 */
	private settleRename(live: readonly IOwnerSeen[], self: IOwnerSeen): void {
		const name = this.baseName(self.ownerKey, self.cli);
		const other = live.find(owner => owner !== self && owner.number === self.number && this.baseName(owner.ownerKey, owner.cli) === name);
		if (other) {
			const otherRenamed = other.numberedAs !== name && self.numberedAs === name;
			const loser = otherRenamed ? other : self;
			loser.number = this.freeNumber(live, name, loser);
			loser.numberedAs = name;
		} else {
			self.numberedAs = name;
		}
	}
}

/** CLI の分からない持ち主の名前。 */
function defaultName(): string {
	try {
		return localize('paradis.agentBrowser.cursorOwnerAgent', "エージェント");
	} catch {
		return 'Agent';
	}
}
