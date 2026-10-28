// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Codex の非同期の質問（`request_user_input_async`。agent.async-questions.v1）。
 *
 * PC は agent の snapshot / delta の `asyncQuestions` に、まだ答えていない質問の全部を載せる（変わったときだけ。全部答えたら空の
 * 配列）。アプリは答えを Codex が決めた返信の形の発言に組み立て、普通の発言と同じ `sendText` で送る。組み立てと読み取りは
 * PC と同じ関数（`paradisCodexAsyncQuestions.ts`）を使う。
 *
 * 一部の問いだけ答えて送ってもよい。送った問いは PC の一覧から消えるまで「送った」として隠し、残りの問いの書きかけは
 * この端末に持っておく（`asyncQuestionDrafts.ts`）。
 */

import {
	paradisBuildCodexAsyncReply,
	paradisParseCodexAsyncQuestionItemId,
	paradisParseCodexAsyncReply,
	PARADIS_CODEX_ASYNC_ANSWER_LIMIT,
	type IParadisCodexAsyncQuestion,
} from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisCodexAsyncQuestions.js';

export type AsyncQuestion = IParadisCodexAsyncQuestion;
export { PARADIS_CODEX_ASYNC_ANSWER_LIMIT as ASYNC_ANSWER_LIMIT };

/** 受け取る質問の上限（相手を信用しない）。 */
const MAX_QUESTIONS = 100;

/** PC から届いた `asyncQuestions` を確かめる。配列でなければ undefined（項目が無かった）。形の違う項目は落とす。 */
export function parseAsyncQuestions(value: unknown): AsyncQuestion[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const result: AsyncQuestion[] = [];
	for (const candidate of value.slice(0, MAX_QUESTIONS)) {
		if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
			continue;
		}
		const raw = candidate as Record<string, unknown>;
		const id = typeof raw['id'] === 'string' ? raw['id'] : undefined;
		const parsedId = id !== undefined ? paradisParseCodexAsyncQuestionItemId(id) : undefined;
		const title = typeof raw['title'] === 'string' ? raw['title'].trim() : '';
		const count = typeof raw['count'] === 'number' && Number.isInteger(raw['count']) && raw['count'] > 0 ? raw['count'] : 1;
		if (id === undefined || parsedId === undefined || parsedId.callId !== raw['callId'] || parsedId.index !== raw['index'] || title.length === 0) {
			continue;
		}
		const options = Array.isArray(raw['options'])
			? raw['options'].filter((option): option is string => typeof option === 'string' && option.trim().length > 0).slice(0, 20).map(option => option.slice(0, 500))
			: [];
		result.push({
			id, callId: parsedId.callId, index: parsedId.index, count, title: title.slice(0, 4_000),
			...(options.length > 0 ? { options } : {}),
			...(typeof raw['at'] === 'number' && Number.isFinite(raw['at']) ? { at: raw['at'] } : {}),
		});
	}
	return result;
}

/** 1 問の書きかけ。選んだ選択肢か、入力した答え（どちらか一方）。 */
export interface AsyncAnswerDraft {
	readonly option?: number;
	readonly text?: string;
}

/** 書きかけから送る答えの文字列。答えていなければ undefined。 */
export function asyncAnswerText(question: AsyncQuestion, draft: AsyncAnswerDraft | undefined): string | undefined {
	const text = draft?.text?.trim() ?? '';
	if (text.length > 0) {
		return text;
	}
	return draft?.option !== undefined ? question.options?.[draft.option] : undefined;
}

/** 呼び出しごとにまとめる（出た順）。 */
export function groupAsyncQuestions(questions: readonly AsyncQuestion[]): AsyncQuestion[][] {
	const groups = new Map<string, AsyncQuestion[]>();
	for (const question of questions) {
		const group = groups.get(question.callId);
		if (group === undefined) {
			groups.set(question.callId, [question]);
		} else {
			group.push(question);
		}
	}
	return [...groups.values()];
}

/** カードに出す問い（送った問いと、この端末で閉じた問いを除く）。 */
export function visibleAsyncQuestions(questions: readonly AsyncQuestion[], hidden: (id: string) => boolean): AsyncQuestion[] {
	return questions.filter(question => !hidden(question.id));
}

/** 答えた問いから返信の発言を作る。入れる答えが無ければ undefined。 */
export function buildAsyncReply(questions: readonly AsyncQuestion[], drafts: Readonly<Record<string, AsyncAnswerDraft>>): { readonly text: string; readonly ids: readonly string[] } | undefined {
	const answers = questions
		.map(question => ({ question, answer: asyncAnswerText(question, drafts[question.id]) }))
		.filter((entry): entry is { question: AsyncQuestion; answer: string } => entry.answer !== undefined);
	const text = paradisBuildCodexAsyncReply(answers);
	return text !== undefined ? { text, ids: answers.map(entry => entry.question.id) } : undefined;
}

/** 返信の発言 1 件（答えた質問と答え）。 */
export interface QuestionReply {
	readonly question: string;
	readonly answer: string;
}

/**
 * 人の発言が非同期の質問への返信なら、その中身。PC が添えた `questionReplies` を使い、無い（古い PC）ときは発言を読む。
 */
export function questionRepliesOf(message: { readonly role: string; readonly kind: string; readonly text: string; readonly questionReplies?: unknown }): QuestionReply[] | undefined {
	if (message.role !== 'user' || message.kind !== 'text') {
		return undefined;
	}
	if (Array.isArray(message.questionReplies)) {
		const replies = message.questionReplies.flatMap((candidate): QuestionReply[] => {
			if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
				return [];
			}
			const raw = candidate as Record<string, unknown>;
			return typeof raw['question'] === 'string' && typeof raw['answer'] === 'string' ? [{ question: raw['question'], answer: raw['answer'] }] : [];
		});
		if (replies.length > 0) {
			return replies;
		}
	}
	const parsed = paradisParseCodexAsyncReply(message.text);
	return parsed?.map(reply => ({ question: reply.question, answer: reply.answer }));
}

/** 送った発言の控え（作業中に送った・預かった発言の一覧）に出す文。返信の形なら「回答: 質問 → 答え」の行にする。 */
export function displaySentText(text: string): string {
	const replies = paradisParseCodexAsyncReply(text);
	return replies !== undefined ? replies.map(reply => `回答: ${reply.question} → ${reply.answer}`).join('\n') : text;
}
