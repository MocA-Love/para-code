// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 要対応に出す「人が答えるもの」の台帳の 1 件（`human-ask.v1`。PC 側は paradisMobileHumanAsks.ts）の読み方と送り方。
 *
 * PC が `human-ask.v1` を広告しているときだけ使う。State の `humanAsks`（件数と印）で数を出し、印が変わったら fs の
 * `humanAsks` で一覧を取り直し、fs の `humanAskAnswer` で答える。出てくるのはボードの質問・承認・止まった、Bot の質問、
 * `ask_human` の質問だけで、許可とペインの質問は今までの許可カード・質問カードのまま（PC が一覧から外す）。
 */

import type { AgentChatMessage, AgentQuestionAnswer } from '../../store.js';

// 形は PC の `IParadisMobileHumanAsk`（paradisMobileHumanAsks.ts）と同じ。PC のモジュールは型でも読まない（VS Code の土台まで
// 型検査に入ってしまうため）。一致はゴールデン（app/protocol/test/golden/human-asks.json）で両側から確かめる。

export interface HumanAskSummary {
	readonly count: number;
	readonly signature: string;
}

export interface HumanAskOption {
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
	readonly recommended?: boolean;
}

export interface HumanAskQuestion {
	readonly id: string;
	readonly text: string;
	readonly options: readonly HumanAskOption[];
	readonly allowText: boolean;
	readonly multiSelect?: boolean;
}

export interface HumanAskAction {
	readonly id: string;
	readonly label: string;
	readonly allowText?: boolean;
	readonly confirm?: { readonly title: string; readonly body?: string; readonly ok: string };
}

export interface HumanAsk {
	readonly key: string;
	readonly source: 'pane' | 'board' | 'bot';
	readonly kind: 'question' | 'permission' | 'approval' | 'stalled';
	readonly from: { readonly title: string; readonly detail?: string };
	readonly preface?: string;
	readonly questions: readonly HumanAskQuestion[];
	readonly actions: readonly HumanAskAction[];
	readonly canSkip: boolean;
	readonly askedAt: number;
	readonly busy: boolean;
	readonly failed: boolean;
}

/** 1 問への答え（選んだ選択肢の id か、自分で書いた文）。 */
export interface HumanAskQuestionAnswer {
	readonly questionId: string;
	readonly optionIds?: readonly string[];
	readonly text?: string;
}

/** 台帳の答え（PC の `ParadisHumanAskAnswer` と同じ形）。 */
export type HumanAskAnswer =
	| { readonly type: 'answers'; readonly answers: readonly HumanAskQuestionAnswer[] }
	| { readonly type: 'action'; readonly actionId: string; readonly text?: string }
	| { readonly type: 'skip' };

export type HumanAskAnswerOutcome =
	| { readonly ok: true; readonly duplicate?: true }
	| { readonly ok: false; readonly reason: 'gone' | 'busy' | 'invalid' | 'unavailable' | 'unconfirmed' };

const SOURCES = new Set(['pane', 'board', 'bot']);
const KINDS = new Set(['question', 'permission', 'approval', 'stalled']);
const MAX_ASKS = 100;
const MAX_TEXT = 8000;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, limit = MAX_TEXT): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined;
}

/** Desktop State の `humanAsks` を読む（形が合わなければ undefined）。 */
export function parseHumanAskSummary(value: unknown): HumanAskSummary | undefined {
	const input = record(value);
	const count = input?.count;
	const signature = text(input?.signature, 64);
	return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && signature !== undefined ? { count, signature } : undefined;
}

function parseQuestion(value: unknown): HumanAskQuestion | undefined {
	const input = record(value);
	const id = text(input?.id, 400);
	const body = text(input?.text);
	if (input === undefined || id === undefined || body === undefined || !Array.isArray(input.options)) {
		return undefined;
	}
	const options: HumanAskOption[] = [];
	for (const item of input.options) {
		const option = record(item);
		const optionId = text(option?.id, 400);
		const label = text(option?.label, 400);
		if (option === undefined || optionId === undefined || label === undefined) {
			return undefined;
		}
		const detail = text(option.detail);
		options.push({ id: optionId, label, ...(detail !== undefined ? { detail } : {}), ...(option.recommended === true ? { recommended: true } : {}) });
	}
	return { id, text: body, options, allowText: input.allowText === true || options.length === 0, ...(input.multiSelect === true ? { multiSelect: true } : {}) };
}

function parseAction(value: unknown): HumanAskAction | undefined {
	const input = record(value);
	const id = text(input?.id, 400);
	const label = text(input?.label, 400);
	if (input === undefined || id === undefined || label === undefined) {
		return undefined;
	}
	const confirm = record(input.confirm);
	const confirmTitle = text(confirm?.title, 400);
	const confirmOk = text(confirm?.ok, 400);
	const confirmBody = text(confirm?.body);
	return {
		id,
		label,
		...(input.allowText === true ? { allowText: true } : {}),
		...(confirmTitle !== undefined && confirmOk !== undefined ? { confirm: { title: confirmTitle, ok: confirmOk, ...(confirmBody !== undefined ? { body: confirmBody } : {}) } } : {}),
	};
}

function parseAsk(value: unknown): HumanAsk | undefined {
	const input = record(value);
	const key = text(input?.key, 450);
	const from = record(input?.from);
	const title = text(from?.title, 400);
	if (input === undefined || key === undefined || title === undefined || !SOURCES.has(input.source as string) || !KINDS.has(input.kind as string)
		|| !Array.isArray(input.questions) || !Array.isArray(input.actions) || typeof input.askedAt !== 'number') {
		return undefined;
	}
	const questions = input.questions.map(parseQuestion);
	const actions = input.actions.map(parseAction);
	if (questions.some(question => question === undefined) || actions.some(action => action === undefined)) {
		return undefined;
	}
	const detail = text(from?.detail, 400);
	const preface = text(input.preface);
	return {
		key,
		source: input.source as HumanAsk['source'],
		kind: input.kind as HumanAsk['kind'],
		from: { title, ...(detail !== undefined ? { detail } : {}) },
		...(preface !== undefined ? { preface } : {}),
		questions: questions as HumanAskQuestion[],
		actions: actions as HumanAskAction[],
		canSkip: input.canSkip === true,
		askedAt: input.askedAt,
		busy: input.busy === true,
		failed: input.failed === true,
	};
}

/** fs の `humanAsks` の応答を読む。読めない 1 件は捨てる（ほかの 1 件は出す）。応答そのものが読めなければ undefined。 */
export function parseHumanAsksReply(value: unknown): { readonly signature: string; readonly asks: readonly HumanAsk[] } | undefined {
	const input = record(value);
	const signature = text(input?.signature, 64);
	if (input === undefined || signature === undefined || !Array.isArray(input.asks)) {
		return undefined;
	}
	const asks: HumanAsk[] = [];
	for (const item of input.asks.slice(0, MAX_ASKS)) {
		const ask = parseAsk(item);
		if (ask !== undefined) {
			asks.push(ask);
		}
	}
	return { signature, asks };
}

export function humanAsksRequest(): { readonly t: 'humanAsks' } {
	return { t: 'humanAsks' };
}

export function humanAskAnswerRequest(opId: string, key: string, answer: HumanAskAnswer): { readonly t: 'humanAskAnswer'; readonly opId: string; readonly key: string; readonly answer: HumanAskAnswer } {
	return { t: 'humanAskAnswer', opId, key, answer };
}

/** fs の `humanAskAnswer` の応答を読む。 */
export function parseHumanAskAnswerReply(value: unknown): HumanAskAnswerOutcome {
	const input = record(value);
	if (input?.ok === true) {
		return input.duplicate === true ? { ok: true, duplicate: true } : { ok: true };
	}
	const reason = input?.reason;
	return { ok: false, reason: reason === 'gone' || reason === 'busy' || reason === 'invalid' ? reason : 'unavailable' };
}

/** 質問カードの 1 問の答え（選択肢の番号・自分で書いた文）を、台帳の答えの 1 問にする。合わなければ undefined。 */
export function humanAskQuestionAnswer(question: HumanAskQuestion, answer: AgentQuestionAnswer): HumanAskQuestionAnswer | undefined {
	if (answer.kind === 'option') {
		const option = question.options[answer.index];
		return option !== undefined ? { questionId: question.id, optionIds: [option.id] } : undefined;
	}
	if (answer.kind === 'multi') {
		const ids = answer.indices.map(index => question.options[index]?.id);
		return ids.length > 0 && ids.every(id => id !== undefined) && question.multiSelect === true ? { questionId: question.id, optionIds: ids as string[] } : undefined;
	}
	if (answer.kind === 'text') {
		const body = answer.text.trim();
		return body.length > 0 && question.allowText ? { questionId: question.id, text: body } : undefined;
	}
	return undefined;
}

/**
 * 台帳の問いを、今の質問カードが読む形にする。おすすめは選択肢の説明の頭に書き、書けない問い（`allowText: false`）には
 * 「その他（入力して回答）」を出さない（送っても PC が断るため）。
 */
export function humanAskQuestionMessages(ask: Pick<HumanAsk, 'key' | 'questions'>): AgentChatMessage[] {
	return ask.questions.map((question, index) => ({
		rev: 0,
		role: 'assistant',
		kind: 'question',
		text: question.text,
		options: question.options.map(option => {
			const description = option.recommended === true ? (option.detail !== undefined ? `おすすめ。${option.detail}` : 'おすすめ') : option.detail;
			return { label: option.label, ...(description !== undefined ? { description } : {}) };
		}),
		...(question.multiSelect === true ? { multiSelect: true } : {}),
		...(question.allowText ? {} : { allowFreeText: false }),
		toolUseId: `${ask.key}\u0000${question.id}`,
		questionGroup: ask.key,
		questionIndex: index,
		questionCount: ask.questions.length,
	}));
}

/** 出どころの札（スマホの要対応のカードの左上）。 */
export function humanAskSourceLabel(ask: Pick<HumanAsk, 'source'>): string {
	switch (ask.source) {
		case 'board': return 'ボード';
		case 'bot': return 'Bot';
		case 'pane': return 'ペイン';
	}
}

/** 断られた理由の 1 文。 */
export function humanAskRefusalText(reason: Exclude<HumanAskAnswerOutcome, { ok: true }>['reason']): string {
	switch (reason) {
		case 'gone': return 'PC で回答済み、または対象外になりました';
		case 'busy': return 'ほかの場所で答えて、届けている最中です';
		case 'invalid': return 'この答えは送れません。選択肢から選んでください';
		case 'unavailable': return 'PC に届きませんでした。つながりを確かめてください';
		case 'unconfirmed': return '答えが届いたか確かめられませんでした。もう一度押してください';
	}
}

/**
 * PC が `duplicate`（同じ opId の 2 回目）と返したあと、取り直した一覧で答えが届いたかを決める。
 * 一覧から消えた・届けている最中（`busy`）なら届いた、まだ待っていれば届いていない、一覧が取れなければ分からない。
 * 分からないときも「答えた」にはしない（カードを消さない）。
 */
export function humanAskDuplicateOutcome(asks: readonly Pick<HumanAsk, 'key' | 'busy'>[] | undefined, key: string): HumanAskAnswerOutcome {
	const ask = asks?.find(candidate => candidate.key === key);
	return asks !== undefined && (ask === undefined || ask.busy) ? { ok: true } : { ok: false, reason: 'unconfirmed' };
}

/** ボタンを押したときに挟むシート。PC が載せた確認の文（`confirm`）があればそれを出す。 */
export type HumanAskActionSheet =
	| { readonly kind: 'text'; readonly title: string; readonly body?: string; readonly ok: string }
	| { readonly kind: 'confirm'; readonly title: string; readonly body?: string; readonly ok: string }
	| { readonly kind: 'send' };

/**
 * ボタンを押したときの扱い。文を添えられるボタンは入力のシート（PC の確認の文を題と本文に出す）、確認のあるボタンは
 * 確認のシート、どちらも無いボタンはそのまま送る。ただしボードの承認（`approval`）のボタンは、PC が確認を載せて
 * いなくても確認のシートを挟む（承認・差し戻しを 1 押しで送らない）。
 */
export function humanAskActionSheet(ask: Pick<HumanAsk, 'kind' | 'preface'>, action: HumanAskAction): HumanAskActionSheet {
	const confirm = action.confirm;
	if (action.allowText === true) {
		return { kind: 'text', title: confirm?.title ?? action.label, ...(confirm?.body !== undefined ? { body: confirm.body } : {}), ok: confirm?.ok ?? action.label };
	}
	if (confirm !== undefined) {
		return { kind: 'confirm', title: confirm.title, ...(confirm.body !== undefined ? { body: confirm.body } : {}), ok: confirm.ok };
	}
	if (ask.kind === 'approval') {
		return { kind: 'confirm', title: action.label, ...(ask.preface !== undefined ? { body: ask.preface } : {}), ok: action.label };
	}
	return { kind: 'send' };
}

let opSequence = 0;
/** 答えの操作の id（押し直し・送り直しで同じ答えを 2 回届けないため。PC は同じ opId を 1 回だけ受ける）。 */
export function newHumanAskOpId(): string {
	opSequence = (opSequence + 1) % 1_000_000;
	return `ha-${Date.now().toString(36)}-${opSequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
