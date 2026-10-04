/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 許可の確認の画面に出ている番号付きの選択肢を読む（Orca W2-21）。
 *
 * スマホの承認カードに PC と同じ選択肢（「2. Yes, and don't ask again for …」など）を並べるため、
 * renderer が見えている画面の文字から選択肢を拾う。hook の `permission_suggestions` から作らないのは、
 * 候補と画面の番号の対応が保証されないため（送るのは画面の番号なので、画面から読めばずれない）。
 *
 * 送る直前にもう一度読み、その番号の行が同じ文言かを確かめる（{@link paradisApprovalOptionLabelsMatch}）。
 * 違っていたら送らない（押した選択肢と違うものを確定させないため）。
 *
 * 副作用の無い関数だけを置く（テストで画面の文字を直接渡して確かめる）。
 */

/** capability の名前。PC がこれを広告していれば、アプリは `approval-options` を求め、`opt:<n>` で答えられる。 */
export const PARADIS_AGENT_APPROVAL_OPTIONS_CAPABILITY = 'agent.approval.options.v1';

/** 画面から読んだ選択肢 1 つ。モバイルへ送るのは `n` と `label` だけ。 */
export interface IParadisAgentApprovalOption {
	/** 画面の番号（1 起点、1〜9）。 */
	readonly n: number;
	/** 画面の文言（折り返しをつないで空白を 1 つに均したもの）。 */
	readonly label: string;
}

/** 画面から読んだ選択肢（送るキーの判断に要る、行末の `(esc)` / `(y)` などの近道も持つ）。 */
export interface IParadisAgentApprovalScreenOption extends IParadisAgentApprovalOption {
	/** 行末の `(…)` に書かれた近道のキー（`esc` は ESC の文字）。無ければ undefined。 */
	readonly shortcut?: string;
}

/**
 * 選択肢を求められてから、確認の画面が出るのを待つ上限。hook（承認カードの元）は画面の描画より先に届くので、
 * カードが出た直後の求めでは画面がまだ無いことがある。
 */
export const PARADIS_APPROVAL_OPTIONS_WAIT_MS = 3_000;

/** 選択肢の数の上限（数字 1 文字で選べる範囲）。 */
const MAX_OPTIONS = 9;
/** 文言 1 つの長さの上限（モバイルへ送る量を抑える）。 */
const MAX_LABEL_LENGTH = 300;
/** 画面の下端から探す行数。確認の画面は常に最下部に出る。 */
const REGION_LINES = 30;

/** 選択肢の行（`❯ 1. Yes` / `› 1. Yes, proceed (y)` / `  2) No`。枠の縦線 `│` の内側でもよい）。 */
const OPTION_LINE = /^(?<lead>[\s│┃|]*(?:[❯›>▶]\s*)?)(?<n>[1-9])[.)]\s+(?<label>\S.*)$/;
/** 2 桁以上の番号の行。 */
const TWO_DIGIT_OPTION_LINE = /^[\s│┃|]*(?:[❯›>▶]\s*)?[1-9][0-9]+[.)]\s+\S/;
/** 行末の枠の縦線。 */
const TRAILING_BORDER = /\s*[│┃|]\s*$/;
/** 行頭の枠の縦線。 */
const LEADING_BORDER = /^[\s]*[│┃|]/;
/** 行末の近道（Codex の `(y)` / `(a)` / `(esc)`、Claude の `(esc)` / `(shift+tab)`）。 */
const TRAILING_SHORTCUT = /\((?<key>esc|[a-z])\)\s*$/;

function normalizeLabel(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function stripBorders(line: string): string {
	return line.replace(TRAILING_BORDER, '');
}

/**
 * 画面の下端から、番号 1 から順に並んだ選択肢の一覧を読む。2 つ以上読めなければ undefined。
 *
 * - いちばん下にある「1 から始まる連番」の並びを採る（上に残っている会話の本文の番号付きの箇条書きは拾わない）
 * - 番号の行より深く字下げされた続きの行は、直前の選択肢の文言の折り返しとしてつなぐ
 * - 空行か、字下げの浅い行が来たら並びは終わる（下の操作説明 `Esc to cancel` などを拾わない）
 * - 10 個以上ある並びは扱わない（数字 1 文字で選べないため）
 */
export function paradisParseApprovalOptions(screen: string): readonly IParadisAgentApprovalScreenOption[] | undefined {
	const lines = screen.split('\n');
	while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim().length === 0) {
		lines.pop();
	}
	const region = lines.slice(-REGION_LINES);
	let best: { n: number; label: string }[] | undefined;
	let current: { n: number; label: string }[] | undefined;
	let labelColumn = 0;
	let numberColumn = 0;
	const finish = () => {
		if (current !== undefined && current.length >= 2) {
			best = current;
		}
		current = undefined;
	};
	/** 空行より前に、次の番号（`next`）の選択肢の行が続くか。 */
	const nextOptionFollows = (from: number, next: number): boolean => {
		for (let index = from; index < region.length; index++) {
			const candidate = stripBorders(region[index] ?? '');
			if (candidate.replace(LEADING_BORDER, '').trim().length === 0) {
				return false;
			}
			const groups = OPTION_LINE.exec(candidate)?.groups;
			if (groups !== undefined) {
				return Number(groups.n) === next;
			}
		}
		return false;
	};
	for (let lineIndex = 0; lineIndex < region.length; lineIndex++) {
		const rawLine = region[lineIndex] ?? '';
		const line = stripBorders(rawLine);
		if (TWO_DIGIT_OPTION_LINE.test(line)) {
			// 10 番目以降がある並びは数字 1 文字で選べない。並びごと捨てる。
			current = undefined;
			continue;
		}
		const groups = OPTION_LINE.exec(line)?.groups;
		if (groups !== undefined) {
			const n = Number(groups.n);
			const lead = groups.lead ?? '';
			const label = groups.label ?? '';
			if (n === 1) {
				finish();
				current = [{ n, label }];
			} else if (current !== undefined && n === current.length + 1) {
				current.push({ n, label });
			} else {
				// 連番が途切れた（本文の箇条書きなど）。この並びは選択肢ではない。
				current = undefined;
				continue;
			}
			numberColumn = lead.length;
			labelColumn = line.length - label.length;
			continue;
		}
		if (current === undefined) {
			continue;
		}
		// 枠の縦線は字下げの 1 文字として数える（選択肢の行の lead も同じ数え方）。
		const content = line.replace(LEADING_BORDER, match => ' '.repeat(match.length));
		if (content.trim().length === 0) {
			finish();
			continue;
		}
		const indent = content.length - content.trimStart().length;
		// 深く字下げされた行は折り返しの続き。浅い行（端末の自動折り返しで 0 桁目から続いた行など）も、空行より前に次の番号の
		// 選択肢が続くなら、途中の選択肢の続きとみなす（シミュレータ確認の気づき (a)）。
		if ((indent > numberColumn && indent >= Math.min(labelColumn, numberColumn + 2)) || nextOptionFollows(lineIndex + 1, current.length + 1)) {
			const last = current[current.length - 1];
			if (last !== undefined) {
				last.label = `${last.label} ${content.trim()}`;
			}
			continue;
		}
		finish();
	}
	finish();
	if (best === undefined || best.length > MAX_OPTIONS) {
		return undefined;
	}
	return best.map(option => {
		const label = normalizeLabel(option.label).slice(0, MAX_LABEL_LENGTH);
		const shortcut = TRAILING_SHORTCUT.exec(label)?.groups?.key;
		return shortcut !== undefined ? { n: option.n, label, shortcut } : { n: option.n, label };
	});
}

/** 許可の確認の枠の中で、コマンドの上下に引かれる点線（Claude Code 2.1.289 の実画面: `╌╌╌…`）。 */
const DASHED_RULE_LINE = /^[\s│┃|]*╌{8,}[\s│┃|]*$/;
/** 理由を言わない定型の行（空白を除いた小文字）。警告として出さない。 */
const GENERIC_WARNINGS: readonly string[] = ['thiscommandrequiresapproval'];
/** 警告の行の数と長さの上限（これを超えるものは警告ではなく本文とみなす）。 */
const MAX_WARNING_LINES = 3;
const MAX_WARNING_LENGTH = 300;

/**
 * 許可の確認の見出しの上に出ている警告の行（`This shell -c script runs rm and could not be checked` など）を読む。
 * 警告は hook の入力に無く、Claude Code が判定の理由として画面にだけ書く（2.1.289 で実測）。
 *
 * `context` は {@link paradisPermissionPromptParts}（agentChat/browser/paradisAgentTuiInput.ts）が切り出した、見出しの行と
 * その上の行。Claude Code の Bash の確認は「Bash command / 説明 / 点線 / コマンド / 点線 / 警告 / 見出し」の形なので、
 * 最後の点線と見出しの間の行を警告とする。点線が無い（Edit などの確認・Codex）・定型の行だけ・長すぎるときは undefined。
 */
export function paradisParsePermissionWarning(context: string): string | undefined {
	const lines = context.split('\n');
	let separator = -1;
	for (let index = lines.length - 2; index >= 0; index--) {
		if (DASHED_RULE_LINE.test(lines[index] ?? '')) {
			separator = index;
			break;
		}
	}
	if (separator < 0) {
		return undefined;
	}
	const body = lines.slice(separator + 1, lines.length - 1)
		.map(line => line.replace(/^[\s│┃|]+/, '').replace(/[\s│┃|]+$/, ''))
		.filter(line => line.length > 0);
	if (body.length === 0 || body.length > MAX_WARNING_LINES) {
		return undefined;
	}
	const warning = normalizeLabel(body.join(' '));
	if (warning.length > MAX_WARNING_LENGTH || GENERIC_WARNINGS.includes(warning.replace(/\s+/g, '').toLowerCase())) {
		return undefined;
	}
	return warning;
}

/** 届いた `warning` を読む（アプリが使う）。 */
export function paradisReadPermissionWarning(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_WARNING_LENGTH ? value : undefined;
}

/**
 * 2 つの文言が同じ選択肢を指すか。空白（折り返しの位置の違い）と大文字小文字は見ない。
 * ペインの幅が変わって折り返しの位置が動いても、同じ選択肢なら一致する。
 */
export function paradisApprovalOptionLabelsMatch(a: string, b: string): boolean {
	const compact = (text: string) => text.replace(/\s+/g, '').toLowerCase();
	return compact(a).length > 0 && compact(a) === compact(b);
}

/** 中継から届いた「確かめる選択肢」（`{ n, label }`）を読む。形が違えば undefined。 */
export function paradisReadExpectedApprovalOption(value: unknown): IParadisAgentApprovalOption | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const { n, label } = value as { readonly n?: unknown; readonly label?: unknown };
	return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_OPTIONS && typeof label === 'string' && label.length > 0 && label.length <= 500
		? { n, label }
		: undefined;
}

/** 承認の回答 `opt:<n>`（n は 1〜9）から番号を取り出す。形が違えば undefined。 */
export function paradisParseApprovalOptionChoice(choice: string): number | undefined {
	const match = /^opt:(?<n>[1-9])$/.exec(choice);
	return match?.groups !== undefined ? Number(match.groups.n) : undefined;
}

/**
 * 選んだ選択肢を確定させるキー。
 *
 * - Claude Code は数字で即確定する。**数字 1 文字だけを送り、Enter は送らない**（後から送った Enter が次の入力に
 *   漏れ、次に出た同じ内容の許可を確定した。paradisAgentApprovalKeySequence の説明を参照）
 * - Codex は行末の近道（`(y)` / `(a)` / `(esc)`）を送る。近道の無い行は数字で確定するかを確かめていないので
 *   送らない（undefined。呼び出し側は断る）
 */
export function paradisApprovalOptionKey(agent: 'claude' | 'codex', option: IParadisAgentApprovalScreenOption): string | undefined {
	if (agent === 'claude') {
		return String(option.n);
	}
	if (option.shortcut === undefined) {
		return undefined;
	}
	return option.shortcut === 'esc' ? '\u001b' : option.shortcut;
}

/**
 * モバイルへ渡してよい選択肢の一覧にする。Codex は全部の行に近道が無ければ出さない（1 つでも送れない行があると、
 * スマホで選べるのに送れない選択肢ができるため）。
 */
export function paradisApprovalOptionsForMobile(agent: 'claude' | 'codex', options: readonly IParadisAgentApprovalScreenOption[] | undefined): readonly IParadisAgentApprovalOption[] | undefined {
	if (options === undefined || options.length < 2) {
		return undefined;
	}
	if (options.some(option => paradisApprovalOptionKey(agent, option) === undefined)) {
		return undefined;
	}
	return options.map(option => ({ n: option.n, label: option.label }));
}

/**
 * PermissionRequest hook の `permission_suggestions`（Claude Code が「今後は確認しない」で足す規則の候補）を、
 * 表示の補助に使う短い文字列にする。**キーを決めるのには使わない**（候補と画面の番号の対応は保証されない）。
 *
 * 形は Claude Code の hook の説明にある `{ type: 'addRules', rules: [{ toolName, ruleContent }] }` /
 * `{ type: 'setMode', mode }` / `{ type: 'addDirectories', directories }`。【要確認】実機の hook 入力で
 * この形を確かめていない。知らない形は黙って捨てる。
 */
export function paradisApprovalSuggestionLabels(suggestions: unknown): readonly string[] | undefined {
	if (!Array.isArray(suggestions)) {
		return undefined;
	}
	const labels: string[] = [];
	const push = (label: string) => {
		const trimmed = label.replace(/\s+/g, ' ').trim().slice(0, 200);
		if (trimmed.length > 0 && !labels.includes(trimmed) && labels.length < 5) {
			labels.push(trimmed);
		}
	};
	for (const suggestion of suggestions.slice(0, 20)) {
		if (typeof suggestion !== 'object' || suggestion === null) {
			continue;
		}
		const entry = suggestion as { readonly type?: unknown; readonly rules?: unknown; readonly mode?: unknown; readonly directories?: unknown };
		if (entry.type === 'addRules' && Array.isArray(entry.rules)) {
			for (const rule of entry.rules.slice(0, 10)) {
				const { toolName, ruleContent } = (typeof rule === 'object' && rule !== null ? rule : {}) as { readonly toolName?: unknown; readonly ruleContent?: unknown };
				if (typeof toolName === 'string' && toolName.length > 0) {
					push(typeof ruleContent === 'string' && ruleContent.length > 0 ? `${toolName}(${ruleContent})` : toolName);
				}
			}
		} else if (entry.type === 'setMode' && typeof entry.mode === 'string') {
			push(`mode: ${entry.mode}`);
		} else if (entry.type === 'addDirectories' && Array.isArray(entry.directories)) {
			for (const directory of entry.directories.slice(0, 5)) {
				if (typeof directory === 'string') {
					push(directory);
				}
			}
		}
	}
	return labels.length > 0 ? labels : undefined;
}
