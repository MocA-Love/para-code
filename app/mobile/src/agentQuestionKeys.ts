// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 質問（AskUserQuestion）への回答を、Claude Code のTUIへ流し込むキー列に変換する。
 *
 * PC側の `paradisAgentQuestionKeys.ts` と同じ規則を持つ写し。回答は通常PC側で組み立てるが、
 * 質問回答APIを持たない古いPCへはモバイルが直接PTYへ注入するため、こちらにも同じ物が要る。
 * **どちらかを直したら必ずもう一方も直すこと**（両方に同じ内容のテストがある）。
 *
 * TUIの実挙動は素朴な「番号 → Enter」とは違う:
 *
 *  - **数字キーは即選択**。単一選択の質問では確定と同時に次の質問へ進むため、続けてEnterを
 *    送ると *次の質問* の先頭選択肢を確定させてしまう（多問で答えが1問ずつずれる原因）
 *  - **自由入力（Other）は入力欄が空のあいだ、数字キーではフォーカスが移るだけ**。その状態で
 *    Enterを送ると空のまま確定を試み、単一選択では質問全体がキャンセルされる。正しくは
 *    「番号 → 本文 → Enter」の順
 *  - **複数選択の質問はEnterでも数字でも次へ進まない**。数字はトグル、Enter/スペースは
 *    フォーカス中の項目のトグルで、前進するには末尾の送信ボタンへTabで移動してEnterが要る。
 *    進めないまま次の答えを送ると、すべて同じ質問に降り注いでチェックが増え続ける
 *  - 単問かつ単一選択のときだけ確認画面が出ない。それ以外は最後に「Review your answers」が
 *    出るので、締めのEnterが1回要る
 */

/** 1問ぶんのTUI上の形（キー列の組み立てに要るものだけ）。 */
export interface AgentQuestionShape {
	/** 「Other」を除いた選択肢の数。 */
	readonly optionCount: number;
	readonly multiSelect: boolean;
}

/** 1問ぶんの回答。 */
export type AgentQuestionKeyAnswer =
	| { kind: 'option'; index: number }
	| { kind: 'multi'; indices: number[] }
	| { kind: 'text'; optionCount: number; text: string };

const ENTER = '\r';
const TAB = '\t';

/**
 * 自由入力の本文をTUIの1行入力に流せる形へ均す。改行はそのまま送ると確定扱いになり、
 * 残りが次の質問へ流れ込むため、空白に潰す。
 */
function flattenText(text: string): string {
	return text.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * 回答をキー列にする。`questions` は `answers` と同じ並び（TUIの質問順）で渡す。
 * 返る各要素は「1回ぶんの入力」で、呼び出し側が一定間隔を空けて順に流す前提。
 */
export function agentQuestionKeySequence(
	questions: readonly AgentQuestionShape[],
	answers: readonly AgentQuestionKeyAnswer[],
): string[] {
	const parts: string[] = [];
	for (const [index, answer] of answers.entries()) {
		const question = questions[index];
		if (question === undefined) {
			continue;
		}
		if (answer.kind === 'option') {
			// 数字だけで確定し、次の質問へ自動で進む。Enterは送らない。
			parts.push(String(answer.index + 1));
			continue;
		}
		if (answer.kind === 'multi') {
			// 数字はトグルのみ（フォーカスは動かない）。スペースは「フォーカス中の項目」を
			// トグルしてしまうので送らない。選択肢＋Otherの行数ぶんTabを送れば、どこから
			// 始まっても送信ボタンに届く（ボタン上のTabは何もしないので行き過ぎない）。
			for (const optionIndex of [...new Set(answer.indices)].sort((a, b) => a - b)) {
				parts.push(String(optionIndex + 1));
			}
			parts.push(...new Array<string>(question.optionCount + 1).fill(TAB), ENTER);
			continue;
		}
		const text = flattenText(answer.text);
		if (question.multiSelect) {
			// 複数選択のOther行は数字では選べない（数字はトグル）。Tabで入力欄まで移動して
			// 本文を入れると自動で選択され、そこからもう1つTabで送信ボタンへ。
			parts.push(...new Array<string>(question.optionCount).fill(TAB), text, TAB, ENTER);
			continue;
		}
		// 単一選択のOther: 番号でフォーカスを移し、本文を入れてからEnterで確定する。
		parts.push(String(answer.optionCount + 1), text, ENTER);
	}
	if (parts.length > 0 && agentQuestionNeedsReviewSubmit(questions)) {
		parts.push(ENTER);
	}
	return parts;
}

/**
 * 全問に答えたあと「Review your answers」の確認画面が出るか。
 * 単問かつ単一選択のときだけ、確定と同時に送信されて確認画面を挟まない。
 */
export function agentQuestionNeedsReviewSubmit(questions: readonly AgentQuestionShape[]): boolean {
	return !(questions.length === 1 && questions[0]?.multiSelect === false);
}
