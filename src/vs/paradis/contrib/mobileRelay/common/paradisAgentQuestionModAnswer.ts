/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisAgentQuestionAnswer } from './paradisAgentQuestionKeys.js';

/**
 * モバイルの質問の回答を、Claude Code の mod（Claude Mods）へ値で渡す形に組み立てる（副作用なし）。
 *
 * 形は Claude Code 2.1.288 の TUI が返すものに合わせてある（モックの調査節。`mobile-ask-preview-mock.html`）:
 *  - `answers`: 質問文 → 選んだラベル（複数選択は `, ` でつなぐ。自由入力は本文。メモだけなら `(notes only)`）
 *  - `annotations`: 質問文 → `{ preview?, notes? }`。preview は選んだ選択肢に preview があるときの元の文字列、
 *    notes はメモ。TUI はこれを見て「selected preview: … notes: …」をモデルへ渡す
 *  - 「質問に答えずに話す」で何も書かなかったときの拒否の文面（TUI の「Chat about this」と同じ文言）
 */

/** 1 問ぶんの回答。キー注入と同じ 3 種に、メモ（preview のある質問だけ）とメモだけの回答を足したもの。 */
export type ParadisAgentQuestionModAnswer =
	| (ParadisAgentQuestionAnswer & { readonly notes?: string })
	| { readonly kind: 'notes'; readonly notes: string };

/** mod が受け取った 1 問（`IParadisClaudeModQuestion` のうち、ここで使うもの）。 */
export interface IParadisAgentQuestionModSource {
	readonly question: string;
	readonly options: readonly { readonly label: string; readonly preview?: string }[];
}

export interface IParadisAgentQuestionModAnnotation {
	readonly preview?: string;
	readonly notes?: string;
}

/** Claude Code がメモだけの回答に使う値（2.1.288 の `EOt`）。 */
export const PARADIS_AGENT_QUESTION_NOTES_ONLY = '(notes only)';

/** メモの上限（文字数）。 */
export const PARADIS_AGENT_QUESTION_NOTES_LIMIT = 2_000;

/** 「質問に答えずに話す」で送るメッセージの上限（文字数）。 */
export const PARADIS_AGENT_QUESTION_RESPONSE_LIMIT = 10_000;

/**
 * 1 問の回答を、mod へ渡す値（ラベルの文字列）と、選んだ選択肢の preview にする。
 * `shownLabels` はモバイルに見せた（切り詰めた）ラベル。添字はこちらで引き、元のラベルを返す。
 * 選択肢が引けなければ undefined（呼び出し側はキーの経路へ戻すか断る）。
 */
function resolveAnswer(source: IParadisAgentQuestionModSource, shownLabels: readonly string[], answer: ParadisAgentQuestionModAnswer, truncate: (label: string) => string): { readonly value: string; readonly preview?: string } | undefined {
	const option = (optionIndex: number) => {
		const shown = shownLabels[optionIndex];
		if (shown === undefined) {
			return undefined;
		}
		return source.options.find(candidate => truncate(candidate.label) === shown) ?? { label: shown };
	};
	switch (answer.kind) {
		case 'option': {
			const picked = option(answer.index);
			return picked === undefined ? undefined : { value: picked.label, ...(picked.preview !== undefined ? { preview: picked.preview } : {}) };
		}
		case 'multi': {
			const picked = answer.indices.map(option);
			return picked.length > 0 && picked.every(item => item !== undefined) ? { value: picked.map(item => item!.label).join(', ') } : undefined;
		}
		case 'text':
			return { value: answer.text };
		case 'notes':
			return { value: PARADIS_AGENT_QUESTION_NOTES_ONLY };
	}
}

function notesOf(answer: ParadisAgentQuestionModAnswer | undefined): string | undefined {
	const notes = answer?.notes?.trim();
	return notes !== undefined && notes.length > 0 ? notes.slice(0, PARADIS_AGENT_QUESTION_NOTES_LIMIT) : undefined;
}

/**
 * 全問の回答を mod の `{ answers, annotations }` にする。`sources` と `shownLabels` と `answers` は同じ並び。
 * 引けない回答があれば undefined。
 */
export function paradisBuildModQuestionAnswer(
	sources: readonly IParadisAgentQuestionModSource[],
	shownLabels: readonly (readonly string[])[],
	answers: readonly ParadisAgentQuestionModAnswer[],
	truncate: (label: string) => string,
): { readonly answers: Record<string, string>; readonly annotations?: Record<string, IParadisAgentQuestionModAnnotation> } | undefined {
	if (sources.length !== answers.length) {
		return undefined;
	}
	const values: Record<string, string> = {};
	const annotations: Record<string, IParadisAgentQuestionModAnnotation> = {};
	for (const [index, answer] of answers.entries()) {
		const source = sources[index];
		const resolved = source !== undefined ? resolveAnswer(source, shownLabels[index] ?? [], answer, truncate) : undefined;
		if (source === undefined || resolved === undefined) {
			return undefined;
		}
		values[source.question] = resolved.value;
		const notes = notesOf(answer);
		if (resolved.preview !== undefined || notes !== undefined) {
			annotations[source.question] = { ...(resolved.preview !== undefined ? { preview: resolved.preview } : {}), ...(notes !== undefined ? { notes } : {}) };
		}
	}
	return { answers: values, ...(Object.keys(annotations).length > 0 ? { annotations } : {}) };
}

/**
 * 「質問に答えずに話す」で何も書かずに取り下げたときの拒否の文面。Claude Code 2.1.288 の「Chat about this」と同じ文言で
 * （空行を挟んで「Questions asked:」。2026-10-04 に TUI の結果を実測）、
 * 途中までの回答とメモ（preview のある質問だけ）を添える。`answers` の未回答は undefined。
 */
export function paradisAgentQuestionClarifyDeny(
	sources: readonly IParadisAgentQuestionModSource[],
	shownLabels: readonly (readonly string[])[],
	answers: readonly (ParadisAgentQuestionModAnswer | undefined)[],
	truncate: (label: string) => string,
	hasPreview: (index: number) => boolean,
): string {
	const lines = sources.map((source, index) => {
		const answer = answers[index];
		const resolved = answer !== undefined && answer.kind !== 'notes' ? resolveAnswer(source, shownLabels[index] ?? [], answer, truncate) : undefined;
		const notes = hasPreview(index) ? notesOf(answer) : undefined;
		const entry = [`- "${source.question}"`, resolved !== undefined ? `  Answer: ${resolved.value}` : '  (No answer provided)'];
		if (notes !== undefined) {
			entry.push(`  User notes: ${notes}`);
		}
		return entry.join('\n');
	});
	return [
		'The user wants to clarify these questions.',
		'    This means they may have additional information, context or questions for you.',
		'    Take their response into account and then reformulate the questions if appropriate.',
		'    Start by asking them what they would like to clarify.',
		'',
		'    Questions asked:',
		lines.join('\n'),
	].join('\n');
}
