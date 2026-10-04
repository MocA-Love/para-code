// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 許可のカードに出す中身の組み立て（`agent.approval.detail.v1`。`mobile-approval-detail-mock.html` の案 A + 案 C）。
 *
 * PC は承認に操作の中身（`request`。ツールごとに項目を分けたもの）を載せてくる。ここではそれを、見出し・送り元・
 * 危険の札の材料・Edit の差分の行・URL の分け方・ボタンの並びにする。古い PC（`request` が無い）は、今までの
 * `detail`（「ツール名: 説明」の 1 行）をそのまま出す。副作用の無い関数だけを置く。
 */

import type { IParadisAgentApprovalAgent, IParadisAgentApprovalRequest, ParadisAgentApprovalSuggestionScope } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisAgentApprovalRequest.js';
import { dangerousCommandLabels, type DangerousCommandLabel } from './dangerousCommand.js';
import type { AgentApprovalChoice } from './store.js';

/** カードの見出し（何をしてよいかを問う形）。 */
export function approvalHeading(request: IParadisAgentApprovalRequest | undefined, fallback: string | undefined): string {
	switch (request?.kind) {
		case 'bash': return `${request.tool} を実行してよいか`;
		case 'edit': return 'ファイルを編集してよいか';
		case 'write': return 'ファイルを書き込んでよいか';
		case 'fetch': return 'Web ページを取得してよいか';
		case 'mcp': return 'MCP ツールを使ってよいか';
		case 'other': return `${request.tool} を使ってよいか`;
		default: return fallback ?? 'エージェントが確認を求めています';
	}
}

/** 送り元の 1 行（サブエージェントからの許可だけ。本会話からの許可は undefined）。 */
export function approvalSender(agent: IParadisAgentApprovalAgent | undefined): { readonly name: string; readonly role: string } | undefined {
	if (agent === undefined) {
		return undefined;
	}
	const name = agent.name ?? agent.id;
	return name !== undefined ? { name, role: agent.role === 'teammate' ? 'チームメイト' : 'サブエージェント' } : undefined;
}

/** 形を知らないツールの入力のうち、文章を書く項目（危険の札の判定から外す）。 */
const PROSE_ARG_KEYS: ReadonlySet<string> = new Set(['prompt', 'description', 'message', 'text', 'content', 'query', 'title', 'body', 'summary', 'instructions', 'question', 'subject', 'reason', 'notes', 'plan']);

/**
 * 危険の札。コマンドは全文を見る（説明しか届かなかった頃は `rm` を見落としていた）。中身が無い古い PC は、
 * 今までどおり見出しと詳細の文字から拾う。
 */
export function approvalDangers(request: IParadisAgentApprovalRequest | undefined, title: string | undefined, detail: string | undefined): DangerousCommandLabel[] {
	if (request?.kind === 'bash' && request.command !== undefined) {
		return dangerousCommandLabels(request.command);
	}
	if ((request?.kind === 'mcp' || request?.kind === 'other') && request.args !== undefined) {
		// 引数の値（SQL・シェルの文など）から拾う。形を知らないツール（Agent・Task など）の文章の項目（依頼文・説明）は
		// 「rm -rf を使わずに」のような地の文でも札が付いてしまうので外す
		const args = request.kind === 'other' ? request.args.filter(arg => !PROSE_ARG_KEYS.has(arg.key.toLowerCase())) : request.args;
		return dangerousCommandLabels(args.map(arg => arg.value).join('\n'));
	}
	if (request !== undefined) {
		return [];
	}
	return dangerousCommandLabels([title, detail].filter((part): part is string => part !== undefined).join('\n'));
}

/** 行数を測る写しに渡す文字数（1 行あたり）。上限の行数 + 1 行ぶんあれば、上限を超えるかどうかは分かる。 */
const MEASURE_CHARS_PER_LINE = 200;

/** 行数を測る写しに渡す文（上限の行数 + 1 行ぶんで切る。10,000 字のコマンドを丸ごと 2 回組まないため）。 */
export function approvalMeasureCopy(text: string, lines: number): string {
	return text.slice(0, (lines + 1) * MEASURE_CHARS_PER_LINE);
}

/** 等幅の枠に出す行数の数え方（末尾の改行は数えない）。 */
export function approvalLineCount(text: string): number {
	return text.length === 0 ? 0 : text.replace(/\n$/, '').split('\n').length;
}

/** Edit の差分の 1 行。 */
export interface ApprovalDiffLine {
	readonly kind: 'del' | 'add' | 'ctx';
	readonly text: string;
}

/**
 * Edit の置き換え前と置き換え後から、差分の行を作る。前後で同じ行は外し（`@@ 1 か所` の代わりに省いた行数を返す）、
 * 消える行・足される行の順に並べる。`limit` を超えた行は数だけ返す（カードは先頭だけ、シートは全部）。
 */
export function approvalEditDiff(oldText: string, newText: string, limit = Number.POSITIVE_INFINITY): { readonly lines: readonly ApprovalDiffLine[]; readonly hidden: number } {
	const before = oldText.length > 0 ? oldText.split('\n') : [];
	const after = newText.length > 0 ? newText.split('\n') : [];
	let head = 0;
	while (head < before.length && head < after.length && before[head] === after[head]) {
		head++;
	}
	let tail = 0;
	while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) {
		tail++;
	}
	const all: ApprovalDiffLine[] = [
		...before.slice(head, before.length - tail).map(text => ({ kind: 'del' as const, text })),
		...after.slice(head, after.length - tail).map(text => ({ kind: 'add' as const, text })),
	];
	if (all.length === 0 && (before.length > 0 || after.length > 0)) {
		// 行は同じで、違いが無い（空白だけの違いなど）。置き換え後をそのまま見せる
		all.push(...after.map(text => ({ kind: 'ctx' as const, text })));
	}
	const shown = all.slice(0, limit);
	return { lines: shown, hidden: all.length - shown.length };
}

/** URL を、スキーム・ホスト（強調する）・残りに分ける。読めなければ全体を残りとして返す。 */
export function approvalUrlParts(url: string): { readonly scheme: string; readonly host: string; readonly rest: string } {
	const match = /^(?<scheme>[a-z][a-z0-9+.-]*:\/\/)(?<host>[^/?#]+)(?<rest>.*)$/i.exec(url);
	return match?.groups !== undefined
		? { scheme: match.groups.scheme ?? '', host: match.groups.host ?? '', rest: match.groups.rest ?? '' }
		: { scheme: '', host: '', rest: url };
}

/** 「以後は確認しない」に当たる選択肢か（mod の `always` と、画面の 2 番以降の `Yes, …`）。 */
export function isAlwaysApprovalChoice(choice: AgentApprovalChoice, screenLabel: string | undefined): boolean {
	if (choice.id === 'always') {
		return true;
	}
	const n = /^opt:(?<n>[1-9])$/.exec(choice.id)?.groups?.n;
	return n !== undefined && Number(n) > 1 && /^yes\b/i.test((screenLabel ?? choice.label).trim());
}

/** 「以後は確認しない」のボタンの文言（足されるものの残り方で書き分ける。設定ファイルに書かれるものは「設定に残す」）。 */
export function alwaysApprovalTitle(scope: ParadisAgentApprovalSuggestionScope | undefined): string {
	switch (scope) {
		case 'settings': return '許可して、設定に残す';
		case 'mode': return '許可して、モードを切り替える';
		default: return '許可して、このセッションでは確認しない';
	}
}

/** カードに並べるボタン 1 つ。 */
export interface ApprovalButton {
	readonly choice: AgentApprovalChoice;
	readonly variant: 'primary' | 'secondary' | 'destructive';
	/** ボタンの文字。 */
	readonly title: string;
	/** ボタンの下に等幅で添える文（足されるルール）。 */
	readonly rule?: string;
}

/**
 * ボタンの並び（許可を左・上に置く。決定 7）。主ボタン（最初の許可）→「以後は確認しない」→ その他 → 拒否。
 *
 * - 「以後は確認しない」は 2 番手のボタンにし、その選択肢も候補（`suggestions`）も 1 つなら、残り方の文言とルールに置き換える
 *   （決定 4）。どちらかが 2 つ以上・候補が届いていない（Codex）ものは文言のまま出す。mod の `always` は候補が無ければ出さない
 * - 「拒否して指示を書く」は呼び出し側が 2 番手として足す（決定 3）
 */
export function approvalButtons(choices: readonly AgentApprovalChoice[], options: {
	readonly screenLabels?: ReadonlyMap<string, string>;
	readonly suggestions?: readonly string[];
	readonly scope?: ParadisAgentApprovalSuggestionScope;
}): ApprovalButton[] {
	const primary = choices.find(choice => choice.tone === 'approve' && !isAlwaysApprovalChoice(choice, options.screenLabels?.get(choice.id)));
	const always: ApprovalButton[] = [];
	const others: ApprovalButton[] = [];
	const deny: ApprovalButton[] = [];
	// 文言とルールに置き換えるのは、「以後は確認しない」の選択肢がちょうど 1 つで、候補もちょうど 1 つのときだけ。
	// どちらかが 2 つ以上だと、どの選択肢がどの候補を足すのかをこちらで決められない（文言のまま出し、ルールは付けない）
	const alwaysCount = choices.filter(choice => isAlwaysApprovalChoice(choice, options.screenLabels?.get(choice.id))).length;
	const suggestionCount = options.suggestions?.length ?? 0;
	const rules = alwaysCount === 1 && suggestionCount === 1 ? options.suggestions?.[0] : undefined;
	for (const choice of choices) {
		if (choice === primary) {
			continue;
		}
		if (isAlwaysApprovalChoice(choice, options.screenLabels?.get(choice.id))) {
			if (rules !== undefined) {
				always.push({ choice, variant: 'secondary', title: alwaysApprovalTitle(options.scope), rule: rules });
			} else if (choice.id !== 'always' || suggestionCount > 0) {
				// 置き換えられないもの（mod の `always` は PC が候補を並べた文言）と、候補が届いていない画面の選択肢
				// （Codex の「Yes, and don't ask again for this command」は hook に候補が無い）は、文言のまま 2 番手に出す。
				// Claude Code は候補があるときだけこの選択肢を出す。mod の `always` は候補が無ければ出さない
				always.push({ choice, variant: 'secondary', title: choice.label });
			}
			continue;
		}
		if (choice.tone === 'deny') {
			deny.push({ choice, variant: 'destructive', title: choice.label });
		} else {
			others.push({ choice, variant: 'secondary', title: choice.label });
		}
	}
	return [
		...(primary !== undefined ? [{ choice: primary, variant: 'primary' as const, title: primary.label }] : []),
		...always, ...others, ...deny,
	];
}
