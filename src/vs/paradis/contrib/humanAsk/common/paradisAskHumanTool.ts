/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP の `ask_human`（どのペインのエージェントからでも人に聞ける道具）の契約。I/O を持たない。
//
// 形は Orca の Needs you に揃える（問い 5・選択肢 8・おすすめ 1 つ・問いは 1 行 140 字未満を勧める）。
// 問いは「人が答えるもの」の台帳へ 1 件として載り、受信箱（とのちのスマホ・ボード）から答えられる。答えは
// そのペインのエージェントへ次の発言として届く（PC のチャット表示と同じ入力の口。新しい注入の口は作らない）。
//
// 守り:
//  - 種類は必ず「質問」、ボタン（許可・拒否など）は付けない。だれから（スペース・タブ）は Para Code が引く。
//    エージェントが書けるのは前置き・問い・選択肢の文だけ
//  - 文から制御文字・書字方向の制御・幅のない文字を除く。上限を超えたものは切らずに断る（切ると選べない
//    選択肢や意味の変わった問いができる）

import type { IParadisMcpToolDefinition } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisHumanAskInput, IParadisHumanAskQuestion, ParadisHumanAskAnswer } from './paradisHumanAsk.js';

export const PARADIS_ASK_HUMAN_TOOL = 'ask_human';
/** 台帳の持ち主の名前。 */
export const PARADIS_ASK_HUMAN_OWNER = 'askHuman';
/** shared process → ウィンドウ（答えを届ける依頼と、その結果）。形は paradisHumanAskPane.ts の口と同じ。 */
export const PARADIS_ASK_HUMAN_CHANNEL = 'paradisAskHuman';
/** ウィンドウ側のチャネル（呼び出し元ペインの名札を引く）。 */
export const PARADIS_ASK_HUMAN_WINDOW_CHANNEL = 'paradisAskHumanWindow';
export const PARADIS_ASK_HUMAN_DESCRIBE_METHOD = 'describePane';

export const PARADIS_ASK_HUMAN_LIMITS = Object.freeze({
	questions: 5,
	options: 8,
	/** 問いの長さの上限（Orca と同じ）。勧めは {@link PARADIS_ASK_HUMAN_QUESTION_ADVICE} 字未満。 */
	question: 500,
	label: 150,
	detail: 500,
	context: 2000,
});

/** 問いの長さの勧め（Orca の指示文と同じ）。超えても断らず、勧めを 1 つ返すだけ。 */
export const PARADIS_ASK_HUMAN_QUESTION_ADVICE = 140;
/** 前置きの行数の勧め。 */
const CONTEXT_ADVICE_LINES = 5;

/** 1 ペインから 1 分間に出せる問いの数。 */
export const PARADIS_ASK_HUMAN_RATE_PER_MINUTE = 6;

export const PARADIS_ASK_HUMAN_TOOL_DEFINITION: IParadisMcpToolDefinition = {
	name: PARADIS_ASK_HUMAN_TOOL,
	description: 'Ask the person a question that they can answer from the Para Code inbox, even when they are not watching this terminal. '
		+ 'If you have a built-in tool for asking the user (Claude Code\'s AskUserQuestion), use that instead: Para Code shows those questions in its inbox too. '
		+ 'In a terminal started from the Para Code task board, use board_ask_human. '
		+ 'Use this for decisions only the person can make. Up to 5 questions with up to 8 options each; one line under 140 characters per question, ending in "?". Put the why in context (a few short lines). '
		+ 'The person picks an option or answers in their own words. The answer arrives later as the user\'s next message, so end your turn after calling this and wait. '
		+ 'A new call replaces your earlier question if it is still unanswered.',
	inputSchema: {
		type: 'object',
		properties: {
			context: { type: 'string', description: 'Why you ask: a few short lines shown above the questions.' },
			questions: {
				type: 'array',
				minItems: 1,
				maxItems: PARADIS_ASK_HUMAN_LIMITS.questions,
				items: {
					type: 'object',
					properties: {
						question: { type: 'string', description: 'One decision, one line under 140 characters, ending in "?". Use plain words, not hashes or ids.' },
						options: {
							type: 'array',
							maxItems: PARADIS_ASK_HUMAN_LIMITS.options,
							items: {
								type: 'object',
								properties: {
									label: { type: 'string' },
									description: { type: 'string' },
								},
								required: ['label'],
								additionalProperties: false,
							},
						},
						recommended: { type: 'integer', minimum: 0, description: 'Index of the option you recommend.' },
						multi_select: { type: 'boolean', description: 'Whether the person may pick several options.' },
						allow_text: { type: 'boolean', description: 'Whether the person may answer in their own words (default true).' },
					},
					required: ['question'],
					additionalProperties: false,
				},
			},
		},
		required: ['questions'],
		additionalProperties: false,
	},
};

// ---- 引数 ------------------------------------------------------------------------------------

export interface IParadisAskHumanOptionArg {
	readonly label: string;
	readonly description?: string;
}

export interface IParadisAskHumanQuestionArg {
	readonly question: string;
	readonly options: readonly IParadisAskHumanOptionArg[];
	readonly recommended?: number;
	readonly multiSelect: boolean;
	readonly allowText: boolean;
}

export interface IParadisAskHumanArgs {
	readonly context?: string;
	readonly questions: readonly IParadisAskHumanQuestionArg[];
}

export type ParadisAskHumanParsed = { readonly ok: true; readonly value: IParadisAskHumanArgs } | { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 表示を偽れる文字（C0・C1 の制御文字、ESC、書字方向の制御、幅のない文字）。 */
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/**
 * 表示する文を整える。`multiline` でなければ改行・タブを空白にして 1 行にする。整えた後に空なら undefined、
 * 上限を超えたら false（切らずに断る）。
 */
export function paradisAskHumanCleanText(value: unknown, limit: number, multiline: boolean): string | undefined | false {
	if (typeof value !== 'string') {
		return undefined;
	}
	let text = value.toWellFormed().replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(UNSAFE_CHARACTERS, '');
	text = multiline ? text.replace(/[  ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : text.replace(/\s+/g, ' ').trim();
	if (text.length === 0) {
		return undefined;
	}
	return text.length > limit ? false : text;
}

/** `ask_human` の引数を検める。合わなければエージェントへ返す英文。 */
export function paradisParseAskHumanArgs(args: unknown): ParadisAskHumanParsed {
	const fail = (message: string): ParadisAskHumanParsed => ({ ok: false, message });
	if (!isRecord(args)) {
		return fail('Arguments must be an object.');
	}
	for (const key of Object.keys(args)) {
		if (key !== 'context' && key !== 'questions') {
			return fail(`Unknown argument "${key.slice(0, 40)}". Pass context and questions.`);
		}
	}
	let context: string | undefined;
	if (args.context !== undefined) {
		const cleaned = paradisAskHumanCleanText(args.context, PARADIS_ASK_HUMAN_LIMITS.context, true);
		if (cleaned === false) {
			return fail(`context must be up to ${PARADIS_ASK_HUMAN_LIMITS.context} characters. Keep it to a few short lines.`);
		}
		context = cleaned;
	}
	if (!Array.isArray(args.questions) || args.questions.length === 0 || args.questions.length > PARADIS_ASK_HUMAN_LIMITS.questions) {
		return fail(`questions must be an array of 1 to ${PARADIS_ASK_HUMAN_LIMITS.questions} questions.`);
	}
	const questions: IParadisAskHumanQuestionArg[] = [];
	const seenQuestions = new Set<string>();
	for (const [index, item] of args.questions.entries()) {
		const at = `questions[${index}]`;
		if (!isRecord(item)) {
			return fail(`${at} must be an object with a question.`);
		}
		for (const key of Object.keys(item)) {
			if (!['question', 'options', 'recommended', 'multi_select', 'allow_text'].includes(key)) {
				return fail(`${at} has an unknown field "${key.slice(0, 40)}".`);
			}
		}
		const question = paradisAskHumanCleanText(item.question, PARADIS_ASK_HUMAN_LIMITS.question, false);
		if (question === undefined || question === false) {
			return fail(`${at}.question must be a non-empty string of up to ${PARADIS_ASK_HUMAN_LIMITS.question} characters.`);
		}
		if (seenQuestions.has(question)) {
			return fail('Each question needs its own text.');
		}
		seenQuestions.add(question);
		if (item.options !== undefined && (!Array.isArray(item.options) || item.options.length > PARADIS_ASK_HUMAN_LIMITS.options)) {
			return fail(`${at}.options must be an array of up to ${PARADIS_ASK_HUMAN_LIMITS.options} options.`);
		}
		const options: IParadisAskHumanOptionArg[] = [];
		const seenLabels = new Set<string>();
		for (const [optionIndex, option] of (item.options as unknown[] | undefined ?? []).entries()) {
			const where = `${at}.options[${optionIndex}]`;
			if (!isRecord(option) || Object.keys(option).some(key => key !== 'label' && key !== 'description')) {
				return fail(`${where} must be an object with a label and an optional description.`);
			}
			const label = paradisAskHumanCleanText(option.label, PARADIS_ASK_HUMAN_LIMITS.label, false);
			if (label === undefined || label === false) {
				return fail(`${where}.label must be a non-empty string of up to ${PARADIS_ASK_HUMAN_LIMITS.label} characters.`);
			}
			if (seenLabels.has(label)) {
				return fail(`Each option of ${at} needs its own label.`);
			}
			seenLabels.add(label);
			const description = paradisAskHumanCleanText(option.description, PARADIS_ASK_HUMAN_LIMITS.detail, false);
			if (description === false || (option.description !== undefined && typeof option.description !== 'string')) {
				return fail(`${where}.description must be a string of up to ${PARADIS_ASK_HUMAN_LIMITS.detail} characters.`);
			}
			options.push({ label, ...(description !== undefined ? { description } : {}) });
		}
		if (item.recommended !== undefined && (typeof item.recommended !== 'number' || !Number.isInteger(item.recommended) || item.recommended < 0 || item.recommended >= options.length)) {
			return fail(`${at}.recommended must be the index of one of its options.`);
		}
		if ((item.multi_select !== undefined && typeof item.multi_select !== 'boolean') || (item.allow_text !== undefined && typeof item.allow_text !== 'boolean')) {
			return fail(`${at}.multi_select and ${at}.allow_text must be booleans.`);
		}
		const allowText = item.allow_text !== false;
		if (!allowText && options.length === 0) {
			return fail(`${at} has no options, so the person must be allowed to answer in their own words.`);
		}
		questions.push({
			question,
			options,
			...(typeof item.recommended === 'number' ? { recommended: item.recommended } : {}),
			multiSelect: item.multi_select === true && options.length > 1,
			allowText,
		});
	}
	return { ok: true, value: { ...(context !== undefined ? { context } : {}), questions } };
}

/**
 * 読みにくい問いへの勧め（Orca の Tip と同じく 1 つだけ。問いはもう出ているので、書き直しは任意）。
 * 勧めが無ければ undefined。
 */
export function paradisAskHumanAdvice(args: IParadisAskHumanArgs): string | undefined {
	if (args.questions.some(question => question.question.length >= PARADIS_ASK_HUMAN_QUESTION_ADVICE)) {
		return `Tip: keep each question to one line under ${PARADIS_ASK_HUMAN_QUESTION_ADVICE} characters; put the why in context.`;
	}
	if (args.questions.some(question => !/[?？]$/.test(question.question))) {
		return 'Tip: write each question as a question that ends in a question mark.';
	}
	if (args.context !== undefined && args.context.split('\n').length > CONTEXT_ADVICE_LINES) {
		return `Tip: keep context to ${CONTEXT_ADVICE_LINES} short lines or fewer; put longer details in a file and name it.`;
	}
	return undefined;
}

// ---- 台帳の 1 件 -------------------------------------------------------------------------------

/** 呼び出し元ペインの名札（ペインを持っているウィンドウが答える）。 */
export interface IParadisAskHumanPaneLabel {
	readonly windowId: number;
	readonly stateKey?: string;
	readonly space: string;
	readonly worktree?: string;
	readonly tab?: string;
}

/** ウィンドウから来た名札を検める。 */
export function paradisSanitizeAskHumanPaneLabel(value: unknown): IParadisAskHumanPaneLabel | undefined {
	if (!isRecord(value) || typeof value.windowId !== 'number' || !Number.isSafeInteger(value.windowId)) {
		return undefined;
	}
	const space = paradisAskHumanCleanText(value.space, 200, false);
	if (space === undefined || space === false) {
		return undefined;
	}
	const optional = (input: unknown, limit: number) => {
		const cleaned = paradisAskHumanCleanText(input, limit, false);
		return typeof cleaned === 'string' ? cleaned : undefined;
	};
	const worktree = optional(value.worktree, 200);
	const tab = optional(value.tab, 200);
	const stateKey = typeof value.stateKey === 'string' && value.stateKey.length > 0 && value.stateKey.length <= 400 ? value.stateKey : undefined;
	return { windowId: value.windowId, space, ...(stateKey !== undefined ? { stateKey } : {}), ...(worktree !== undefined ? { worktree } : {}), ...(tab !== undefined ? { tab } : {}) };
}

/** 道具の引数とペインの名札から、台帳へ載せる 1 件を作る。種類は質問、ボタンは無し。 */
export function paradisAskHumanLedgerInput(id: string, paneKey: string, label: IParadisAskHumanPaneLabel, agentName: string | undefined, args: IParadisAskHumanArgs, askedAt: number): IParadisHumanAskInput {
	const detail = [label.worktree !== undefined && label.worktree !== label.space ? label.worktree : undefined, label.tab, agentName].filter((part): part is string => !!part).join(' ／ ');
	const questions: IParadisHumanAskQuestion[] = args.questions.map((question, index) => ({
		id: `q${index}`,
		text: question.question,
		options: question.options.map((option, optionIndex) => ({
			id: String(optionIndex),
			label: option.label,
			...(option.description !== undefined ? { detail: option.description } : {}),
			...(question.recommended === optionIndex ? { recommended: true } : {}),
		})),
		allowText: question.allowText,
		...(question.multiSelect ? { multiSelect: true } : {}),
	}));
	return {
		source: 'pane',
		id,
		kind: 'question',
		from: { title: label.space, ...(detail.length > 0 ? { detail } : {}) },
		...(args.context !== undefined ? { preface: args.context } : {}),
		questions,
		actions: [],
		canSkip: false,
		paneKey,
		windowId: label.windowId,
		...(label.stateKey !== undefined ? { stateKey: label.stateKey } : {}),
		askedAt,
	};
}

// ---- 答え ------------------------------------------------------------------------------------

/**
 * 台帳の答えを、エージェントへ送る次の発言にする。問いと答えを 1 組ずつ並べる。答えの文は人が書いたもので、
 * そのまま渡す（送る口が制御文字を落とす）。`oneLine` なら改行を空白にして 1 行にする（複数行の文を受けない CLI）。
 * 答えが 1 つも無ければ undefined。
 */
export function paradisAskHumanAnswerMessage(entry: Pick<IParadisHumanAskInput, 'questions'>, answer: ParadisHumanAskAnswer, oneLine = false): string | undefined {
	if (answer.type !== 'answers') {
		return undefined;
	}
	const lines: string[] = [];
	for (const question of entry.questions) {
		const item = answer.answers.find(candidate => candidate.questionId === question.id);
		if (item === undefined) {
			continue;
		}
		const chosen = question.options.filter(option => item.optionIds?.includes(option.id)).map(option => option.label);
		const parts = [...chosen, ...(item.text !== undefined ? [item.text.trim()] : [])].filter(part => part.length > 0);
		if (parts.length === 0) {
			continue;
		}
		lines.push(`Q: ${question.text}`, `A: ${parts.join(', ')}`);
	}
	if (lines.length === 0) {
		return undefined;
	}
	const message = [`The person answered your ${PARADIS_ASK_HUMAN_TOOL} question in Para Code:`, ...lines];
	return oneLine ? message.join(' ').replace(/\s+/g, ' ').trim() : message.join('\n');
}
