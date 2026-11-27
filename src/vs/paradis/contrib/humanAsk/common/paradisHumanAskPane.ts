/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ペインの質問・許可を「人が答えるもの」の台帳の 1 件へ写す規則と、台帳の答えをペインへの回答へ戻す規則。
// どちらも純粋な関数で、shared process の持ち主（node/paradisHumanAskPaneOwner.ts）が使う。
//
// 受信箱から押せるものは、スマホの許可カードより緩くしない:
//  - 許可のボタンは id が `yes`・`no` の 2 つだけを載せる（「以後は確認しない」はペインで答える）
//  - 端末の確認の画面でしか許可できない承認・読むだけの印の付いた承認・時間切れの承認・Codex の MCP のツールの許可・
//    キーで答えられない種類（OpenCode・Antigravity CLI）は、問いもボタンも空にする（「ペインへ移動」だけになる）
//  - 質問は全問に答えたときだけ届ける（ターミナルの質問の画面は 1 問だけを飛ばせない）

import { IParadisAgentChatMessage, IParadisAgentInteraction, paradisAgentQuestionHasPreview, paradisIsCodexDaemonApprovalInteraction } from '../../agentChat/common/paradisAgentChat.js';
import { paradisAgentDescriptor } from '../../agentChat/common/paradisAgentDescriptor.js';
import type { IParadisAgentApprovalRequest } from '../../mobileRelay/common/paradisAgentApprovalRequest.js';
import type { ParadisAgentQuestionAnswer } from '../../mobileRelay/common/paradisAgentQuestionKeys.js';
import { IParadisHumanAskInput, ParadisHumanAskAnswer, paradisSanitizeHumanAskInput } from './paradisHumanAsk.js';

export const PARADIS_HUMAN_ASK_PANES_CHANNEL = 'paradisHumanAskPanes';
/** 台帳の持ち主の名前（ペインの分）。 */
export const PARADIS_HUMAN_ASK_PANE_OWNER = 'panes';

/** 中継（shared process）が持っている、あるペインの今の待ち。ペインのトークンは載せない。 */
export interface IParadisHumanAskPaneState {
	/** ペインの鍵（通知の台帳の paradisInboxPaneKey と同じ、トークンのハッシュ）。 */
	readonly paneKey: string;
	readonly agent: string;
	/** 会話の読み取りの世代（中継の tailer の epoch）。 */
	readonly epoch: string;
	readonly interaction: IParadisAgentInteraction;
	/** `interaction` が質問のとき、その質問群（TUI の質問順）。 */
	readonly questions: readonly IParadisAgentChatMessage[];
	/** 端末の確認の画面でしか許可できない承認（スマホの許可を断るのと同じ判定）。 */
	readonly personOnly: boolean;
}

/** 中継の読むだけの口。 */
export interface IParadisHumanAskPaneSource {
	/** ペインの様子を確かめ直した（変わっていないこともある）。 */
	readonly onDidChange: (listener: () => void) => { dispose(): void };
	read(): readonly IParadisHumanAskPaneState[];
}

/** ペインの名札（スペース・worktree・タブ）と持っているウィンドウ。通知の台帳の、そのペインのいちばん新しい記録から引く。 */
export interface IParadisHumanAskPaneLabel {
	readonly windowId: number;
	readonly stateKey?: string;
	readonly space: string;
	readonly worktree?: string;
	readonly tab?: string;
}

/** ペインを持っているウィンドウへの、回答を届ける依頼。トークンは載せない（ウィンドウが `paneKey` から引く）。 */
export interface IParadisHumanAskPaneAnswerRequest {
	readonly claim: string;
	readonly key: string;
	readonly paneKey: string;
	readonly windowId: number;
	readonly interactionId: string;
	readonly delivery: ParadisHumanAskPaneDelivery;
}

export type ParadisHumanAskPaneDelivery =
	| { readonly kind: 'question'; readonly answers: readonly ParadisAgentQuestionAnswer[] }
	| { readonly kind: 'approval'; readonly choiceId: 'yes' | 'no' }
	/** `ask_human` の答え。次の発言として送る（paradisAskHumanTool.ts）。 */
	| { readonly kind: 'message'; readonly text: string };

/** 台帳の id。1 回の問いごとに別の値になる（中継の対話の id は 1 回ごとに別。世代も入れて、読み直しの前後を混ぜない）。 */
export function paradisHumanAskPaneId(paneKey: string, epoch: string, interactionId: string): string {
	return `${paneKey}:${epoch}:${interactionId}`;
}

function routeHasKeys(routes: readonly string[] | undefined): boolean {
	return routes?.includes('keys') === true;
}

const PREFACE_LIMIT = 16_000;

/**
 * ペインの今の待ちを、台帳へ知らせる 1 件にする。形が台帳の上限に収まらない問い（6 問以上・選択肢 9 つ以上）は、
 * 問いを空にして「ペインへ移動」だけの 1 件にする。
 */
export function paradisHumanAskPaneInput(state: IParadisHumanAskPaneState, label: IParadisHumanAskPaneLabel): IParadisHumanAskInput | undefined {
	const descriptor = paradisAgentDescriptor(state.agent);
	const interaction = state.interaction;
	const paneKey = state.paneKey;
	// allow-any-unicode-next-line
	const detail = [label.worktree !== undefined && label.worktree !== label.space ? label.worktree : undefined, label.tab, descriptor?.displayName].filter((part): part is string => !!part).join(' ／ ');
	const base = {
		source: 'pane' as const,
		id: paradisHumanAskPaneId(paneKey, state.epoch, interaction.id),
		from: { title: label.space, ...(detail.length > 0 ? { detail } : {}) },
		canSkip: false,
		paneKey,
		windowId: label.windowId,
		...(label.stateKey !== undefined ? { stateKey: label.stateKey } : {}),
	};
	if (interaction.kind === 'question') {
		const first = state.questions[0];
		const questions = routeHasKeys(descriptor?.answerQuestion) ? state.questions.map((question, index) => ({
			id: String(index),
			text: question.text,
			options: (question.options ?? []).map((option, optionIndex) => ({ id: String(optionIndex), label: option.label, ...(option.description ? { detail: option.description } : {}) })),
			// preview のある質問には「その他」の行が無く、自由入力はキーで渡せない
			allowText: !paradisAgentQuestionHasPreview(question),
			...(question.multiSelect === true ? { multiSelect: true } : {}),
		})) : [];
		const askedAt = first?.ts;
		const input = { ...base, kind: 'question' as const, questions, actions: [], ...(askedAt !== undefined ? { askedAt } : {}) };
		const answerable = questions.length > 0 ? paradisSanitizeHumanAskInput(input) : undefined;
		if (answerable !== undefined) {
			return answerable;
		}
		// ここからは答えられない質問。何を聞いているのかは前置きに出す
		const preface = state.questions.map(question => question.text).join('\n').slice(0, PREFACE_LIMIT);
		return paradisSanitizeHumanAskInput({ ...input, questions: [], ...(preface.length > 0 ? { preface } : {}) });
	}
	const mcpOnCodex = state.agent === 'codex' && (interaction.request?.mcpServer !== undefined || interaction.request?.tool.startsWith('mcp__') === true);
	const pressable = routeHasKeys(descriptor?.answerApproval) && !state.personOnly && interaction.answerOn !== 'pc' && interaction.readOnly !== true
		&& interaction.expired !== true && !paradisIsCodexDaemonApprovalInteraction(interaction.id) && !mcpOnCodex;
	const allow = interaction.choices?.find(choice => choice.id === 'yes');
	const deny = interaction.choices?.find(choice => choice.id === 'no');
	const request = interaction.request;
	// 中継の側で中身が切られている許可は、全文を見せられないので受信箱からは答えさせない（ペインで答える）
	const complete = request?.truncated !== true;
	const actions = pressable && complete && allow !== undefined && deny !== undefined ? [{ id: 'yes', label: allow.label }, { id: 'no', label: deny.label }] : [];
	// request の無い承認は何をするのか分からない。そのことを先に出し、エージェントの説明は後ろに添えるだけにする
	const unknown = [interaction.detail ?? interaction.title].filter((text): text is string => !!text).map(text => `（説明: ${text}）`);
	// allow-any-unicode-next-line
	const preface = (request !== undefined ? paradisHumanAskApprovalText(request) : ['操作の中身が分かりません。ペインで確かめてから答えてください', ...unknown].join('\n')).slice(0, PREFACE_LIMIT);
	// 行の中で 1 押しで許可してよいのは、形が分かっていて全文を出せるものだけ（危険の札・長さは受信箱が前置きから決める）
	// （request の無い承認は形が分からないので、モーダルで答える）
	const inlineAllowed = request !== undefined && complete && actions.length > 0 && (request.kind === 'bash' || (request.kind === 'other' && PARADIS_READ_ONLY_TOOLS.has(request.tool)));
	return paradisSanitizeHumanAskInput({ ...base, kind: 'permission', questions: [], actions, ...(preface.length > 0 ? { preface } : {}), ...(inlineAllowed ? { inlineAllowed: true } : {}) });
}

/** 読むだけの道具（行の中で許可してよい。ほかの形を知らない道具はモーダルへ回す）。 */
const PARADIS_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);

/**
 * 許可の前置き。操作そのもの（コマンドの全文・Edit の置き換え前後・Write の中身・MCP の引数の全部）を、スマホの許可カード
 * （app/mobile/src/approvalDetail.ts）と同じ項目から作る。説明（`description`）はエージェントが書いた文で、操作と食い違っても
 * 見分けられないので後ろに添えるだけにする（危険の札は前置きの全文から決める）。中継が切った中身は、切ったことを書く。
 */
function paradisHumanAskApprovalText(request: IParadisAgentApprovalRequest): string {
	const lines: string[] = [];
	switch (request.kind) {
		case 'bash':
			lines.push(`${request.tool}: ${request.command ?? ''}`);
			break;
		case 'edit':
			// allow-any-unicode-next-line
			lines.push(`${request.tool}: ${request.path ?? ''}${request.replaceAll ? '（すべて置き換え）' : ''}`, ...prefixed('- ', request.oldText), ...prefixed('+ ', request.newText));
			break;
		case 'write':
			// allow-any-unicode-next-line
			lines.push(`${request.tool}: ${request.path ?? ''}${request.contentLines !== undefined ? `（全 ${request.contentLines} 行）` : ''}`, ...(request.content !== undefined ? request.content.split('\n') : []));
			break;
		case 'fetch':
			lines.push(`${request.tool}: ${request.url ?? ''}`, ...(request.prompt !== undefined ? [request.prompt] : []));
			break;
		default: {
			const args = request.args ?? [];
			// allow-any-unicode-next-line
			lines.push(`${request.tool}${request.path !== undefined ? `: ${request.path}` : ''}`, `引数 ${args.length} 個`, ...args.map(arg => `${arg.key}（${arg.value.length} 字）: ${arg.value}`));
		}
	}
	if (request.description) {
		// allow-any-unicode-next-line
		lines.push(`（説明: ${request.description}）`);
	}
	if (request.truncated === true) {
		// allow-any-unicode-next-line
		lines.push('（中身が長いため途中までの表示です。全文を見て答えるにはペインを開いてください）');
	}
	return lines.join('\n');
}

function prefixed(mark: string, text: string | undefined): string[] {
	return text === undefined || text.length === 0 ? [] : text.split('\n').map(line => `${mark}${line}`);
}

/**
 * 台帳の答えを、ペインへ届ける回答へ戻す。全問に答えていない・選択と自由入力の両方がある・「飛ばす」は undefined（届けない）。
 * `input` は答えを検めたときの 1 件（{@link paradisHumanAskPaneInput} が作ったもの）。
 */
export function paradisHumanAskPaneDelivery(input: Pick<IParadisHumanAskInput, 'questions' | 'actions'>, answer: ParadisHumanAskAnswer): ParadisHumanAskPaneDelivery | undefined {
	if (answer.type === 'action') {
		const known = input.actions.some(action => action.id === answer.actionId);
		return known && answer.text === undefined && (answer.actionId === 'yes' || answer.actionId === 'no') ? { kind: 'approval', choiceId: answer.actionId } : undefined;
	}
	if (answer.type !== 'answers' || input.questions.length === 0 || answer.answers.length !== input.questions.length) {
		return undefined;
	}
	const answers: ParadisAgentQuestionAnswer[] = [];
	for (const question of input.questions) {
		const item = answer.answers.find(candidate => candidate.questionId === question.id);
		if (item === undefined) {
			return undefined;
		}
		const indices = (item.optionIds ?? []).map(id => question.options.findIndex(option => option.id === id));
		if (indices.some(index => index < 0)) {
			return undefined;
		}
		if (item.text !== undefined) {
			if (indices.length > 0 || !question.allowText) {
				return undefined;
			}
			answers.push({ kind: 'text', optionCount: question.options.length, text: item.text });
		} else if (question.multiSelect === true) {
			if (indices.length === 0) {
				return undefined;
			}
			answers.push({ kind: 'multi', indices });
		} else {
			if (indices.length !== 1) {
				return undefined;
			}
			answers.push({ kind: 'option', index: indices[0] });
		}
	}
	return { kind: 'question', answers };
}
