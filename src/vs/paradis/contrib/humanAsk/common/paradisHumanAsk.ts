/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「人が答えるもの」の台帳の契約。
//
// 人の答えを待つものは出どころが 3 つある（エージェントのペインの許可と質問、タスクボードの質問と承認、
// Bot の Needs you）。出どころごとに別の一覧を持つと、答える場所（受信箱・スマホ・ボード・元のペイン）の
// 数だけ「どれがまだ待っているか」がずれる。ここでは 1 件の形を 1 つに決め、shared process の台帳 1 つへ
// 集める（paradisHumanAskLedger.ts）。どこかで答えると台帳の 1 件が回答済みになり、全部の場所から消える。
//
// 台帳は shared process のメモリにだけ持つ「索引」で、元の記録は出どころの持ち主が持つ（ペインは画面、
// ボードは state.json、Bot は Bot の台帳）。持ち主は自分の待ちの一覧を {@link IParadisHumanAskInput} で
// 知らせ、shared process が起動し直したら知らせ直す。
//
// 通知の台帳（notificationInbox）は「起きたことの記録」（完了を含む、既読・未読）で、こちらは
// 「いま人を待っているもの」。役目が違うので別に持つ。

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { paradisRedactTextSecrets } from '../../../common/paradisSecretRedaction.js';

export const PARADIS_HUMAN_ASK_CHANNEL = 'paradisHumanAsk';

// ---- 上限 ------------------------------------------------------------------------------------

/** 1 件の問いの数の上限（Orca の Needs you と同じ）。 */
export const PARADIS_HUMAN_ASK_QUESTION_LIMIT = 5;
/** 1 問の選択肢の数の上限（Orca の Needs you と同じ）。 */
export const PARADIS_HUMAN_ASK_OPTION_LIMIT = 8;
/** ボードの board_ask_human は選択肢を 10 個まで受けるので、ボードの分だけはそのまま通す。 */
export const PARADIS_HUMAN_ASK_BOARD_OPTION_LIMIT = 10;
/** 1 件のボタン（許可・拒否、承認して次へ・差し戻す など）の数の上限。 */
export const PARADIS_HUMAN_ASK_ACTION_LIMIT = 6;

/** id の長さの上限。ペインの id は「ペインの鍵（40 字）＋中継の対話の id（200 字まで）」になるので、それが入る長さ。 */
const ID_LIMIT = 400;
const TITLE_LIMIT = 200;
const LABEL_LIMIT = 400;
const QUESTION_TEXT_LIMIT = 2000;
/** 前置きの上限（許可の中身の全部が入る長さ。コマンド 10,000 字・MCP の引数 20 個 × 500 字など。paradisAgentApprovalRequest.ts）。 */
const PREFACE_LIMIT = 16_000;
/** 自由入力の答えの長さの上限。 */
export const PARADIS_HUMAN_ASK_ANSWER_TEXT_LIMIT = 8000;
/** 「どこで・何と答えたか」の要約の長さ。 */
const SUMMARY_LIMIT = 200;

// ---- 1 件の形 ---------------------------------------------------------------------------------

/** 出どころ。鍵は「出どころ＋その中の id」（{@link paradisHumanAskKey}）。 */
export type ParadisHumanAskSource = 'pane' | 'board' | 'bot';
export const PARADIS_HUMAN_ASK_SOURCES: readonly ParadisHumanAskSource[] = ['pane', 'board', 'bot'];

/**
 * 種類。
 *
 * - `question`: 質問（選択肢か自由入力で答える）
 * - `permission`: 許可（コマンド・ツールの実行）
 * - `approval`: 承認（ボードの計画・マージ）
 * - `stalled`: 止まった（ボードの失敗・報告なし）
 */
export type ParadisHumanAskKind = 'question' | 'permission' | 'approval' | 'stalled';
export const PARADIS_HUMAN_ASK_KINDS: readonly ParadisHumanAskKind[] = ['question', 'permission', 'approval', 'stalled'];

/** 答えた場所。 */
export type ParadisHumanAskSurface = 'inbox' | 'mobile' | 'board' | 'bot' | 'pane';
export const PARADIS_HUMAN_ASK_SURFACES: readonly ParadisHumanAskSurface[] = ['inbox', 'mobile', 'board', 'bot', 'pane'];

export interface IParadisHumanAskOption {
	/** その問いの中で一意。答えはこの id で返す（持ち主が自分の選択肢へ引き直す）。 */
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
	/** おすすめ。1 問につき 1 つまで（2 つ目以降の印は落とす）。 */
	readonly recommended?: boolean;
}

export interface IParadisHumanAskQuestion {
	/** その 1 件の中で一意。 */
	readonly id: string;
	readonly text: string;
	/** 0〜8 個（ボードの分は 10 個まで）。 */
	readonly options: readonly IParadisHumanAskOption[];
	/** 自分で書いて答えられるか。選択肢が無い問いは自由入力でしか答えられない。 */
	readonly allowText: boolean;
	/** 選択肢を複数選べるか（Claude Code の AskUserQuestion の multiSelect）。 */
	readonly multiSelect?: boolean;
}

/**
 * 問いではなく「押すもの」。許可・拒否（Codex は 3 択）、ボードの「承認して次へ・差し戻す」
 * 「実装へ戻す・やり直す」「報告を促す・完了扱いにする」。id の意味は持ち主だけが知る。
 */
export interface IParadisHumanAskAction {
	readonly id: string;
	readonly label: string;
	/** 押したときにひとこと添えられるか（差し戻しの理由など）。 */
	readonly allowText?: boolean;
	/**
	 * 押す前に確かめる文（持ち主の画面がそのボタンで出す確認と同じ文）。付いたボタンは行の中で 1 押しでは送らず、
	 * モーダルでこの確認を通してから送る。
	 */
	readonly confirm?: IParadisHumanAskConfirm;
}

/** ボタンを押す前の確認。 */
export interface IParadisHumanAskConfirm {
	readonly title: string;
	readonly body?: string;
	/** 確認のボタンの名前。 */
	readonly ok: string;
}

/** だれから（1 行）。Bot 名と項目の番号、ボードのタスクの番号と工程、スペース・worktree・エージェント名。 */
export interface IParadisHumanAskFrom {
	readonly title: string;
	readonly detail?: string;
}

/**
 * 持ち主が台帳へ知らせる 1 件。
 *
 * 答え方は欄の有無で決まる（{@link paradisHumanAskAnswerable}）:
 * - `questions` があれば、選択肢・自由入力で答える
 * - `actions` があれば、ボタンを押して答える
 * - どちらも無ければ、ここからは答えられない（元のペイン・項目・タスクへ移るだけ）
 */
export interface IParadisHumanAskInput {
	readonly source: ParadisHumanAskSource;
	/**
	 * 出どころの中の id。**1 回の問いごとに別の値**にする（同じペイン・同じタスクが次に聞くときは別の id）。
	 * 回答済みになった鍵は短い間覚えていて、遅れて届いた古い一覧で待ちに戻さないため
	 * （同じ id のまま次の問いを出すと、その間は出てこない）。
	 */
	readonly id: string;
	readonly kind: ParadisHumanAskKind;
	readonly from: IParadisHumanAskFrom;
	/** なぜ聞くかの前置き（短い 5 行までを勧める）。許可では操作の全文（コマンド・引数）を入れる。 */
	readonly preface?: string;
	/**
	 * 許可を行の中のボタンで 1 押しで答えてよい（許可リスト）。形が分かっていて、全文を切り詰めずに前置きへ入れたものにだけ
	 * 持ち主が付ける（Bash のコマンド・読むだけの道具）。付いていない許可は、モーダルで全文を見てから答える。
	 */
	readonly inlineAllowed?: boolean;
	readonly questions: readonly IParadisHumanAskQuestion[];
	readonly actions: readonly IParadisHumanAskAction[];
	/** 「飛ばす」を出すか（Bot の項目）。 */
	readonly canSkip: boolean;
	/**
	 * この問いが出ているペインの鍵（通知の台帳の paradisInboxPaneKey と同じ値）。同じペインの同じ種類の待ちが
	 * ペインとボード・Bot の両方から来たら、ボード・Bot の 1 件に寄せる。「ペインへ移動」にも使う。
	 */
	readonly paneKey?: string;
	/** ペインを持っているウィンドウ（「ペインへ移動」に使う）。 */
	readonly windowId?: number;
	/** スペースの状態キー（「ペインへ移動」に使う）。 */
	readonly stateKey?: string;
	/** 聞かれた時刻。省いたら台帳が受け取った時刻。 */
	readonly askedAt?: number;
}

// ---- 答え -------------------------------------------------------------------------------------

/**
 * 1 問への答え。選んだ選択肢か、自分で書いた文のどちらか（両方あれば文を添えた選択）。
 * 選択肢は、複数選べる問いでなければ 1 つまで。
 */
export interface IParadisHumanAskQuestionAnswer {
	readonly questionId: string;
	readonly optionIds?: readonly string[];
	readonly text?: string;
}

/**
 * 答え。
 *
 * - `answers`: 問いへの答え。答えなかった問いは入れない（持ち主が聞き直す）
 * - `action`: ボタン
 * - `skip`: 飛ばす
 */
export type ParadisHumanAskAnswer =
	| { readonly type: 'answers'; readonly answers: readonly IParadisHumanAskQuestionAnswer[] }
	| { readonly type: 'action'; readonly actionId: string; readonly text?: string }
	| { readonly type: 'skip' };

// ---- 台帳の中身 --------------------------------------------------------------------------------

/**
 * 状態。
 *
 * - `waiting`: 待ち
 * - `answered`: 回答済み（どこで・何と答えたかは {@link IParadisHumanAskEntry.resolution}）
 * - `withdrawn`: 取り下げ（エージェントが先へ進んだ、ペインが閉じた、持ち主がいなくなった）
 */
export type ParadisHumanAskState = 'waiting' | 'answered' | 'withdrawn';

export interface IParadisHumanAskResolution {
	readonly at: number;
	/** 答えた場所。持ち主が場所を知らないとき（ターミナルで答えられた等）は持ち主の既定の場所。 */
	readonly surface?: ParadisHumanAskSurface;
	/** 何と答えたか（1 行、伏せ字済み）。 */
	readonly summary?: string;
}

export interface IParadisHumanAskEntry extends IParadisHumanAskInput {
	/** 「出どころ＋id」。 */
	readonly key: string;
	/** 持ち主（shared process の中で、この 1 件を知らせてきた出どころの名前）。 */
	readonly owner: string;
	readonly askedAt: number;
	readonly state: ParadisHumanAskState;
	/**
	 * 答えを持ち主へ届けている最中。この間はほかの場所から答えられない（キー操作で答えるペインへ
	 * 二度送ると、二度目が次のプロンプトに入ってしまう）。
	 */
	readonly pending?: { readonly surface: ParadisHumanAskSurface; readonly at: number };
	/** 直前の答えが届かなかった（待ちへ戻した）。 */
	readonly failedAt?: number;
	readonly resolution?: IParadisHumanAskResolution;
	/** 同じペインの同じ種類の待ちがボード・Bot の側にもあるので、そちらに寄せた（一覧にも件数にも出さない）。 */
	readonly foldedInto?: string;
}

/** 「あなたの番」の数。同じ 1 件は鍵が同じなので、`total` は 3 つの小計の和と必ず一致する。 */
export interface IParadisHumanAskCounts {
	readonly total: number;
	readonly pane: number;
	readonly board: number;
	readonly bot: number;
}

export interface IParadisHumanAskSnapshot {
	/** 待ち（新しい順）の後ろに、少し前に回答済み・取り下げになったもの（新しい順）。 */
	readonly entries: readonly IParadisHumanAskEntry[];
	readonly counts: IParadisHumanAskCounts;
	/** 台帳が変わるたびに増える番号。遅れて届いた古いスナップショットを見分けるのに使う。 */
	readonly revision: number;
}

export const EMPTY_PARADIS_HUMAN_ASK_SNAPSHOT: IParadisHumanAskSnapshot = Object.freeze({
	entries: [],
	counts: Object.freeze({ total: 0, pane: 0, board: 0, bot: 0 }),
	revision: 0,
});

/** 答えを届けてほしいという、持ち主への依頼。 */
export interface IParadisHumanAskAnswerRequest {
	/** この依頼の番号。持ち主は結果を知らせるときにこれを返す（遅れて届いた別の依頼の結果と取り違えないため）。 */
	readonly claim: string;
	readonly key: string;
	readonly owner: string;
	readonly source: ParadisHumanAskSource;
	readonly id: string;
	readonly paneKey?: string;
	readonly windowId?: number;
	readonly answer: ParadisHumanAskAnswer;
	readonly surface: ParadisHumanAskSurface;
}

/** 答えようとした結果。`busy` はほかの場所が先に答えて届けている最中、`gone` はもう待っていない。 */
export type ParadisHumanAskAnswerResult =
	| { readonly ok: true; readonly request: IParadisHumanAskAnswerRequest }
	| { readonly ok: false; readonly reason: 'gone' | 'busy' | 'invalid' };

// ---- renderer 側のサービス ---------------------------------------------------------------------

/** 答えようとした結果（ウィンドウ側）。`unavailable` は shared process に届かなかった。 */
export type ParadisHumanAskClientResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'gone' | 'busy' | 'invalid' | 'unavailable' };

export const IParadisHumanAskService = createDecorator<IParadisHumanAskService>('paradisHumanAskService');

/**
 * 台帳の renderer 側の窓口。読み取りは手元に写した最新のスナップショットを返す（台帳が変わるたびに
 * shared process から届く）。書き込めるのは答えだけ。
 */
export interface IParadisHumanAskService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly snapshot: IParadisHumanAskSnapshot;
	/**
	 * 答える。`ok` は「持ち主へ届ける依頼を出した」で、届いたかどうかはスナップショットで分かる
	 * （回答済みになるか、`failedAt` が付いて待ちへ戻る）。
	 */
	answer(key: string, answer: ParadisHumanAskAnswer, surface?: 'inbox' | 'bot'): Promise<ParadisHumanAskClientResult>;
}

// ---- 補助 -------------------------------------------------------------------------------------

export function paradisHumanAskKey(source: ParadisHumanAskSource, id: string): string {
	return `${source}:${id}`;
}

/** ここから答えられるか（問いかボタンがあるか）。false なら「ペインへ移動」「項目を開く」だけを出す。 */
export function paradisHumanAskAnswerable(entry: Pick<IParadisHumanAskInput, 'questions' | 'actions'>): boolean {
	return entry.questions.length > 0 || entry.actions.length > 0;
}

/** 件数に数えるか（待ちで、ほかの 1 件に寄せていないもの）。 */
export function paradisHumanAskCounted(entry: Pick<IParadisHumanAskEntry, 'state' | 'foldedInto'>): boolean {
	return entry.state === 'waiting' && entry.foldedInto === undefined;
}

/** 件数の式。ベル・Dock は `total`、「タスク」ボタンは `board`、「Bot」は `bot` を出す。 */
export function paradisHumanAskCounts(entries: readonly Pick<IParadisHumanAskEntry, 'state' | 'foldedInto' | 'source'>[]): IParadisHumanAskCounts {
	const counts = { total: 0, pane: 0, board: 0, bot: 0 };
	for (const entry of entries) {
		if (paradisHumanAskCounted(entry)) {
			counts[entry.source]++;
			counts.total++;
		}
	}
	return counts;
}

function oneLine(value: string, limit: number): string {
	const collapsed = value.replace(/\s+/g, ' ').trim();
	// allow-any-unicode-next-line
	return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/**
 * 「何と答えたか」の 1 行（選んだ選択肢・押したボタンの名前、自分で書いた文）。ほかの場所の
 * 「スマホで回答済み: …」に出すので、自分で書いた文には伏せ字を掛ける。
 */
export function paradisHumanAskAnswerSummary(entry: Pick<IParadisHumanAskInput, 'questions' | 'actions'>, answer: ParadisHumanAskAnswer): string | undefined {
	if (answer.type === 'skip') {
		return undefined;
	}
	const parts: string[] = [];
	if (answer.type === 'action') {
		const action = entry.actions.find(candidate => candidate.id === answer.actionId);
		if (action) {
			parts.push(action.label);
		}
		if (answer.text) {
			parts.push(paradisRedactTextSecrets(answer.text));
		}
	} else {
		for (const item of answer.answers) {
			const question = entry.questions.find(candidate => candidate.id === item.questionId);
			for (const option of question?.options ?? []) {
				if (item.optionIds?.includes(option.id)) {
					parts.push(option.label);
				}
			}
			if (item.text) {
				parts.push(paradisRedactTextSecrets(item.text));
			}
		}
	}
	// allow-any-unicode-next-line
	const summary = oneLine(parts.join(' ／ '), SUMMARY_LIMIT);
	return summary.length > 0 ? summary : undefined;
}

// ---- 検め -------------------------------------------------------------------------------------
//
// 台帳は全ウィンドウへ配られ、のちにスマホへも出る。持ち主から来た値はここで形を確かめ、長さを切り、
// 表示する文には伏せ字を掛ける（通知の台帳と同じ規則）。答えの本文は持ち主へそのまま届けるので伏せない。

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function identifier(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= ID_LIMIT ? value : undefined;
}

function shown(value: unknown, limit: number): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const redacted = paradisRedactTextSecrets(value.slice(0, limit)).trim();
	return redacted.length > 0 ? redacted : undefined;
}

function sanitizeOptions(value: unknown, limit: number): IParadisHumanAskOption[] | undefined {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > limit) {
		return undefined;
	}
	const ids = new Set<string>();
	const options: IParadisHumanAskOption[] = [];
	let recommended = false;
	for (const item of value) {
		const input = record(item);
		const id = identifier(input?.id);
		const label = shown(input?.label, LABEL_LIMIT);
		if (input === undefined || id === undefined || label === undefined || ids.has(id)) {
			return undefined;
		}
		ids.add(id);
		const detail = shown(input.detail, LABEL_LIMIT);
		const isRecommended: boolean = input.recommended === true && !recommended;
		recommended = recommended || isRecommended;
		options.push({ id, label, ...(detail !== undefined ? { detail } : {}), ...(isRecommended ? { recommended: true } : {}) });
	}
	return options;
}

function sanitizeQuestions(value: unknown, optionLimit: number): IParadisHumanAskQuestion[] | undefined {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > PARADIS_HUMAN_ASK_QUESTION_LIMIT) {
		return undefined;
	}
	const ids = new Set<string>();
	const questions: IParadisHumanAskQuestion[] = [];
	for (const item of value) {
		const input = record(item);
		const id = identifier(input?.id);
		const text = shown(input?.text, QUESTION_TEXT_LIMIT);
		const options = sanitizeOptions(input?.options, optionLimit);
		if (input === undefined || id === undefined || text === undefined || options === undefined || ids.has(id)) {
			return undefined;
		}
		ids.add(id);
		// 選択肢の無い問いは自由入力でしか答えられないので、必ず書けるようにする
		questions.push({ id, text, options, allowText: input.allowText === true || options.length === 0, ...(input.multiSelect === true && options.length > 0 ? { multiSelect: true } : {}) });
	}
	return questions;
}

/** 確認の文を検める。形が違えば false（その 1 件ごと断る。確認を落として 1 押しで送れるようにはしない）。 */
function sanitizeConfirm(value: unknown): IParadisHumanAskConfirm | false {
	const input = record(value);
	const title = shown(input?.title, TITLE_LIMIT);
	const ok = shown(input?.ok, TITLE_LIMIT);
	const body = input?.body === undefined ? undefined : shown(input.body, LABEL_LIMIT);
	if (title === undefined || ok === undefined || (input?.body !== undefined && body === undefined)) {
		return false;
	}
	return { title, ...(body !== undefined ? { body } : {}), ok };
}

function sanitizeActions(value: unknown): IParadisHumanAskAction[] | undefined {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > PARADIS_HUMAN_ASK_ACTION_LIMIT) {
		return undefined;
	}
	const ids = new Set<string>();
	const actions: IParadisHumanAskAction[] = [];
	for (const item of value) {
		const input = record(item);
		const id = identifier(input?.id);
		const label = shown(input?.label, LABEL_LIMIT);
		if (input === undefined || id === undefined || label === undefined || ids.has(id)) {
			return undefined;
		}
		const confirm = input.confirm === undefined ? undefined : sanitizeConfirm(input.confirm);
		if (confirm === false) {
			return undefined;
		}
		ids.add(id);
		actions.push({ id, label, ...(input.allowText === true ? { allowText: true } : {}), ...(confirm ? { confirm } : {}) });
	}
	return actions;
}

/**
 * 持ち主から来た 1 件を検める。形が合わない・上限を超えるものは undefined（台帳に入れない）。
 * 上限を超えた分を黙って切ると、選べない選択肢のある問いができるので、切らずに断る。
 */
export function paradisSanitizeHumanAskInput(value: unknown): IParadisHumanAskInput | undefined {
	const input = record(value);
	if (input === undefined) {
		return undefined;
	}
	const source = PARADIS_HUMAN_ASK_SOURCES.find(candidate => candidate === input.source);
	const kind = PARADIS_HUMAN_ASK_KINDS.find(candidate => candidate === input.kind);
	const id = identifier(input.id);
	const from = record(input.from);
	const title = shown(from?.title, TITLE_LIMIT);
	if (source === undefined || kind === undefined || id === undefined || title === undefined) {
		return undefined;
	}
	const questions = sanitizeQuestions(input.questions, source === 'board' ? PARADIS_HUMAN_ASK_BOARD_OPTION_LIMIT : PARADIS_HUMAN_ASK_OPTION_LIMIT);
	const actions = sanitizeActions(input.actions);
	if (questions === undefined || actions === undefined) {
		return undefined;
	}
	const detail = shown(from?.detail, TITLE_LIMIT);
	const preface = shown(input.preface, PREFACE_LIMIT);
	const paneKey = identifier(input.paneKey);
	const stateKey = identifier(input.stateKey);
	return {
		source,
		id,
		kind,
		from: { title, ...(detail !== undefined ? { detail } : {}) },
		...(preface !== undefined ? { preface } : {}),
		...(input.inlineAllowed === true ? { inlineAllowed: true } : {}),
		questions,
		actions,
		canSkip: input.canSkip === true,
		...(paneKey !== undefined ? { paneKey } : {}),
		...(typeof input.windowId === 'number' && Number.isSafeInteger(input.windowId) ? { windowId: input.windowId } : {}),
		...(stateKey !== undefined ? { stateKey } : {}),
		...(typeof input.askedAt === 'number' && Number.isFinite(input.askedAt) && input.askedAt > 0 ? { askedAt: input.askedAt } : {}),
	};
}

function answerText(value: unknown): string | undefined | false {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string' || value.length > PARADIS_HUMAN_ASK_ANSWER_TEXT_LIMIT) {
		return false;
	}
	return value.trim().length > 0 ? value : undefined;
}

/** 選んだ選択肢を検める（その問いにある id だけ、重複なし、複数選べない問いは 1 つまで）。合わなければ undefined。 */
function answerOptionIds(question: IParadisHumanAskQuestion, value: unknown): string[] | undefined {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > (question.multiSelect ? question.options.length : 1)) {
		return undefined;
	}
	const chosen = new Set<string>();
	for (const id of value) {
		if (typeof id !== 'string' || chosen.has(id) || !question.options.some(option => option.id === id)) {
			return undefined;
		}
		chosen.add(id);
	}
	// 問いの選択肢の順に並べ直す（押した順で要約や打鍵が変わらないように）
	return question.options.filter(option => chosen.has(option.id)).map(option => option.id);
}

/**
 * 答えを、その 1 件の問い・選択肢・ボタンと突き合わせて検める。無い選択肢・書けない問いへの文・
 * 出していない「飛ばす」は断る（undefined）。答えの文は伏せずにそのまま返す（持ち主へ届ける本文）。
 */
export function paradisSanitizeHumanAskAnswer(entry: Pick<IParadisHumanAskInput, 'questions' | 'actions' | 'canSkip'>, value: unknown): ParadisHumanAskAnswer | undefined {
	const input = record(value);
	if (input === undefined) {
		return undefined;
	}
	if (input.type === 'skip') {
		return entry.canSkip ? { type: 'skip' } : undefined;
	}
	if (input.type === 'action') {
		const action = entry.actions.find(candidate => candidate.id === input.actionId);
		const text = answerText(input.text);
		if (action === undefined || text === false || (text !== undefined && action.allowText !== true)) {
			return undefined;
		}
		return { type: 'action', actionId: action.id, ...(text !== undefined ? { text } : {}) };
	}
	if (input.type !== 'answers' || !Array.isArray(input.answers) || input.answers.length === 0 || input.answers.length > entry.questions.length) {
		return undefined;
	}
	const seen = new Set<string>();
	const answers: IParadisHumanAskQuestionAnswer[] = [];
	for (const item of input.answers) {
		const answer = record(item);
		const question = entry.questions.find(candidate => candidate.id === answer?.questionId);
		const text = answerText(answer?.text);
		if (answer === undefined || question === undefined || seen.has(question.id) || text === false || (text !== undefined && !question.allowText)) {
			return undefined;
		}
		const optionIds = answerOptionIds(question, answer.optionIds);
		if (optionIds === undefined || (optionIds.length === 0 && text === undefined)) {
			return undefined;
		}
		seen.add(question.id);
		answers.push({ questionId: question.id, ...(optionIds.length > 0 ? { optionIds } : {}), ...(text !== undefined ? { text } : {}) });
	}
	return { type: 'answers', answers };
}

/** 持ち主が渡した「何と答えたか」を 1 行・伏せ字済みにする。空なら undefined。 */
export function paradisSanitizeHumanAskSummary(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const summary = oneLine(paradisRedactTextSecrets(value.slice(0, PARADIS_HUMAN_ASK_ANSWER_TEXT_LIMIT)), SUMMARY_LIMIT);
	return summary.length > 0 ? summary : undefined;
}

export function paradisSanitizeHumanAskSurface(value: unknown): ParadisHumanAskSurface | undefined {
	return PARADIS_HUMAN_ASK_SURFACES.find(candidate => candidate === value);
}
