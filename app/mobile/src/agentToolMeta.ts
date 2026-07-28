// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { AgentActivityDetailMessage, AgentChatMessage } from './store.js';

/**
 * エージェントのアクティビティ（thinking / tool_use / tool_result）を、
 * タイムライン表示に必要な形へ解釈する純ロジック。UIを持たないのでテストしやすい。
 *
 * PC側 (paradisMobileAgentChat.ts) は tool_use の text に「入力JSONの文字列」を、
 * tool_result の text に「結果を平坦化したテキスト」を入れて送ってくる（Task/web_search
 * だけは可読な文字列に整形済み）。ここではその前提でJSONを解いてヘッダー行の要約を作る。
 */

/** タイムラインの1ステップ。tool_use とその結果を1つにまとめて扱う。 */
export interface AgentTimelineStep {
	readonly key: string;
	readonly kind: 'thinking' | 'tool';
	/** kind==='thinking' の本文。 */
	readonly thinking?: AgentChatMessage;
	/** kind==='tool' の呼び出し。 */
	readonly use?: AgentChatMessage;
	/** kind==='tool' の結果（未完了なら undefined）。 */
	readonly result?: AgentChatMessage;
}

/** ヘッダー行に出す見た目の情報。 */
export interface AgentToolDescription {
	/** 主名称（Bash / Read / search_issues など）。 */
	readonly label: string;
	/** MCPのサーバー名など従属表示（' · sentry'）。 */
	readonly namespace?: string;
	/** 引数の1行要約（モノスペースで省略表示する）。 */
	readonly arg?: string;
	/** Ionicons の名前。 */
	readonly icon: string;
	/** ステップの色調。 */
	readonly tone: AgentStepTone;
}

export type AgentStepTone = 'default' | 'thinking' | 'mcp' | 'agent' | 'approval' | 'error' | 'live';

/** ヘッダー右端に1つだけ出すメタ値。 */
export interface AgentStepMeta {
	readonly text: string;
	readonly tone: 'default' | 'good' | 'bad' | 'warn';
}

/**
 * ツール名の表示整形。MCPツールの内部名（mcp__sentry__search_issues）は読みにくいため、
 * 「search_issues · sentry」の形に直す。それ以外はそのまま。
 */
export function formatToolName(tool: string): string {
	const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
	// allow-any-unicode-next-line
	return mcp ? `${mcp[2]} · ${mcp[1]}` : tool;
}

/** MCPツールなら { server, tool } に分解する。 */
export function splitMcpTool(tool: string): { server: string; tool: string } | undefined {
	const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
	return mcp !== null && mcp[1] !== undefined && mcp[2] !== undefined ? { server: mcp[1], tool: mcp[2] } : undefined;
}

/** tool_use の text（入力JSON）をオブジェクトへ戻す。JSONでなければ undefined。 */
export function parseToolInput(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith('{')) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		// PC側で1500文字に切り詰められたJSONはパースできない。要約はテキストのまま使う。
		return undefined;
	}
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** パスの末尾要素。長い絶対パスをヘッダーに出すと引数が読めなくなるため。 */
export function basename(path: string): string {
	const parts = path.split('/');
	return parts[parts.length - 1] ?? path;
}

/** 連続する改行・空白を潰して1行にする（ヘッダーの引数要約用）。 */
function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * 連続する thinking / tool_use / tool_result を、タイムラインのステップ列へ組み直す。
 * tool_use と tool_result は toolUseId で対応付け、IDが無い経路（Codexの一部）は
 * 直近の未解決 tool_use へ順番に割り当てる。
 */
export function buildTimelineSteps(msgs: readonly AgentChatMessage[]): AgentTimelineStep[] {
	const steps: AgentTimelineStep[] = [];
	const byId = new Map<string, number>();
	const pending: number[] = [];
	for (const message of msgs) {
		if (message.kind === 'thinking') {
			steps.push({ key: `t:${message.rev}`, kind: 'thinking', thinking: message });
			continue;
		}
		if (message.kind === 'tool_use') {
			const index = steps.length;
			steps.push({ key: `u:${message.rev}`, kind: 'tool', use: message });
			if (message.toolUseId !== undefined) {
				byId.set(message.toolUseId, index);
			} else {
				pending.push(index);
			}
			continue;
		}
		if (message.kind === 'tool_result') {
			const index = message.toolUseId !== undefined ? byId.get(message.toolUseId) : pending.shift();
			const target = index !== undefined ? steps[index] : undefined;
			if (index !== undefined && target !== undefined && target.result === undefined) {
				steps[index] = { ...target, result: message };
			} else {
				// 対応する呼び出しが（履歴の切り詰め等で）欠けている結果は単独ステップにする。
				steps.push({ key: `r:${message.rev}`, kind: 'tool', result: message });
			}
			continue;
		}
		// text / question / peer_message はこの集約に入らない（呼び出し側で分離済み）。
	}
	return steps;
}

/**
 * SubAgent詳細（agent-activity-detail）のメッセージを、親のチャット画面と同じ
 * タイムラインへ流し込める形に変換する。rev は親のtailerと無関係なので通し番号を振る
 * （この画面では全文のオンデマンド取得は使わない）。
 */
export function detailToChatMessages(messages: readonly AgentActivityDetailMessage[]): AgentChatMessage[] {
	return messages.map((message, index) => ({
		rev: index,
		role: message.role,
		kind: message.kind === 'thinking' ? 'thinking' : message.kind === 'tool' ? (message.toolKind ?? 'tool_use') : 'text',
		text: message.text,
		...(message.tool !== undefined ? { tool: message.tool } : {}),
		...(message.toolUseId !== undefined ? { toolUseId: message.toolUseId } : {}),
		...(message.ts !== undefined ? { ts: message.ts } : {}),
		...(message.isError === true ? { isError: true } : {}),
	}));
}

/**
 * ステップが失敗したか。PC側が transcript の is_error を送ってくるのでそれを正本にし、
 * 落ちている経路（古いPC・Codexの一部イベント）だけテキストから推定する。
 */
export function stepFailed(step: AgentTimelineStep): boolean {
	const result = step.result;
	if (result === undefined) {
		return false;
	}
	return result.isError === true || looksLikeError(result.text);
}

/** ツール結果がエラーらしいか（is_error が取れない経路のフォールバック）。 */
export function looksLikeError(text: string): boolean {
	const head = text.slice(0, 400);
	return /^\s*(error|エラー)\b/i.test(head)
		|| /\berror\s+TS\d+/.test(head)
		|| /\b(command not found|no such file or directory|permission denied)\b/i.test(head)
		|| /\bexit(?:ed with)? code\s*[1-9]/i.test(head)
		|| /^\s*\d{3}\s+(unauthorized|forbidden|not found|too many requests)/i.test(head);
}

/** ステップの見出し（アイコン・名前・引数）を決める。 */
export function describeStep(step: AgentTimelineStep): AgentToolDescription {
	if (step.kind === 'thinking') {
		return { label: 'Thinking', icon: 'bulb-outline', tone: 'thinking', arg: oneLine(step.thinking?.text ?? '') };
	}
	const use = step.use;
	if (use === undefined) {
		return { label: 'ツール結果', icon: 'return-down-forward-outline', tone: 'default', arg: oneLine(step.result?.text ?? '') };
	}
	const tool = use.tool ?? 'tool';
	const input = parseToolInput(use.text);
	const failed = stepFailed(step);
	const mcp = splitMcpTool(tool);
	if (mcp !== undefined) {
		return {
			label: mcp.tool,
			// allow-any-unicode-next-line
			namespace: ` · ${mcp.server}`,
			arg: describeMcpArg(input, use.text),
			icon: 'grid-outline',
			tone: failed ? 'error' : 'mcp',
		};
	}
	const tone: AgentStepTone = failed ? 'error' : 'default';
	switch (tool) {
		case 'approval_request':
			return { label: '許可要求', icon: 'lock-closed-outline', tone: 'approval', arg: oneLine(use.text) };
		case 'Bash':
		case 'BashOutput':
			return { label: 'Bash', icon: 'terminal-outline', tone, arg: str(input?.['command']) !== undefined ? oneLine(String(input?.['command'])) : oneLine(use.text) };
		case 'Read':
			return { label: 'Read', icon: 'document-text-outline', tone, arg: filePathArg(input) };
		case 'Write':
			return { label: 'Write', icon: 'document-outline', tone, arg: filePathArg(input) };
		case 'Edit':
		case 'NotebookEdit':
			return { label: 'Edit', icon: 'create-outline', tone, arg: filePathArg(input) };
		case 'Glob':
			return { label: 'Glob', icon: 'search-outline', tone, arg: str(input?.['pattern']) ?? oneLine(use.text) };
		case 'Grep':
			return { label: 'Grep', icon: 'search-outline', tone, arg: grepArg(input) ?? oneLine(use.text) };
		case 'web_search':
			return { label: 'Web検索', icon: 'search-outline', tone, arg: oneLine(use.text) };
		case 'WebFetch':
			return { label: 'ページ取得', icon: 'globe-outline', tone, arg: shortUrl(str(input?.['url'])) ?? oneLine(use.text) };
		case 'TodoWrite':
			return { label: 'タスク更新', icon: 'checkbox-outline', tone, arg: todoArg(input) };
		case 'Task':
		case 'Agent':
			// PC側で「description (subagent_type)」に整形済み。
			return { label: 'サブエージェント', icon: 'person-outline', tone: failed ? 'error' : 'agent', arg: oneLine(use.text) };
		case 'ToolSearch':
			return { label: 'ツール検索', icon: 'search-outline', tone, arg: str(input?.['query']) ?? oneLine(use.text) };
		case 'Skill':
			return { label: 'スキル', icon: 'sparkles-outline', tone, arg: str(input?.['skill']) ?? oneLine(use.text) };
		default:
			return { label: formatToolName(tool), icon: 'construct-outline', tone, arg: oneLine(use.text) };
	}
}

function filePathArg(input: Record<string, unknown> | undefined): string | undefined {
	const path = str(input?.['file_path']) ?? str(input?.['path']) ?? str(input?.['notebook_path']);
	return path !== undefined ? basename(path) : undefined;
}

function grepArg(input: Record<string, unknown> | undefined): string | undefined {
	const pattern = str(input?.['pattern']);
	if (pattern === undefined) {
		return undefined;
	}
	const glob = str(input?.['glob']) ?? str(input?.['path']);
	// allow-any-unicode-next-line
	return glob !== undefined ? `${pattern} · ${basename(glob)}` : pattern;
}

function todoArg(input: Record<string, unknown> | undefined): string | undefined {
	const todos = input?.['todos'];
	if (!Array.isArray(todos)) {
		return undefined;
	}
	const done = todos.filter(item => typeof item === 'object' && item !== null && (item as Record<string, unknown>)['status'] === 'completed').length;
	return `${todos.length}件中 ${done}件完了`;
}

function shortUrl(url: string | undefined): string | undefined {
	return url?.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** MCPの引数は形が読めないので、代表的なキーだけ拾って読める1行にする。 */
function describeMcpArg(input: Record<string, unknown> | undefined, raw: string): string | undefined {
	if (input === undefined) {
		return oneLine(raw);
	}
	for (const key of ['query', 'q', 'command', 'code', 'url', 'path', 'file_path', 'name', 'pattern', 'prompt']) {
		const value = str(input[key]);
		if (value !== undefined) {
			return oneLine(value);
		}
	}
	const keys = Object.keys(input);
	return keys.length > 0 ? oneLine(raw) : undefined;
}

/** 秒数を「4.2s」「1分12秒」の形にする。 */
function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 10) {
		return `${seconds.toFixed(1)}s`;
	}
	if (seconds < 60) {
		return `${Math.round(seconds)}s`;
	}
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}分${String(whole % 60).padStart(2, '0')}秒`;
}

/** テキストの行数（末尾の空行は数えない）。 */
export function countLines(text: string): number {
	const trimmed = text.replace(/\n+$/, '');
	return trimmed.length === 0 ? 0 : trimmed.split('\n').length;
}

/**
 * ヘッダー右端のメタ値。ツールごとに「一番知りたい1つ」を出す。
 * 迷ったら所要時間にフォールバックする。
 */
export function describeMeta(step: AgentTimelineStep): AgentStepMeta | undefined {
	if (step.kind === 'thinking') {
		return undefined;
	}
	const use = step.use;
	const result = step.result;
	if (use !== undefined && result === undefined) {
		return { text: '実行中', tone: 'warn' };
	}
	if (stepFailed(step)) {
		return { text: '失敗', tone: 'bad' };
	}
	const tool = use?.tool ?? '';
	const input = use !== undefined ? parseToolInput(use.text) : undefined;
	if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
		const diff = countEditLines(input);
		if (diff !== undefined) {
			return { text: diff, tone: 'good' };
		}
	}
	if ((tool === 'Read' || tool === 'Grep' || tool === 'Glob') && result !== undefined) {
		const lines = countLines(result.text);
		if (lines > 0) {
			return { text: tool === 'Read' ? `${lines}行` : `${lines}件`, tone: 'default' };
		}
	}
	const started = use?.ts;
	const ended = result?.ts;
	if (started !== undefined && ended !== undefined && ended > started) {
		return { text: formatDuration(ended - started), tone: 'default' };
	}
	if (result !== undefined) {
		const lines = countLines(result.text);
		if (lines > 0) {
			return { text: `${lines}行`, tone: 'default' };
		}
	}
	return undefined;
}

/** Edit の入力から「+N −M」を作る。old/new が無い形（Write等）は行数だけ出す。 */
function countEditLines(input: Record<string, unknown> | undefined): string | undefined {
	if (input === undefined) {
		return undefined;
	}
	const oldText = str(input['old_string']);
	const newText = str(input['new_string']);
	if (oldText !== undefined || newText !== undefined) {
		const removed = oldText !== undefined ? countLines(oldText) : 0;
		const added = newText !== undefined ? countLines(newText) : 0;
		// allow-any-unicode-next-line
		return `+${added} −${removed}`;
	}
	const content = str(input['content']);
	return content !== undefined ? `${countLines(content)}行` : undefined;
}

/** 集約行のサマリー（例: `思考 ×2 ・ ツール5件 (Bash, Read) ・ 48秒`）。 */
export function summarizeSteps(msgs: readonly AgentChatMessage[]): string {
	const thinking = msgs.filter(m => m.kind === 'thinking').length;
	const tools = msgs.filter(m => m.kind === 'tool_use');
	const names: string[] = [];
	for (const t of tools) {
		const name = t.tool !== undefined ? formatToolName(t.tool) : undefined;
		if (name !== undefined && !names.includes(name)) {
			names.push(name);
		}
	}
	const parts: string[] = [];
	if (thinking > 0) {
		parts.push(thinking === 1 ? '思考' : `思考 ×${thinking}`);
	}
	if (tools.length > 0) {
		const shown = names.slice(0, 3).join(', ');
		// allow-any-unicode-next-line
		parts.push(`ツール${tools.length}件${shown ? ` (${shown}${names.length > 3 ? '…' : ''})` : ''}`);
	}
	if (parts.length === 0) {
		parts.push(`${msgs.length}件のアクティビティ`);
	}
	const stamps = msgs.map(m => m.ts).filter((t): t is number => typeof t === 'number');
	if (stamps.length >= 2) {
		const sec = Math.round((Math.max(...stamps) - Math.min(...stamps)) / 1000);
		if (sec >= 1) {
			parts.push(sec >= 60 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : `${sec}秒`);
		}
	}
	// allow-any-unicode-next-line
	return parts.join(' ・ ');
}
