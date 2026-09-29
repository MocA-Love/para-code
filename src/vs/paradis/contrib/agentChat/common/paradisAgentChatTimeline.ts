/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// デスクトップのチャット表示で、会話のメッセージ列を「画面に並べる単位」へ組み直す純粋な関数群。
//
// ツールの呼び出しと結果を1行にまとめる、同じ AskUserQuestion の質問を1枚のカードにまとめる、
// 許可要求をカードにする、といった組み直しをここで行い、画面（browser/paradisAgentChatView.ts）は
// 並んだ単位を描くだけにする。ツール名の読み替えはモバイル（app/mobile/src/agentToolMeta.ts）の
// 規則に合わせてある（同じ会話が PC とスマホで違う名前で出ないように）。

import { LcsDiff } from '../../../../base/common/diff/diff.js';
import { localize } from '../../../../nls.js';
import { IParadisAgentChatMessage, IParadisAgentInteraction } from './paradisAgentChat.js';

/** 画面に並べる単位。 */
export type ParadisAgentChatItem =
	| { readonly kind: 'user'; readonly key: string; readonly message: IParadisAgentChatMessage }
	| { readonly kind: 'assistant'; readonly key: string; readonly message: IParadisAgentChatMessage }
	| { readonly kind: 'thinking'; readonly key: string; readonly message: IParadisAgentChatMessage }
	| { readonly kind: 'tool'; readonly key: string; readonly use?: IParadisAgentChatMessage; readonly result?: IParadisAgentChatMessage }
	| {
		readonly kind: 'questions'; readonly key: string;
		/** 回答に使う ID（interaction の id と同じ値）。 */
		readonly group: string;
		readonly questions: readonly IParadisAgentChatMessage[];
		/** 回答済みなら、ツール結果として記録された回答の本文。 */
		readonly answer?: string;
		readonly answered: boolean;
	}
	| { readonly kind: 'approval'; readonly key: string; readonly message: IParadisAgentChatMessage }
	| { readonly kind: 'peer'; readonly key: string; readonly message: IParadisAgentChatMessage };

/** 質問のグループキー。回答に使う interaction の id と同じ決め方（paradisPickCurrentInteraction）。 */
function questionGroupOf(message: IParadisAgentChatMessage): string | undefined {
	return message.questionGroup ?? message.toolUseId;
}

/**
 * メッセージ列を画面の単位へ組み直す。tool_use と tool_result は toolUseId で対応付け、
 * ID の無い経路（Codex の一部）は直前の未解決の呼び出しへ順番に割り当てる。
 */
export function paradisBuildAgentChatItems(messages: readonly IParadisAgentChatMessage[], interaction?: IParadisAgentInteraction | null): ParadisAgentChatItem[] {
	return paradisMergeDuplicateQuestions(buildItems(messages), interaction ?? null);
}

/**
 * 同じ内容（質問文と選択肢）の質問のカードが重なったとき、抜け殻の方を外す。hook から先に入れた質問と、
 * 後から transcript に書かれた同じ質問の突き合わせが外れると（フェーズ6の実機確認 NG-7）、同じ質問が2枚並び、
 * 回答は片方にしか付かない。外すのは「回答が無く、今回答を待ってもいない」方だけで、回答済みの履歴と
 * 回答待ちのカードは残す（同じ質問を後でもう一度聞かれた場合は、両方とも残る）。
 */
function paradisMergeDuplicateQuestions(items: ParadisAgentChatItem[], interaction: IParadisAgentInteraction | null): ParadisAgentChatItem[] {
	const contentOf = (item: Extract<ParadisAgentChatItem, { kind: 'questions' }>) => JSON.stringify(item.questions.map(question => [question.text, (question.options ?? []).map(option => option.label)]));
	const isPending = (item: Extract<ParadisAgentChatItem, { kind: 'questions' }>) => interaction?.kind === 'question' && interaction.id === item.group;
	const liveByContent = new Map<string, number>();
	for (const item of items) {
		if (item.kind === 'questions' && (item.answered || isPending(item))) {
			const content = contentOf(item);
			liveByContent.set(content, (liveByContent.get(content) ?? 0) + 1);
		}
	}
	return items.filter(item => item.kind !== 'questions' || item.answered || isPending(item) || !liveByContent.has(contentOf(item)));
}

function buildItems(messages: readonly IParadisAgentChatMessage[]): ParadisAgentChatItem[] {
	const items: ParadisAgentChatItem[] = [];
	const toolIndexById = new Map<string, number>();
	const unresolvedTools: number[] = [];
	const questionIndexByToolUseId = new Map<string, number>();
	const questionIndexByGroup = new Map<string, number>();
	for (const message of messages) {
		switch (message.kind) {
			case 'text':
				if (message.role === 'user') {
					items.push({ kind: 'user', key: `m${message.rev}`, message });
				} else if (message.text.trim().length > 0 || (message.images?.length ?? 0) > 0) {
					items.push({ kind: 'assistant', key: `m${message.rev}`, message });
				}
				break;
			case 'thinking':
				items.push({ kind: 'thinking', key: `m${message.rev}`, message });
				break;
			case 'peer_message':
				items.push({ kind: 'peer', key: `m${message.rev}`, message });
				break;
			case 'question': {
				const group = questionGroupOf(message) ?? `rev:${message.rev}`;
				const existing = questionIndexByGroup.get(group);
				const existingItem = existing !== undefined ? items[existing] : undefined;
				if (existing !== undefined && existingItem?.kind === 'questions') {
					items[existing] = { ...existingItem, questions: [...existingItem.questions, message].sort((a, b) => (a.questionIndex ?? 0) - (b.questionIndex ?? 0)) };
				} else {
					questionIndexByGroup.set(group, items.length);
					items.push({ kind: 'questions', key: `q${message.rev}`, group, questions: [message], answered: false });
				}
				if (message.toolUseId !== undefined) {
					questionIndexByToolUseId.set(message.toolUseId, questionIndexByGroup.get(group)!);
				}
				break;
			}
			case 'tool_use':
				if (message.tool === 'approval_request') {
					items.push({ kind: 'approval', key: `m${message.rev}`, message });
					break;
				}
				if (message.toolUseId !== undefined) {
					toolIndexById.set(message.toolUseId, items.length);
				} else {
					unresolvedTools.push(items.length);
				}
				items.push({ kind: 'tool', key: `m${message.rev}`, use: message });
				break;
			case 'tool_result': {
				// 質問への回答（AskUserQuestion の結果）は、質問のカードを「回答済み」にするだけで行にしない。
				const questionIndex = message.toolUseId !== undefined ? questionIndexByToolUseId.get(message.toolUseId) : undefined;
				const questionItem = questionIndex !== undefined ? items[questionIndex] : undefined;
				if (questionIndex !== undefined && questionItem?.kind === 'questions') {
					items[questionIndex] = { ...questionItem, answered: true, ...(message.text.trim().length > 0 ? { answer: message.text } : {}) };
					break;
				}
				const index = message.toolUseId !== undefined ? toolIndexById.get(message.toolUseId) : unresolvedTools.shift();
				const target = index !== undefined ? items[index] : undefined;
				if (index !== undefined && target?.kind === 'tool' && target.result === undefined) {
					items[index] = { ...target, result: message };
				} else {
					// 対応する呼び出しが（履歴の切り詰め等で）欠けている結果は単独の行にする。
					items.push({ kind: 'tool', key: `m${message.rev}`, result: message });
				}
				break;
			}
		}
	}
	return items;
}

/**
 * Codex の `request_user_input`（Plan mode の質問）で、まだ結果が書かれていない呼び出し。中継は回答待ちとして
 * 持たない（hook も app-server の回答口も無い）ので、会話から見つける。ここからは答えられないので、チャットは
 * 送信を止めてターミナルへ案内する（送ると、文が質問のメモ欄に入り Enter で既定の選択肢が確定する。
 * フェーズ6の実機確認 NG-1）。
 */
export function paradisPendingCodexQuestion(messages: readonly IParadisAgentChatMessage[]): IParadisAgentChatMessage | undefined {
	const answered = new Set<string>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === 'user' && message.kind === 'text') {
			// 質問の後に利用者が発言している。質問に答えている間は発言できないので、質問はもう待っていない
			// （Esc で中断すると結果が書かれないまま残るため、結果の有無だけで判断しない）。
			return undefined;
		}
		if (message.kind === 'tool_result' && message.toolUseId !== undefined) {
			answered.add(message.toolUseId);
		} else if (message.kind === 'tool_use' && message.tool === 'request_user_input') {
			return message.toolUseId !== undefined && answered.has(message.toolUseId) ? undefined : message;
		}
	}
	return undefined;
}

/** 質問のカードに回答の操作を出すか（今まさに回答を待っている質問か）。 */
export function paradisIsPendingQuestionItem(item: ParadisAgentChatItem, interaction: IParadisAgentInteraction | null): boolean {
	return item.kind === 'questions' && !item.answered && interaction?.kind === 'question' && interaction.id === item.group;
}

/** 許可要求のカードに回答の操作を出すか。 */
export function paradisIsPendingApprovalItem(item: ParadisAgentChatItem, interaction: IParadisAgentInteraction | null): boolean {
	return item.kind === 'approval' && interaction?.kind === 'approval' && interaction.id === item.message.toolUseId;
}

// ---- ツールのまとまり（折りたたみ） ----------------------------------------------------------------

/**
 * 画面に並べる単位を、さらに「折りたたむまとまり」へ組んだもの。モバイル（app/mobile/src/features/session/chatRows.ts の
 * buildChatRows）と同じく、連続するツールの呼び出し・考えた内容・答え終えた許可の確認を1つのまとまりにする。
 */
export type ParadisAgentChatEntry =
	| { readonly kind: 'item'; readonly item: ParadisAgentChatItem }
	| {
		readonly kind: 'group';
		/** まとまりの鍵。先頭の単位の鍵から作るので、後ろに単位が足されても変わらない（開いた状態を保てる）。 */
		readonly key: string;
		readonly items: readonly ParadisAgentChatItem[];
		/** 畳んでいても見せる単位（今のターンの実行中のツールと、利用者が開いている行）。 */
		readonly pinned: ReadonlySet<string>;
	};

/** まとまりの組み方を決める会話の状態。 */
export interface IParadisAgentChatGroupOptions {
	readonly interaction: IParadisAgentInteraction | null;
	/** エージェントが作業中か。作業中だけ、今のターンの実行中のツールを畳んでも見せる。 */
	readonly busy: boolean;
	/** 答えを待っている Codex の `request_user_input` の呼び出し（`paradisPendingCodexQuestion`）。まとまりを区切る。 */
	readonly pendingCodexQuestion?: IParadisAgentChatMessage;
	/** 利用者が開いている行の鍵。まとまりに入っても畳まずに見せる（読んでいる途中の行を消さない）。 */
	readonly expanded?: ReadonlySet<string>;
}

/** ツールの実行中か（呼び出しがあって結果がまだ無い）。 */
export function paradisIsRunningToolItem(item: ParadisAgentChatItem): boolean {
	return item.kind === 'tool' && item.use !== undefined && item.result === undefined;
}

/**
 * まとまりに入れる単位か。本文（ユーザー・エージェントの発言、別のエージェントからのメッセージ）、質問のカード、
 * 回答待ちの許可の確認のカード、答えを待っている Codex の質問はまとまりを区切り、畳まずに出す。Web 検索も
 * モバイルと同じく独立した行にする。
 */
export function paradisIsFoldableAgentChatItem(item: ParadisAgentChatItem, options: IParadisAgentChatGroupOptions): boolean {
	switch (item.kind) {
		case 'thinking':
			return true;
		case 'tool':
			return item.use?.tool !== 'web_search' && (item.use === undefined || item.use !== options.pendingCodexQuestion);
		case 'approval':
			return !paradisIsPendingApprovalItem(item, options.interaction);
		default:
			return false;
	}
}

/**
 * 画面の単位を折りたたむまとまりへ組む。まとまりに入る単位が2つ以上続いたところだけをまとめ、1つだけなら
 * そのまま出す（畳んでも1行が1行になるだけで、中身が見えなくなるだけのため）。作業中は、最後のユーザーの発言より
 * 後ろ（今のターン）の結果の無いツールを畳んでも見せる印を付ける。それより前の結果の無いツールと、作業していない
 * 会話の結果の無いツールは、中断や履歴の切り詰めで結果が欠けたもので、畳んだままでよい。
 */
export function paradisGroupAgentChatItems(items: readonly ParadisAgentChatItem[], options: IParadisAgentChatGroupOptions): ParadisAgentChatEntry[] {
	let turnStart = 0;
	for (let index = items.length - 1; index >= 0; index--) {
		if (items[index].kind === 'user') {
			turnStart = index + 1;
			break;
		}
	}
	const entries: ParadisAgentChatEntry[] = [];
	let run: ParadisAgentChatItem[] = [];
	let runStart = 0;
	const flush = () => {
		if (run.length === 1) {
			entries.push({ kind: 'item', item: run[0] });
		} else if (run.length > 1) {
			const pinned = new Set<string>();
			run.forEach((item, offset) => {
				if ((options.busy && runStart + offset >= turnStart && paradisIsRunningToolItem(item)) || options.expanded?.has(item.key)) {
					pinned.add(item.key);
				}
			});
			entries.push({ kind: 'group', key: `g:${run[0].key}`, items: run, pinned });
		}
		run = [];
	};
	items.forEach((item, index) => {
		if (paradisIsFoldableAgentChatItem(item, options)) {
			if (run.length === 0) {
				runStart = index;
			}
			run.push(item);
		} else {
			flush();
			entries.push({ kind: 'item', item });
		}
	});
	flush();
	return entries;
}

/** まとまりの見出しの中身。 */
export interface IParadisAgentChatGroupSummary {
	/** 単位の数（考えた内容も1件に数える。モバイルと同じ）。 */
	readonly count: number;
	/** 名前を重ねずに出てきた順に並べたもの。 */
	readonly names: readonly string[];
	/** 失敗したツールの数。 */
	readonly failed: number;
	/** 成功した変更で書き換えたファイルのパス（重ねずに出てきた順）。 */
	readonly files: readonly string[];
}

/** ファイルを書き換えるツールの呼び出しか（差分カードを出す対象）。 */
export function paradisIsFileWriteTool(use: IParadisAgentChatMessage): boolean {
	const tool = use.tool ?? '';
	return tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'apply_patch' || use.text.includes('*** Begin Patch');
}

/** ファイルを書き換えるツールの呼び出しが対象にしたファイルのパス。差分は作らず、パスだけを読む。 */
export function paradisFileWritePaths(use: IParadisAgentChatMessage): string[] {
	const tool = use.tool ?? '';
	if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') {
		const input = paradisParseToolInput(use.text);
		const path = nonEmpty(input?.file_path) ?? nonEmpty(input?.notebook_path);
		return path !== undefined ? [path] : [];
	}
	if (tool === 'apply_patch' || use.text.includes('*** Begin Patch')) {
		const patch = paradisApplyPatchText(use.text);
		if (patch === undefined) {
			return [];
		}
		const paths: string[] = [];
		for (const line of splitLines(patch)) {
			const header = /^\*\*\* (?:Update|Add|Delete) File: (?<path>.+)$/.exec(line);
			if (header?.groups !== undefined) {
				paths.push(header.groups.path.trim());
			}
		}
		return paths;
	}
	return [];
}

function toolFailed(result: IParadisAgentChatMessage): boolean {
	return result.isError === true || looksLikeError(result.text);
}

/** まとまりの見出しを作る。 */
export function paradisSummarizeAgentChatGroup(items: readonly ParadisAgentChatItem[]): IParadisAgentChatGroupSummary {
	const names: string[] = [];
	const files: string[] = [];
	let failed = 0;
	const addOnce = (list: string[], value: string) => {
		if (!list.includes(value)) {
			list.push(value);
		}
	};
	for (const item of items) {
		switch (item.kind) {
			case 'thinking':
				addOnce(names, localize('paradisAgentChat.groupThinking', "考えた内容"));
				break;
			case 'approval':
				addOnce(names, localize('paradisAgentChat.groupApproval', "許可の確認"));
				break;
			case 'tool': {
				// 見出しには名前だけが要る。入力の解析や差分（describeTool / describeMeta）は作らない
				// （作業中は最後のまとまりの見出しをツールごとに作り直すため）。
				addOnce(names, item.use !== undefined ? toolLabel(item.use.tool ?? 'tool') : toolResultLabel());
				const itemFailed = item.result !== undefined && toolFailed(item.result);
				if (itemFailed) {
					failed++;
				}
				// ファイルの変更は、結果が届いて失敗していないものだけ数える（失敗した Edit と重ねて数えない）。
				if (item.use !== undefined && item.result !== undefined && !itemFailed) {
					for (const path of paradisFileWritePaths(item.use)) {
						addOnce(files, path);
					}
				}
				break;
			}
		}
	}
	return { count: items.length, names, failed, files };
}

// ---- ツールの行の見出し ------------------------------------------------------------------------

/** ツールの行に出す見出し。 */
export interface IParadisAgentChatToolSummary {
	/** 主な名前（Bash / Read / search_issues など）。 */
	readonly label: string;
	/** MCP のサーバー名など、名前に添える従属の表示。 */
	readonly namespace?: string;
	/** 引数の1行要約。 */
	readonly arg?: string;
	/** codicon の名前。 */
	readonly icon: string;
	/** 右端に出す値（行数・件数・所要時間など）。 */
	readonly meta?: string;
	readonly state: 'running' | 'done' | 'failed';
}

/** tool_use の text（入力の JSON）をオブジェクトへ戻す。JSON でない・切り詰められて壊れているなら undefined。 */
export function paradisParseToolInput(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith('{')) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** パスの末尾要素。長い絶対パスを見出しに出すと引数が読めなくなるため。 */
export function paradisPathBasename(path: string): string {
	const parts = path.split(/[\\/]/);
	return parts[parts.length - 1] || path;
}

/** テキストの行数（末尾の空行は数えない）。 */
export function paradisCountLines(text: string): number {
	const trimmed = text.replace(/\n+$/, '');
	return trimmed.length === 0 ? 0 : trimmed.split('\n').length;
}

/** ツールの結果がエラーらしいか（is_error が取れない経路の補い。モバイルと同じ規則）。 */
function looksLikeError(text: string): boolean {
	const head = text.slice(0, 400);
	return /^\s*(error|エラー)\b/i.test(head)
		|| /\berror\s+TS\d+/.test(head)
		|| /\b(command not found|no such file or directory|permission denied)\b/i.test(head)
		|| /\bexit(?:ed with)? code\s*[1-9]/i.test(head);
}

function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 10) {
		return localize('paradisAgentChat.durationShort', "{0}秒", seconds.toFixed(1));
	}
	if (seconds < 60) {
		return localize('paradisAgentChat.durationSeconds', "{0}秒", Math.round(seconds));
	}
	const whole = Math.round(seconds);
	return localize('paradisAgentChat.durationMinutes', "{0}分{1}秒", Math.floor(whole / 60), String(whole % 60).padStart(2, '0'));
}

function filePathArg(input: Record<string, unknown> | undefined): string | undefined {
	const path = nonEmpty(input?.file_path) ?? nonEmpty(input?.path) ?? nonEmpty(input?.notebook_path);
	return path !== undefined ? paradisPathBasename(path) : undefined;
}

function commandArg(input: Record<string, unknown> | undefined, raw: string): string {
	const command = input?.command ?? input?.cmd;
	if (Array.isArray(command)) {
		return oneLine(command.filter((part): part is string => typeof part === 'string').join(' '));
	}
	return nonEmpty(command) !== undefined ? oneLine(command as string) : oneLine(raw);
}

/** ツールの行の見出しを決める。 */
export function paradisDescribeAgentChatTool(use: IParadisAgentChatMessage | undefined, result: IParadisAgentChatMessage | undefined): IParadisAgentChatToolSummary {
	const failed = result !== undefined && toolFailed(result);
	const state: IParadisAgentChatToolSummary['state'] = result === undefined ? 'running' : failed ? 'failed' : 'done';
	if (use === undefined) {
		return { label: toolResultLabel(), icon: 'output', arg: oneLine(result?.text ?? ''), state };
	}
	const tool = use.tool ?? 'tool';
	const input = paradisParseToolInput(use.text);
	return { ...describeTool(tool, input, use), meta: describeMeta(tool, input, use, result, failed), state };
}

/** ツールの見出しのうち、結果に依らない部分（名前・引数・アイコン）。 */
/** ツールの行の主な名前。入力を読まずに決まるので、まとまりの見出しはこれだけを使う。 */
function toolLabel(tool: string): string {
	const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
	if (mcp !== null) {
		return mcp[2];
	}
	switch (tool) {
		case 'Bash':
		case 'BashOutput':
			return 'Bash';
		case 'shell':
		case 'exec_command':
		case 'local_shell':
			return 'Shell';
		case 'Read':
		case 'Write':
		case 'Edit':
		case 'Glob':
		case 'Grep':
			return tool;
		case 'MultiEdit':
		case 'NotebookEdit':
			return 'Edit';
		case 'apply_patch':
			return 'Patch';
		case 'web_search':
			return localize('paradisAgentChat.webSearch', "Web 検索");
		case 'WebFetch':
			return localize('paradisAgentChat.webFetch', "ページ取得");
		case 'TodoWrite':
			return localize('paradisAgentChat.todo', "タスク更新");
		case 'Task':
		case 'Agent':
			return localize('paradisAgentChat.subagent', "サブエージェント");
		case 'Skill':
			return localize('paradisAgentChat.skill', "スキル");
		case 'ToolSearch':
		case 'tool_search':
			return localize('paradisAgentChat.toolSearch', "ツール検索");
		case 'view_image':
			return localize('paradisAgentChat.viewImage', "画像を見る");
		default:
			return tool;
	}
}

/** 呼び出しと対にならなかったツールの結果の名前。 */
function toolResultLabel(): string {
	return localize('paradisAgentChat.toolResult', "ツールの結果");
}

function describeTool(tool: string, input: Record<string, unknown> | undefined, use: IParadisAgentChatMessage): Omit<IParadisAgentChatToolSummary, 'meta' | 'state'> {
	const label = toolLabel(tool);
	const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
	if (mcp !== null) {
		const arg = input === undefined ? oneLine(use.text) : ['query', 'q', 'command', 'code', 'url', 'path', 'file_path', 'name', 'pattern', 'prompt']
			.map(key => nonEmpty(input[key])).find(value => value !== undefined) ?? oneLine(use.text);
		return { label, namespace: mcp[1], arg: oneLine(arg), icon: 'extensions' };
	}
	switch (tool) {
		case 'Bash':
		case 'BashOutput':
		case 'shell':
		case 'exec_command':
		case 'local_shell':
			return { label, icon: 'terminal', arg: commandArg(input, use.text) };
		case 'Read':
			return { label, icon: 'file', arg: filePathArg(input) };
		case 'Write':
			return { label, icon: 'new-file', arg: filePathArg(input) };
		case 'Edit':
		case 'MultiEdit':
		case 'NotebookEdit':
			return { label, icon: 'edit', arg: filePathArg(input) };
		case 'apply_patch':
			return { label, icon: 'edit', arg: paradisParseApplyPatch(paradisApplyPatchText(use.text) ?? '').map(file => paradisPathBasename(file.path)).join(', ') || undefined };
		case 'Glob':
			return { label, icon: 'search', arg: nonEmpty(input?.pattern) ?? oneLine(use.text) };
		case 'Grep': {
			const pattern = nonEmpty(input?.pattern);
			const where = nonEmpty(input?.glob) ?? nonEmpty(input?.path);
			return { label, icon: 'search', arg: pattern !== undefined ? (where !== undefined ? `${pattern} · ${paradisPathBasename(where)}` : pattern) : oneLine(use.text) };
		}
		case 'web_search':
			return { label, icon: 'globe', arg: oneLine(use.text) };
		case 'WebFetch':
			return { label, icon: 'globe', arg: nonEmpty(input?.url)?.replace(/^https?:\/\//, '') ?? oneLine(use.text) };
		case 'TodoWrite': {
			const todos = input?.todos;
			const arg = Array.isArray(todos)
				? localize('paradisAgentChat.todoProgress', "{0}件中 {1}件完了", todos.length, todos.filter(item => typeof item === 'object' && item !== null && (item as Record<string, unknown>).status === 'completed').length)
				: undefined;
			return { label, icon: 'checklist', arg };
		}
		case 'Task':
		case 'Agent':
			return { label, icon: 'person', arg: oneLine(use.text) };
		case 'Skill':
			return { label, icon: 'sparkle', arg: nonEmpty(input?.skill) ?? oneLine(use.text) };
		case 'ToolSearch':
		case 'tool_search':
			return { label, icon: 'search', arg: nonEmpty(input?.query) ?? oneLine(use.text) };
		case 'view_image':
			return { label, icon: 'file-media', arg: filePathArg(input) };
		default:
			return { label, icon: 'tools', arg: oneLine(use.text) };
	}
}

function describeMeta(tool: string, input: Record<string, unknown> | undefined, use: IParadisAgentChatMessage, result: IParadisAgentChatMessage | undefined, failed: boolean): string | undefined {
	if (result === undefined) {
		return undefined;
	}
	if (failed) {
		return localize('paradisAgentChat.failed', "失敗");
	}
	if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'apply_patch') {
		const diff = paradisAgentChatEditDiff(tool, use.text);
		if (diff !== undefined) {
			return `+${diff.added} −${diff.removed}`;
		}
	}
	if ((tool === 'Read' || tool === 'Grep' || tool === 'Glob') && !result.truncated) {
		const lines = paradisCountLines(result.text);
		if (lines > 0) {
			return tool === 'Read'
				? localize('paradisAgentChat.lines', "{0} 行", lines)
				: localize('paradisAgentChat.matches', "{0} 件", lines);
		}
	}
	if (use.ts !== undefined && result.ts !== undefined && result.ts > use.ts) {
		return formatDuration(result.ts - use.ts);
	}
	return undefined;
}

// ---- 差分カード ------------------------------------------------------------------------------

export interface IParadisAgentChatDiffRow {
	readonly kind: 'add' | 'del' | 'ctx' | 'hunk';
	readonly text: string;
}

export interface IParadisAgentChatFileDiff {
	readonly path: string;
	readonly rows: readonly IParadisAgentChatDiffRow[];
}

export interface IParadisAgentChatEditDiff {
	readonly files: readonly IParadisAgentChatFileDiff[];
	readonly added: number;
	readonly removed: number;
}

/** 差分の前後に残す変更の無い行の数。 */
const DIFF_CONTEXT_LINES = 2;

function splitLines(text: string): string[] {
	return text.length === 0 ? [] : text.replace(/\r\n/g, '\n').split('\n');
}

/** 置き換え前後の文字列から、行単位の差分を作る（前後の変更の無い行は少しだけ残す）。 */
export function paradisLineDiffRows(before: string, after: string): IParadisAgentChatDiffRow[] {
	const original = splitLines(before);
	const modified = splitLines(after);
	const changes = new LcsDiff({ getElements: () => original }, { getElements: () => modified }).ComputeDiff(false).changes;
	const rows: IParadisAgentChatDiffRow[] = [];
	let originalIndex = 0;
	for (const change of changes) {
		const unchangedEnd = change.originalStart;
		const gap = unchangedEnd - originalIndex;
		if (gap > DIFF_CONTEXT_LINES * 2 && originalIndex > 0) {
			for (let index = originalIndex; index < originalIndex + DIFF_CONTEXT_LINES; index++) {
				rows.push({ kind: 'ctx', text: original[index] });
			}
			rows.push({ kind: 'hunk', text: '⋯' });
			for (let index = unchangedEnd - DIFF_CONTEXT_LINES; index < unchangedEnd; index++) {
				rows.push({ kind: 'ctx', text: original[index] });
			}
		} else {
			for (let index = Math.max(originalIndex, originalIndex === 0 ? unchangedEnd - DIFF_CONTEXT_LINES : originalIndex); index < unchangedEnd; index++) {
				rows.push({ kind: 'ctx', text: original[index] });
			}
		}
		for (let index = change.originalStart; index < change.originalStart + change.originalLength; index++) {
			rows.push({ kind: 'del', text: original[index] });
		}
		for (let index = change.modifiedStart; index < change.modifiedStart + change.modifiedLength; index++) {
			rows.push({ kind: 'add', text: modified[index] });
		}
		originalIndex = change.originalStart + change.originalLength;
	}
	for (let index = originalIndex; index < Math.min(original.length, originalIndex + DIFF_CONTEXT_LINES); index++) {
		rows.push({ kind: 'ctx', text: original[index] });
	}
	return rows;
}

/** Codex の apply_patch の入力から、パッチ本文を取り出す（生の本文か、JSON の input / patch）。 */
export function paradisApplyPatchText(text: string): string | undefined {
	if (text.trimStart().startsWith('*** Begin Patch')) {
		return text;
	}
	const input = paradisParseToolInput(text);
	const candidate = nonEmpty(input?.input) ?? nonEmpty(input?.patch);
	if (candidate?.trimStart().startsWith('*** Begin Patch')) {
		return candidate;
	}
	const command = input?.command;
	if (Array.isArray(command)) {
		const patch = command.find((part): part is string => typeof part === 'string' && part.trimStart().startsWith('*** Begin Patch'));
		if (patch !== undefined) {
			return patch;
		}
	}
	return undefined;
}

/** apply_patch の本文（`*** Begin Patch` 形式）を、ファイルごとの差分へ分ける。 */
export function paradisParseApplyPatch(patch: string): IParadisAgentChatFileDiff[] {
	const files: { path: string; rows: IParadisAgentChatDiffRow[] }[] = [];
	let current: { path: string; rows: IParadisAgentChatDiffRow[] } | undefined;
	for (const line of splitLines(patch)) {
		const header = /^\*\*\* (?<action>Update|Add|Delete) File: (?<path>.+)$/.exec(line);
		if (header?.groups !== undefined) {
			current = { path: header.groups.path.trim(), rows: [] };
			files.push(current);
			continue;
		}
		if (current === undefined || line.startsWith('*** ')) {
			continue;
		}
		if (line.startsWith('@@')) {
			current.rows.push({ kind: 'hunk', text: line.slice(2).trim() || '⋯' });
		} else if (line.startsWith('+')) {
			current.rows.push({ kind: 'add', text: line.slice(1) });
		} else if (line.startsWith('-')) {
			current.rows.push({ kind: 'del', text: line.slice(1) });
		} else if (line.startsWith(' ')) {
			current.rows.push({ kind: 'ctx', text: line.slice(1) });
		}
	}
	return files;
}

/**
 * ファイルを書き換えるツールの入力から、差分カードの中身を作る。書き換えるツールでない・入力が
 * 読めない（切り詰められた JSON など）なら undefined。
 */
export function paradisAgentChatEditDiff(tool: string | undefined, inputText: string): IParadisAgentChatEditDiff | undefined {
	let files: IParadisAgentChatFileDiff[] | undefined;
	if (tool === 'apply_patch' || (tool !== undefined && /^(shell|exec_command)$/.test(tool) && inputText.includes('*** Begin Patch'))) {
		const patch = paradisApplyPatchText(inputText);
		files = patch !== undefined ? paradisParseApplyPatch(patch) : undefined;
	} else if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write') {
		const input = paradisParseToolInput(inputText);
		const path = nonEmpty(input?.file_path);
		if (input === undefined || path === undefined) {
			return undefined;
		}
		if (tool === 'Write') {
			const content = typeof input.content === 'string' ? input.content : undefined;
			files = content === undefined ? undefined : [{ path, rows: splitLines(content).map(text => ({ kind: 'add' as const, text })) }];
		} else if (tool === 'Edit') {
			const before = typeof input.old_string === 'string' ? input.old_string : undefined;
			const after = typeof input.new_string === 'string' ? input.new_string : undefined;
			files = before === undefined || after === undefined ? undefined : [{ path, rows: paradisLineDiffRows(before, after) }];
		} else {
			const edits = Array.isArray(input.edits) ? input.edits : [];
			const rows: IParadisAgentChatDiffRow[] = [];
			for (const edit of edits) {
				const record = typeof edit === 'object' && edit !== null ? edit as Record<string, unknown> : undefined;
				const before = typeof record?.old_string === 'string' ? record.old_string : undefined;
				const after = typeof record?.new_string === 'string' ? record.new_string : undefined;
				if (before !== undefined && after !== undefined) {
					if (rows.length > 0) {
						rows.push({ kind: 'hunk', text: '⋯' });
					}
					rows.push(...paradisLineDiffRows(before, after));
				}
			}
			files = rows.length > 0 ? [{ path, rows }] : undefined;
		}
	}
	if (files === undefined || files.length === 0) {
		return undefined;
	}
	let added = 0;
	let removed = 0;
	for (const file of files) {
		for (const row of file.rows) {
			added += row.kind === 'add' ? 1 : 0;
			removed += row.kind === 'del' ? 1 : 0;
		}
	}
	return { files, added, removed };
}
