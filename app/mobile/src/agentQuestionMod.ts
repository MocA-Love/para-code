// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { AgentInteraction, AgentQuestionAnswer, AgentQuestionOption } from './store.js';

/**
 * AskUserQuestion の preview・メモ・「質問に答えずに話す」の判定と組み立て（画面から切り離した純関数）。
 *
 * 仕様は Claude Code 2.1.288 の TUI に合わせてある:
 *  - preview を描くのは単一選択で、どれかの選択肢に preview がある質問だけ。その質問には「その他」（Type something）の
 *    行が無く、メモ（notes）を 1 つ付けられる。メモは他の選択肢へ移っても残る
 *  - 「Chat about this」は全問を取り下げる
 * メモと「質問に答えずに話す」は、PC の Claude Code の mod が待っているとき（`answerVia: 'mod'`）だけ出す（キーの列は確かめていない）。
 */

/** 質問の選択肢の preview と、interaction の `answerVia`、回答の `notes`（PC が広告する）。 */
export const AGENT_QUESTION_NOTES_CAPABILITY = 'agent.question.notes.v1';
/** agent の `action/clarifyQuestion`（PC が広告する）。 */
export const AGENT_QUESTION_CHAT_CAPABILITY = 'agent.question.chat.v1';

/** preview を枠の中にそのまま出す行数の上限。超えたら全画面のシートで読んでもらう。 */
export const PREVIEW_INLINE_MAX_LINES = 14;

/** メモの上限（PC の検査と同じ）。 */
export const QUESTION_NOTES_LIMIT = 2_000;

/** TUI がその質問で preview を描くか。 */
export function questionHasPreview(question: { readonly multiSelect?: boolean; readonly options?: readonly AgentQuestionOption[] }): boolean {
	return question.multiSelect !== true && (question.options ?? []).some(option => option.preview !== undefined);
}

/** この質問のカードで使えるもの。 */
export interface AskQuestionFeatures {
	/** メモ（preview のある質問だけ）。 */
	readonly notes: boolean;
	/** 「質問に答えずに話す」。 */
	readonly chat: boolean;
	/** mod で答える（キー注入ではない）。 */
	readonly viaMod: boolean;
}

export const NO_QUESTION_FEATURES: AskQuestionFeatures = { notes: false, chat: false, viaMod: false };

/** interaction と PC の広告から、カードで使えるものを決める。古い PC（広告も `answerVia` も無い）は何も出さない。 */
export function askQuestionFeatures(interaction: Pick<AgentInteraction, 'kind' | 'answerVia'> | undefined, hasNotes: boolean, hasChat: boolean): AskQuestionFeatures {
	const viaMod = interaction?.kind === 'question' && interaction.answerVia === 'mod';
	return { notes: viaMod && hasNotes, chat: viaMod && hasChat, viaMod };
}

/** 「その他（入力して回答）」を出すか。preview のある質問はキー注入では答えられない（TUI にその行が無い）。 */
export function showOtherOption(question: { readonly multiSelect?: boolean; readonly options?: readonly AgentQuestionOption[] }, features: AskQuestionFeatures): boolean {
	return features.viaMod || !questionHasPreview(question);
}

/** その質問にメモを付けられるか。 */
export function questionTakesNotes(question: { readonly multiSelect?: boolean; readonly options?: readonly AgentQuestionOption[] }, features: AskQuestionFeatures): boolean {
	return features.notes && questionHasPreview(question);
}

/** メモを添えた回答。メモが空なら元のまま、選んでいなければメモだけの回答（どちらも無ければ undefined）。 */
export function attachQuestionNotes(answer: AgentQuestionAnswer | undefined, notes: string, takesNotes: boolean): AgentQuestionAnswer | undefined {
	const trimmed = takesNotes ? notes.trim().slice(0, QUESTION_NOTES_LIMIT) : '';
	if (trimmed.length === 0) {
		return answer !== undefined && answer.kind === 'notes' ? undefined : answer;
	}
	if (answer === undefined || answer.kind === 'notes') {
		return { kind: 'notes', notes: trimmed };
	}
	return { ...answer, notes: trimmed };
}

/** 「質問に答えずに話す」で何も書かずに取り下げるときに添える、途中までの回答（未回答は null）。 */
export function partialQuestionAnswers(answers: readonly (AgentQuestionAnswer | undefined)[], notes: readonly string[], takesNotes: (index: number) => boolean): (AgentQuestionAnswer | null)[] {
	return answers.map((answer, index) => attachQuestionNotes(answer, notes[index] ?? '', takesNotes(index)) ?? null);
}

/** preview の 1 行。`heading` は `#` の見出し（記号を外して太字で出す）。 */
export interface PreviewLine {
	readonly text: string;
	readonly heading: boolean;
}

/**
 * preview を TUI の描き方に寄せて行に分ける: 見出しの `#` とコードフェンスの記号を外し、ほかは空白も含めてそのまま
 * （罫線の図を崩さない）。末尾の空行は落とす。
 */
export function formatQuestionPreview(text: string): PreviewLine[] {
	const lines: PreviewLine[] = [];
	for (const raw of text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
		if (/^\s*(```|~~~)/.test(raw)) {
			continue;
		}
		const heading = /^#{1,6}\s+(?<title>.*)$/.exec(raw);
		lines.push(heading?.groups !== undefined ? { text: heading.groups['title'] ?? '', heading: true } : { text: raw, heading: false });
	}
	while (lines.length > 0 && lines[lines.length - 1]!.text.trim().length === 0) {
		lines.pop();
	}
	return lines;
}

/** 枠の中に収まらない（全画面のシートで読むとよい）か。 */
export function previewNeedsFullView(lines: readonly PreviewLine[]): boolean {
	return lines.length > PREVIEW_INLINE_MAX_LINES;
}

/**
 * 質問の結果（ツールの結果の本文）から、取り下げたかを読む。Claude Code 2.1.288 で確かめた文面（2026-10-04 実測）:
 *  - mod の `response`: エラーではなく「The user responded: <本文>」
 *  - mod の deny: エラーで「<tool_use_error>The user wants to clarify these questions. …</tool_use_error>」
 *  - TUI の「Chat about this」: エラーで「The user doesn't want to proceed with this tool use. … the user said:\n」の後に
 *    同じ「The user wants to clarify these questions. …」が続く（前置きが付く）
 * なので取り下げは「エラーで、本文のどこかに The user wants to clarify these questions. がある」で読む。
 */
export type QuestionOutcome =
	| { readonly kind: 'withdrawn' }
	| { readonly kind: 'withdrawnWithMessage'; readonly text: string };

const RESPONDED_PREFIX = 'The user responded: ';
const CLARIFY_PREFIX = 'The user wants to clarify these questions.';

export function questionOutcomeFromResult(text: string, isError: boolean): QuestionOutcome | undefined {
	if (isError && text.includes(CLARIFY_PREFIX)) {
		return { kind: 'withdrawn' };
	}
	if (!isError && text.startsWith(RESPONDED_PREFIX)) {
		return { kind: 'withdrawnWithMessage', text: text.slice(RESPONDED_PREFIX.length) };
	}
	return undefined;
}
