/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 左の「スペース」のビューに置く Bot の帯（paradisBotsBand.ts）の、DOM を持たない決まり。
// 開閉と高さの保存、見せる行（閉じたらピン留めだけ）、数の丸、行の 2 つ目の文、顔の形と色、作成の入力の検査、
// 行の右クリックのメニューの並びをここに集め、単体テストで値を確かめる。

import { localize } from '../../../../nls.js';
import type { ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';
import { PARADIS_BOT_LIMITS, ParadisBotFaceColor, ParadisBotFaceShape, paradisBotDefaultFace, paradisSanitizeBotName } from './paradisBots.js';
import { IParadisBotSummary } from './paradisBotsApi.js';

/** Bot の行を押したときに呼ぶコマンド（引数は Bot の id）。中身（Bot のページを開く）は後の PR が同じ id で登録する。 */
export const PARADIS_BOTS_OPEN_COMMAND = 'paradis.bots.open';

/** 帯の開閉と高さを覚えるキー（APPLICATION。どの窓でも同じ帯にする）。 */
export const PARADIS_BOTS_BAND_STORAGE_KEY = 'paradis.bots.band.v1';

export const PARADIS_BOTS_BAND_SIZES = Object.freeze({
	/** 見出しの帯（メモの帯と同じ）。 */
	header: 22,
	/** 1 行。 */
	row: 28,
	/** 一覧の上下の余白の合計。 */
	listPadding: 4,
	/** 一覧の高さの既定（4 行分）。 */
	defaultList: 4 * 28 + 4,
	/** 境の線で変えられる高さの下限と上限。 */
	minList: 32,
	maxList: 420,
	/** 帯（見出しを除く）がビューの高さに占めてよい割合。ツリーとメモの帯の取り分を残す。 */
	maxViewShare: 0.4,
});

export interface IParadisBotsBandState {
	readonly open: boolean;
	/** 境の線で決めた一覧の高さ。undefined は既定。 */
	readonly listHeight: number | undefined;
}

export const DEFAULT_PARADIS_BOTS_BAND_STATE: IParadisBotsBandState = Object.freeze({ open: true, listHeight: undefined });

function clampListHeight(height: number): number {
	return Math.max(PARADIS_BOTS_BAND_SIZES.minList, Math.min(PARADIS_BOTS_BAND_SIZES.maxList, Math.round(height)));
}

/** 保存した帯の状態を読む。読めなければ既定（開いて、高さは既定）。 */
export function paradisParseBotsBandState(raw: string | undefined): IParadisBotsBandState {
	if (raw === undefined || raw.length > 256) {
		return DEFAULT_PARADIS_BOTS_BAND_STATE;
	}
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== 'object' || value === null) {
			return DEFAULT_PARADIS_BOTS_BAND_STATE;
		}
		const record = value as { open?: unknown; listHeight?: unknown };
		return {
			open: typeof record.open === 'boolean' ? record.open : true,
			listHeight: typeof record.listHeight === 'number' && Number.isFinite(record.listHeight) ? clampListHeight(record.listHeight) : undefined,
		};
	} catch {
		return DEFAULT_PARADIS_BOTS_BAND_STATE;
	}
}

export function paradisSerializeBotsBandState(state: IParadisBotsBandState): string {
	return JSON.stringify(state.listHeight === undefined ? { open: state.open } : { open: state.open, listHeight: clampListHeight(state.listHeight) });
}

/** 境の線を引いたあとの高さ（上限・下限で挟む）。 */
export function paradisBotsBandDraggedHeight(startHeight: number, delta: number): number {
	return clampListHeight(startHeight + delta);
}

/** 帯に出す行。開いていれば全部、閉じていればピン留めした Bot だけ（並びは台帳のまま）。 */
export function paradisBotsBandRows(bots: readonly IParadisBotSummary[], open: boolean): readonly IParadisBotSummary[] {
	return open ? bots : bots.filter(bot => bot.pinned === true);
}

/**
 * 一覧の高さ。開いているときは覚えた高さ（無ければ既定）を、行が少なければ行の分まで縮める。閉じているときは
 * ピン留めの行の分だけ（無ければ 0）。どちらもビューの高さの {@link PARADIS_BOTS_BAND_SIZES.maxViewShare} を超えない
 * （超える分は帯の中でスクロールする）。
 * @param groupRowCount `rowCount` のうちグループの節の行（見出しを含む）。高さを覚えていなければ、既定の高さ（Bot の 4 行分）に
 * この分を足す（Bot が 3 体を超えると、グループの行がスクロールの外に隠れて気づけなかった）。
 */
export function paradisBotsBandListHeight(state: IParadisBotsBandState, rowCount: number, viewHeight: number, groupRowCount = 0): number {
	const sizes = PARADIS_BOTS_BAND_SIZES;
	if (rowCount === 0) {
		// 開いていれば空の案内の 1 行、閉じていれば一覧を出さない
		return state.open ? sizes.row + sizes.listPadding : 0;
	}
	const content = rowCount * sizes.row + sizes.listPadding;
	const wanted = state.open ? Math.min(content, state.listHeight ?? sizes.defaultList + groupRowCount * sizes.row) : content;
	const cap = Math.max(sizes.row + sizes.listPadding, Math.floor(viewHeight * sizes.maxViewShare));
	return Math.max(0, Math.min(wanted, cap));
}

/** 見出しの数の丸（「あなたの番」の合計。一時停止中の Bot は本体が 0 として数える）。 */
export function paradisBotsNeedsYouTotal(bots: readonly IParadisBotSummary[]): number {
	return bots.reduce((total, bot) => total + Math.max(0, bot.needsYou), 0);
}

/** 会話のペインのエージェントが動いていない・止まっている理由の短い文。理由が無ければ undefined（「待機中」を出す）。 */
function paradisBotHaltLine(halt: IParadisBotSummary['halt']): string | undefined {
	switch (halt?.kind) {
		case 'notFound': return localize('paradis.bots.status.notFound', "見つかりません");
		case 'exited': return halt.exitCode !== undefined && halt.exitCode !== 0
			? localize('paradis.bots.status.exitedCode', "終了しました（コード {0}）", halt.exitCode)
			: localize('paradis.bots.status.exited', "終了しました");
		case 'needsUser': return localize('paradis.bots.status.needsUser', "操作が要ります");
		default: return undefined;
	}
}

/** 様子の文の全文（帯の幅で切れたときにホバーで出す）。エージェントが見つからないときは、何が見つからないかも書く。 */
export function paradisBotStatusDetail(bot: IParadisBotSummary): string {
	if (!bot.paused && bot.needsYou === 0 && bot.activity === 'idle' && bot.halt?.kind === 'notFound') {
		return localize('paradis.bots.status.notFoundDetail', "エージェントのコマンドが見つかりません");
	}
	return paradisBotStatusLine(bot);
}

/** 行の名前の後ろに出す、今の様子の短い文。 */
export function paradisBotStatusLine(bot: IParadisBotSummary): string {
	if (bot.paused) {
		return localize('paradis.bots.status.paused', "停止中");
	}
	if (bot.needsYou > 0) {
		return localize('paradis.bots.status.needsYou', "{0} 件があなたの番", bot.needsYou);
	}
	// 会話のペインが無く前の会話が残っていれば、会話は眠っている。見回りのペインが動いていても、会話の状態を主にする
	// （見回りのペインだけを見て「待機中」と出すと、話しかけられる会話が起きていると読める）
	const asleep = bot.sleeping === true;
	switch (bot.activity) {
		case 'working': return localize('paradis.bots.status.working', "作業中");
		case 'patrolling': return asleep
			? localize('paradis.bots.status.sleepingPatrolling', "眠っています・見回り中")
			: localize('paradis.bots.status.patrolling', "見回り中");
		case 'idle': return asleep
			? localize('paradis.bots.status.sleeping', "眠っています")
			: paradisBotHaltLine(bot.halt) ?? localize('paradis.bots.status.idle', "待機中");
		// 前の会話を残して止まっている（再起動の後・何もしない 30 分の後）。話しかけると続きから起きる
		default: return bot.sleeping === true
			? localize('paradis.bots.status.sleeping', "眠っています")
			: localize('paradis.bots.status.stopped', "起動していません");
	}
}

// ---- 顔 -------------------------------------------------------------------------------------------

/**
 * 顔の様子（目の形・印・動き）。帯の文（{@link paradisBotStatusLine}）と同じく 停止中 → あなたの番 → 活動 → 止まっている理由 の順で決める。
 * - `idle` 待機中: 開いた目でまばたきし、ゆっくり息をする
 * - `work` 作業中（考え中も含む。台帳の `working` は 1 つ）: 目が右上・左上・上を見回し、上に 3 つの点
 * - `patrol` 見回り中（定期実行の見回りも同じ顔）: 目が左右を見て、うなずく。虫めがねが浮く
 * - `ask` あなたの番: 開いた目で 4 秒に 1 回跳ね、右上に「?」
 * - `need` 操作が要ります: 細めた目と汗
 * - `halt` 終了しました・見つかりません: 細めた目と薄い体
 * - `sleep` 眠っています: 閉じた目（下向きの弧）でゆっくり息をし、「z z」が浮く
 * - `off` 起動していません: 横の線の目で動かず、薄い体
 * - `paused` 停止中: 開いた目でまばたきせず、薄い体と右上に一時停止の 2 本線
 */
export type ParadisBotFaceState = 'idle' | 'work' | 'patrol' | 'ask' | 'need' | 'halt' | 'sleep' | 'off' | 'paused';

/**
 * 様子が変わったときに 1 回だけ出すつなぎ。`wake` 起きる（まばたき 2 回と伸び）、`done` できた（閉じた目の笑顔で 2 回弾み、
 * チェックが光る）、`shiver` 操作が要る・終了に入ったときに 3 回震える、`hop` あなたの番に入ったときにすぐ 1 回跳ねる。
 */
export type ParadisBotFaceTransition = 'wake' | 'done' | 'shiver' | 'hop';

/** つなぎの長さ（ミリ秒。CSS のアニメーションの長さと同じ）。 */
export const PARADIS_BOT_FACE_TRANSITION_MS: Readonly<Record<ParadisBotFaceTransition, number>> = Object.freeze({
	wake: 800,
	done: 1200,
	shiver: 1500,
	hop: 600,
});

export interface IParadisBotFace {
	/** 体の形と色の名前（台帳の faceShape・faceColor。色の値は CSS がテーマの色から決める）。 */
	readonly shape: ParadisBotFaceShape;
	readonly color: ParadisBotFaceColor;
	readonly state: ParadisBotFaceState;
	/** Bot の id（まばたきの位相をずらし、様子の変わり目のつなぎを場所をまたいで揃える）。 */
	readonly id?: string;
}

/** 台帳の様子から顔の様子を決める。 */
export function paradisBotFaceState(bot: Pick<IParadisBotSummary, 'paused' | 'needsYou' | 'activity' | 'halt' | 'sleeping'>): ParadisBotFaceState {
	if (bot.paused) {
		return 'paused';
	}
	if (bot.needsYou > 0) {
		return 'ask';
	}
	switch (bot.activity) {
		case 'working': return 'work';
		// 眠っている会話の横で見回りのペインが動いているときも、見回りの顔にする（文の方が「眠っています・見回り中」と両方を出す）
		case 'patrolling': return 'patrol';
		case 'idle':
			if (bot.sleeping === true) {
				return 'sleep';
			}
			switch (bot.halt?.kind) {
				case 'needsUser': return 'need';
				case 'exited':
				case 'notFound': return 'halt';
				default: return 'idle';
			}
		default: return bot.sleeping === true ? 'sleep' : 'off';
	}
}

/** 前の様子から次の様子へ移るときのつなぎ（無ければ undefined。初めて描くときは前の様子が無いので出さない）。 */
export function paradisBotFaceTransition(previous: ParadisBotFaceState | undefined, next: ParadisBotFaceState): ParadisBotFaceTransition | undefined {
	if (previous === undefined || previous === next) {
		return undefined;
	}
	if (next === 'need' || next === 'halt') {
		return previous === 'need' || previous === 'halt' ? undefined : 'shiver';
	}
	if (previous === 'sleep' || previous === 'off') {
		return next === 'idle' || next === 'work' || next === 'patrol' || next === 'ask' ? 'wake' : undefined;
	}
	if (previous === 'work' && next === 'idle') {
		return 'done';
	}
	return next === 'ask' ? 'hop' : undefined;
}

/**
 * Bot ごとの最後の様子と、そこへ移ったときのつなぎ。描くたびに {@link observe} を呼ぶと、様子が変わった最初の 1 回でつなぎを
 * 始め、つなぎの長さの間は同じつなぎと経った時間を返す（描き直した顔・別の場所の顔も同じ所から続ける）。
 */
export class ParadisBotFaceTransitionLedger {
	private readonly last = new Map<string, { readonly state: ParadisBotFaceState; readonly kind?: ParadisBotFaceTransition; readonly at: number }>();

	observe(id: string, state: ParadisBotFaceState, now: number): { readonly kind: ParadisBotFaceTransition; readonly elapsedMs: number } | undefined {
		let entry = this.last.get(id);
		if (entry?.state !== state) {
			entry = { state, kind: paradisBotFaceTransition(entry?.state, state), at: now };
			this.last.set(id, entry);
		}
		const elapsedMs = now - entry.at;
		return entry.kind !== undefined && elapsedMs < PARADIS_BOT_FACE_TRANSITION_MS[entry.kind] ? { kind: entry.kind, elapsedMs } : undefined;
	}
}

/** Bot ごとの動きの位相（0〜3.9 秒）。帯に並んだ Bot が一斉にまばたきしないよう、id から決めてずらす（ParaDot と同じ幅）。 */
export function paradisBotFacePhaseSeconds(id: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < id.length; index++) {
		hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193) >>> 0;
	}
	return (hash % 40) / 10;
}

/** 顔の形と色は台帳のまま、様子は今の台帳から決める。 */
export function paradisBotFace(bot: Pick<IParadisBotSummary, 'id' | 'faceShape' | 'faceColor' | 'paused' | 'needsYou' | 'activity' | 'halt' | 'sleeping'>): IParadisBotFace {
	return { shape: bot.faceShape, color: bot.faceColor, state: paradisBotFaceState(bot), id: bot.id };
}

/** 顔の色の日本語の名前（色だけで見分けないよう、選ぶ欄の文字・ホバー・読み上げに出す）。 */
export function paradisBotFaceColorLabel(color: ParadisBotFaceColor): string {
	switch (color) {
		case 'blue': return localize('paradis.bots.faceColor.blue', "青");
		case 'teal': return localize('paradis.bots.faceColor.teal', "青緑");
		case 'green': return localize('paradis.bots.faceColor.green', "緑");
		case 'amber': return localize('paradis.bots.faceColor.amber', "山吹");
		case 'pink': return localize('paradis.bots.faceColor.pink', "桃");
		case 'violet': return localize('paradis.bots.faceColor.violet', "紫");
		case 'red': return localize('paradis.bots.faceColor.red', "赤");
		case 'orange': return localize('paradis.bots.faceColor.orange', "橙");
	}
}

/** 顔の形の日本語の名前。 */
export function paradisBotFaceShapeLabel(shape: ParadisBotFaceShape): string {
	switch (shape) {
		case 'circle': return localize('paradis.bots.faceShape.circle', "丸");
		case 'squircle': return localize('paradis.bots.faceShape.squircle', "角丸");
		case 'hex': return localize('paradis.bots.faceShape.hex', "六角");
		case 'blob': return localize('paradis.bots.faceShape.blob', "もち");
		case 'drop': return localize('paradis.bots.faceShape.drop', "しずく");
		case 'penta': return localize('paradis.bots.faceShape.penta', "五角");
	}
}

/**
 * 作成の画面の顔。手で選んだ色・形はそのまま使い、選んでいない方は名前から決まる（{@link paradisBotDefaultFace}）。名前が
 * まだ空なら `seed`（「新」）から決める。
 */
export function paradisBotCreateFace(name: string, seed: string, picked: { readonly color?: ParadisBotFaceColor; readonly shape?: ParadisBotFaceShape }): { readonly faceColor: ParadisBotFaceColor; readonly faceShape: ParadisBotFaceShape } {
	const fallback = paradisBotDefaultFace(name.trim() || seed);
	return { faceColor: picked.color ?? fallback.faceColor, faceShape: picked.shape ?? fallback.faceShape };
}

// ---- 作成 -----------------------------------------------------------------------------------------

/** 役割の文の上限（人格メモの種になる）。 */
export const PARADIS_BOT_ROLE_MAX_LENGTH = 2000;

/** 作成の画面で選べるエージェント（モックどおり 2 つ）。 */
export const PARADIS_BOT_CREATE_AGENTS: readonly ParadisAgentKind[] = ['claude', 'codex'];

export type ParadisBotNameProblem = 'empty' | 'invalid' | 'duplicate';

/** 同じ名前とみなすための形（前後の空白を落とし、全角・半角と大文字・小文字をそろえる）。 */
function nameKey(name: string): string {
	return name.trim().normalize('NFKC').toLowerCase();
}

/**
 * 作成・名前の変更の名前を検める。台帳は同じ名前を断らないので、一覧で見分けられるよう画面の側で断る。
 * `exceptId` は名前を変える Bot 自身（同じ名前のままを重なりと数えない）。
 */
export function paradisValidateBotName(value: string, bots: readonly Pick<IParadisBotSummary, 'id' | 'name'>[], exceptId?: string): { readonly ok: true; readonly name: string } | { readonly ok: false; readonly problem: ParadisBotNameProblem } {
	if (value.trim().length === 0) {
		return { ok: false, problem: 'empty' };
	}
	const name = paradisSanitizeBotName(value);
	if (name === undefined) {
		return { ok: false, problem: 'invalid' };
	}
	const key = nameKey(name);
	if (bots.some(bot => bot.id !== exceptId && nameKey(bot.name) === key)) {
		return { ok: false, problem: 'duplicate' };
	}
	return { ok: true, name };
}

export function paradisBotNameProblemMessage(problem: ParadisBotNameProblem): string {
	switch (problem) {
		case 'empty': return localize('paradis.bots.name.empty', "名前を入れてください");
		case 'invalid': return localize('paradis.bots.name.invalid', "名前は {0} 字までで、改行は入れられません", PARADIS_BOT_LIMITS.name);
		case 'duplicate': return localize('paradis.bots.name.duplicate', "同じ名前の Bot があります");
	}
}

/** 役割の文から人格メモ（SOUL.md）の種を作る。空なら undefined（本体の既定の種を使う）。 */
export function paradisBotCreateSoul(name: string, role: string): string | undefined {
	const text = role.trim();
	return text ? `# ${name}\n\n${text.slice(0, PARADIS_BOT_ROLE_MAX_LENGTH)}\n` : undefined;
}

// ---- 行のメニュー ---------------------------------------------------------------------------------

export type ParadisBotRowMenuItem = 'pin' | 'unpin' | 'rename' | 'pause' | 'resume' | 'remove';

/** 行の右クリックのメニューの並び（区切りは '-'）。 */
export function paradisBotRowMenu(bot: Pick<IParadisBotSummary, 'pinned' | 'paused'>): readonly (ParadisBotRowMenuItem | '-')[] {
	return [bot.pinned === true ? 'unpin' : 'pin', '-', 'rename', bot.paused ? 'resume' : 'pause', '-', 'remove'];
}
