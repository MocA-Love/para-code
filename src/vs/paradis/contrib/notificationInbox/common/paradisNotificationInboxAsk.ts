/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 受信箱の「あなたの番」のカードの決まり（DOM を持たない純粋な関数）。
//
// - どこで答えるか: 小さい問いは行の中のボタン、2 問以上か選択肢 5 つ以上は S のモーダル（Q677 の 3）
// - 押してすぐ送るか: 問いが 1 つで 1 つだけ選ぶものは押してすぐ、それ以外は選んでから「回答する」（Q677 の 4）
// - 許可（承認）: 危険な操作を含むもの・中身が行に収まらないものは、行の中に「許可」を出さず、全文を見せるモーダルで答える
//   （スマホの許可カードは危険の札と 6 行までの中身を出す。それより緩くしない）

import { localize } from '../../../../nls.js';
import { IParadisHumanAskEntry, IParadisHumanAskQuestion, ParadisHumanAskAnswer, ParadisHumanAskKind, ParadisHumanAskSource, ParadisHumanAskSurface, paradisHumanAskAnswerable } from '../../humanAsk/common/paradisHumanAsk.js';

/** 行の中にボタンで出す選択肢の数の上限（これを超えたらモーダル）。 */
export const PARADIS_INBOX_ASK_INLINE_OPTION_LIMIT = 4;
/** 行の中のボタンに出す選択肢の文字数の上限（これを超えたらモーダル）。 */
export const PARADIS_INBOX_ASK_INLINE_LABEL_LIMIT = 24;
/** カードに出す許可の中身の行数（スマホの許可カードと同じ）。 */
export const PARADIS_INBOX_ASK_DETAIL_LINES = 6;
/** 1 行の目安の文字数（折り返しで増える行数を見込む）。 */
const DETAIL_CHARS_PER_LINE = 56;

// ---- 危険な操作の札 ----------------------------------------------------------------------------
//
// スマホの許可カード（app/mobile/src/dangerousCommand.ts）と同じ規則。アプリは別のパッケージで import できないので
// 同じ表をここに持つ（片方を直したらもう片方も直す）。網羅的な安全判定ではない（拾えなかったから安全、ではない）。

const START = '(?:^|[\\s;&|()`"\'])';
const SAME_COMMAND = '[^;&|\\n]*?';

function dangerRules(): readonly { readonly label: string; readonly pattern: RegExp }[] {
	const removes = localize('paradis.inbox.ask.danger.remove', "削除を含む");
	const overwritesDisk = localize('paradis.inbox.ask.danger.disk', "ディスクを上書き");
	return [
		{ label: removes, pattern: new RegExp(`${START}rm(?=\\s)${SAME_COMMAND}\\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\\s|$)`, 'm') },
		{ label: removes, pattern: new RegExp(`${START}git(?=\\s)${SAME_COMMAND}\\bclean\\b${SAME_COMMAND}\\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\\s|$)`, 'm') },
		{ label: localize('paradis.inbox.ask.danger.forcePush', "強制 push"), pattern: new RegExp(`${START}git(?=\\s)${SAME_COMMAND}\\bpush\\b${SAME_COMMAND}\\s(?:--force(?:-with-lease)?(?:=\\S*)?|-[a-zA-Z]*f[a-zA-Z]*|\\+\\S+)(?=\\s|$)`, 'm') },
		{ label: localize('paradis.inbox.ask.danger.history', "履歴を書き換える"), pattern: new RegExp(`${START}git(?=\\s)${SAME_COMMAND}\\breset\\b${SAME_COMMAND}\\s--hard(?=\\s|$)`, 'm') },
		{ label: localize('paradis.inbox.ask.danger.sudo', "管理者権限"), pattern: new RegExp(`${START}sudo(?=\\s|$)`, 'm') },
		{ label: localize('paradis.inbox.ask.danger.chmod', "権限を一括変更"), pattern: new RegExp(`${START}(?:chmod|chown)(?=\\s)${SAME_COMMAND}\\s(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)(?=\\s|$)`, 'm') },
		{ label: localize('paradis.inbox.ask.danger.dropDb', "DB を削除"), pattern: /\bdrop\s+(?:table|database|schema)\b/i },
		{ label: overwritesDisk, pattern: new RegExp(`${START}mkfs(?:\\.\\w+)?(?=\\s|$)`, 'm') },
		{ label: overwritesDisk, pattern: new RegExp(`${START}dd(?=\\s)${SAME_COMMAND}\\sif=`, 'm') },
		{ label: overwritesDisk, pattern: />\s*\/dev\/(?!null\b|stdout\b|stderr\b|stdin\b|tty\b|fd\/)\w/ },
	];
}

/** 許可の中身に含まれる、取り消しの利かない操作の呼び名（無ければ空）。 */
export function paradisInboxAskDangerLabels(text: string | undefined): string[] {
	if (!text) {
		return [];
	}
	const labels: string[] = [];
	for (const rule of dangerRules()) {
		if (!labels.includes(rule.label) && rule.pattern.test(text)) {
			labels.push(rule.label);
		}
	}
	return labels;
}

/** 等幅の枠での幅の見積もり（全角・CJK など 1 バイト文字でないものは半角 2 文字分と数える）。 */
function paradisInboxAskColumns(line: string): number {
	let columns = 0;
	for (const char of line) {
		columns += char.charCodeAt(0) > 0xff ? 2 : 1;
	}
	return columns;
}

/**
 * 中身がカードの行数（{@link PARADIS_INBOX_ASK_DETAIL_LINES}）に収まらない見込みか（描く前の見積もり。描いた後に溢れて
 * いれば、受信箱のカードがもう一度モーダルへ回す）。
 */
export function paradisInboxAskDetailIsLong(text: string | undefined): boolean {
	if (!text) {
		return false;
	}
	let lines = 0;
	for (const line of text.split('\n')) {
		lines += Math.max(1, Math.ceil(paradisInboxAskColumns(line) / DETAIL_CHARS_PER_LINE));
		if (lines > PARADIS_INBOX_ASK_DETAIL_LINES) {
			return true;
		}
	}
	return false;
}

// ---- カードの出し分け ---------------------------------------------------------------------------

/**
 * カードの形。
 *
 * - `settled`: 回答済み・取り下げ（ボタンを外して 1 行だけ出し、少しして一覧から消える）
 * - `unanswerable`: ここからは答えられない（「ペインへ移動」だけ）
 * - `inline-options`: 行の中の選択肢のボタン。押すとすぐ送る
 * - `inline-actions`: 行の中のボタン（許可・拒否など）。押すとすぐ送る
 * - `dialog`: 「開いて答える」で S のモーダルを開く
 */
export type ParadisInboxAskLayout = 'settled' | 'unanswerable' | 'inline-options' | 'inline-actions' | 'dialog';

type AskShape = Pick<IParadisHumanAskEntry, 'state' | 'kind' | 'questions' | 'actions' | 'preface' | 'inlineAllowed'>;

export function paradisInboxAskLayout(entry: AskShape): ParadisInboxAskLayout {
	if (entry.state !== 'waiting') {
		return 'settled';
	}
	if (!paradisHumanAskAnswerable(entry)) {
		return 'unanswerable';
	}
	if (entry.questions.length > 0) {
		const question = entry.questions[0];
		// 行の中のボタンは 1 行で、長い選択肢は途中で切れる。読み切れない選択肢を押させないよう、折り返して出すモーダルへ回す
		return entry.questions.length === 1 && !question.multiSelect && question.options.length >= 1 && question.options.length <= PARADIS_INBOX_ASK_INLINE_OPTION_LIMIT
			&& question.options.every(option => option.label.length <= PARADIS_INBOX_ASK_INLINE_LABEL_LIMIT)
			? 'inline-options'
			: 'dialog';
	}
	// 許可を行の中で 1 押しで答えてよいのは、持ち主が許可リストに入れたもの（inlineAllowed）で、危険の札が付かず短いものだけ
	const needsFullText = entry.kind === 'permission' && (entry.inlineAllowed !== true || paradisInboxAskDangerLabels(entry.preface).length > 0 || paradisInboxAskDetailIsLong(entry.preface));
	// 押す前に確認が要るボタン（ボードの「完了扱いにする」など）は、モーダルで確認を通してから送る
	return needsFullText || entry.actions.some(action => action.allowText || action.confirm !== undefined) || entry.actions.length > PARADIS_INBOX_ASK_INLINE_OPTION_LIMIT ? 'dialog' : 'inline-actions';
}

/** モーダルの中で、選択肢を押してすぐ送るか（問いが 1 つで、1 つだけ選ぶもの）。それ以外は選んでから「回答する」。 */
export function paradisInboxAskSendsOnPick(entry: Pick<IParadisHumanAskEntry, 'questions'>): boolean {
	return entry.questions.length === 1 && !entry.questions[0].multiSelect;
}

// ---- モーダルの選びかけ → 答え ------------------------------------------------------------------

/** 1 問の選びかけ。 */
export interface IParadisInboxAskDraft {
	readonly optionIds: readonly string[];
	readonly text: string;
}

function draftAnswers(question: IParadisHumanAskQuestion, draft: IParadisInboxAskDraft | undefined): boolean {
	return draft !== undefined && (draft.optionIds.length > 0 || (question.allowText && draft.text.trim().length > 0));
}

/** 答えた問いの数。 */
export function paradisInboxAskAnsweredCount(entry: Pick<IParadisHumanAskEntry, 'questions'>, drafts: ReadonlyMap<string, IParadisInboxAskDraft>): number {
	return entry.questions.filter(question => draftAnswers(question, drafts.get(question.id))).length;
}

/**
 * 選びかけから答えを作る。まだ送れなければ undefined。
 *
 * ペインの質問は全問に答えるまで送れない（ターミナルの質問の画面は 1 問だけを飛ばせない）。ほかの出どころは
 * 1 問でも答えていれば送れる（答えなかった問いは持ち主が聞き直す）。選択肢を選んだ問いでは、書いた文は送らない
 * （選択肢か、自分で書くかのどちらか）。
 */
export function paradisInboxAskAnswerFromDrafts(entry: Pick<IParadisHumanAskEntry, 'questions' | 'source'>, drafts: ReadonlyMap<string, IParadisInboxAskDraft>): ParadisHumanAskAnswer | undefined {
	const answers = [];
	for (const question of entry.questions) {
		const draft = drafts.get(question.id);
		if (draft === undefined || !draftAnswers(question, draft)) {
			continue;
		}
		answers.push(draft.optionIds.length > 0 ? { questionId: question.id, optionIds: draft.optionIds } : { questionId: question.id, text: draft.text.trim() });
	}
	const required = entry.source === 'pane' ? entry.questions.length : 1;
	return answers.length >= required && answers.length > 0 ? { type: 'answers', answers } : undefined;
}

// ---- 文言 -------------------------------------------------------------------------------------

export function paradisInboxAskKindLabel(kind: ParadisHumanAskKind): string {
	switch (kind) {
		case 'question': return localize('paradis.inbox.ask.kind.question', "質問");
		case 'permission': return localize('paradis.inbox.ask.kind.permission', "許可");
		case 'approval': return localize('paradis.inbox.ask.kind.approval', "承認");
		case 'stalled': return localize('paradis.inbox.ask.kind.stalled', "停止");
	}
}

export function paradisInboxAskSourceLabel(source: ParadisHumanAskSource): string {
	switch (source) {
		case 'pane': return localize('paradis.inbox.ask.source.pane', "ペイン");
		case 'board': return localize('paradis.inbox.ask.source.board', "ボード");
		case 'bot': return localize('paradis.inbox.ask.source.bot', "Bot");
	}
}

function surfaceLabel(surface: ParadisHumanAskSurface): string {
	switch (surface) {
		case 'inbox': return localize('paradis.inbox.ask.surface.inbox', "受信箱");
		case 'mobile': return localize('paradis.inbox.ask.surface.mobile', "スマホ");
		case 'board': return localize('paradis.inbox.ask.surface.board', "ボード");
		case 'bot': return localize('paradis.inbox.ask.surface.bot', "Bot のページ");
		case 'pane': return localize('paradis.inbox.ask.surface.pane', "ペイン");
	}
}

/**
 * 回答済み・取り下げの 1 行。どこで・何と答えたかが分かるときだけ「〇〇で回答済み: 「…」」と出す。分からないとき
 * （ターミナルで答えた、エージェントが先へ進んだ、ペインが閉じた）は、答えたとは言い切らない。
 */
export function paradisInboxAskSettledText(entry: Pick<IParadisHumanAskEntry, 'state' | 'resolution'>): string {
	const surface = entry.state === 'answered' ? entry.resolution?.surface : undefined;
	if (surface === undefined) {
		return localize('paradis.inbox.ask.settledElsewhere', "ほかの場所で対応済みか、対象外になりました");
	}
	const summary = entry.resolution?.summary;
	return summary !== undefined
		// allow-any-unicode-next-line
		? localize('paradis.inbox.ask.answeredWith', "{0}で回答済み: 「{1}」", surfaceLabel(surface), summary)
		: localize('paradis.inbox.ask.answered', "{0}で回答済み", surfaceLabel(surface));
}

/** 答えようとして断られたときの 1 行。 */
export function paradisInboxAskRefusedText(reason: 'gone' | 'busy' | 'invalid' | 'unavailable'): string {
	switch (reason) {
		case 'gone': return localize('paradis.inbox.ask.refused.gone', "この問いはもう回答を待っていません");
		case 'busy': return localize('paradis.inbox.ask.refused.busy', "ほかの場所からの回答を届けています");
		case 'invalid': return localize('paradis.inbox.ask.refused.invalid', "問いの中身が変わりました。もう一度選んでください");
		case 'unavailable': return localize('paradis.inbox.ask.refused.unavailable', "回答を送れませんでした。少し待ってからもう一度試してください");
	}
}
