// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Platform, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentChatMessage } from '../store.js';
import { basename, countLines, parseToolInput, splitMcpTool, type AgentTimelineStep } from '../agentToolMeta.js';
import { ExpandableText, IOBlock, ioStyles } from './agentIoBlock.js';
import { colors, mono } from '../theme.js';

/**
 * タイムラインのステップを開いたときの中身を、ツールの性質ごとに作り分ける。
 *
 * 共通の考え方:
 *  - 入力は「そのツールで一番読みたい形」に直す（Bashならコマンド、Readならファイル）
 *  - 結果は IOBlock（横スクロール・全文取得つき）に載せ、行数を出す
 *  - 判断材料になる数値（±行数、件数）はボディの先頭にバッジで置く
 */
export function ToolStepBody({ step, terminalKey }: { step: AgentTimelineStep; terminalKey?: string }) {
	const use = step.use;
	const result = step.result;
	if (use === undefined) {
		return (
			<View style={ioStyles.body}>
				{result !== undefined ? <IOBlock label="結果" message={result} terminalKey={terminalKey} lines /> : null}
			</View>
		);
	}
	const tool = use.tool ?? 'tool';
	const input = parseToolInput(use.text);
	const pending = result === undefined ? <Text style={styles.pending}>結果を待っています…</Text> : null;

	if (tool === 'Bash' || tool === 'BashOutput' || tool === 'shell') {
		const command = typeof input?.['command'] === 'string' ? input['command'] : undefined;
		const description = typeof input?.['description'] === 'string' ? input['description'] : undefined;
		return (
			<View style={ioStyles.body}>
				{description !== undefined ? <Text style={styles.caption}>{description}</Text> : null}
				<IOBlock label="コマンド" message={use} terminalKey={terminalKey} text={command} />
				{result !== undefined ? <IOBlock label={hasError(result) ? '標準エラー' : '標準出力'} message={result} terminalKey={terminalKey} lines /> : null}
				{pending}
			</View>
		);
	}

	if (tool === 'Read' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'Edit') {
		const path = firstString(input, ['file_path', 'notebook_path', 'path']);
		const oldText = typeof input?.['old_string'] === 'string' ? input['old_string'] : undefined;
		const newText = typeof input?.['new_string'] === 'string' ? input['new_string'] : undefined;
		const content = typeof input?.['content'] === 'string' ? input['content'] : undefined;
		return (
			<View style={ioStyles.body}>
				{path !== undefined ? <FileCard path={path} /> : null}
				{oldText !== undefined || newText !== undefined ? <EditDiff oldText={oldText ?? ''} newText={newText ?? ''} /> : null}
				{content !== undefined ? <IOBlock label="書き込む内容" message={use} terminalKey={terminalKey} text={content} lines /> : null}
				{result !== undefined && tool === 'Read' ? <IOBlock label="内容" message={result} terminalKey={terminalKey} lines /> : null}
				{result !== undefined && tool !== 'Read' ? <IOBlock label="結果" message={result} terminalKey={terminalKey} lines /> : null}
				{pending}
			</View>
		);
	}

	if (tool === 'Glob' || tool === 'Grep') {
		const pattern = firstString(input, ['pattern']);
		return (
			<View style={ioStyles.body}>
				{pattern !== undefined ? <Text style={styles.pattern} selectable>{pattern}</Text> : null}
				{result !== undefined ? <HitList message={result} terminalKey={terminalKey} /> : null}
				{pending}
			</View>
		);
	}

	if (tool === 'TodoWrite') {
		return (
			<View style={ioStyles.body}>
				<TodoList input={input} />
				{input === undefined ? <IOBlock label="入力" message={use} terminalKey={terminalKey} /> : null}
			</View>
		);
	}

	if (tool === 'WebFetch') {
		const url = firstString(input, ['url']);
		const prompt = firstString(input, ['prompt']);
		return (
			<View style={ioStyles.body}>
				{url !== undefined ? <SiteCard url={url} /> : null}
				{prompt !== undefined ? <Text style={styles.caption}>{prompt}</Text> : null}
				{result !== undefined ? <IOBlock label="取得内容" message={result} terminalKey={terminalKey} lines /> : null}
				{pending}
			</View>
		);
	}

	if (tool === 'web_search') {
		return (
			<View style={ioStyles.body}>
				<Text style={styles.query} selectable>{use.text}</Text>
				{result !== undefined ? <IOBlock label="検索結果" message={result} terminalKey={terminalKey} lines /> : null}
				{pending}
			</View>
		);
	}

	if (tool === 'Task' || tool === 'Agent') {
		return (
			<View style={ioStyles.body}>
				<View style={styles.subagent}>
					<View style={styles.subagentHead}>
						<Ionicons name="person-outline" size={12} color={colors.claude} />
						<Text style={styles.subagentTitle} numberOfLines={2}>{use.text}</Text>
					</View>
					<Text style={styles.caption}>このエージェントの詳細な作業ログは「SubAgent」から開けます。</Text>
				</View>
				{result !== undefined ? <IOBlock label="報告" message={result} terminalKey={terminalKey} lines /> : null}
				{pending}
			</View>
		);
	}

	if (tool === 'approval_request') {
		return (
			<View style={ioStyles.body}>
				<View style={styles.approval}>
					<View style={styles.approvalHead}>
						<Ionicons name="lock-closed-outline" size={12} color={colors.yellow} />
						<Text style={styles.approvalTitle}>許可を求めています</Text>
					</View>
					<Text style={styles.approvalBody} selectable>{use.text}</Text>
				</View>
				{result !== undefined ? <IOBlock label="結果" message={result} terminalKey={terminalKey} lines /> : null}
			</View>
		);
	}

	// MCP は返り値の形が読めないので、入力JSONだけ整形して結果は素のまま出す。
	const mcp = splitMcpTool(tool);
	const prettyInput = mcp !== undefined && input !== undefined ? safeStringify(input) : undefined;
	return (
		<View style={ioStyles.body}>
			{use.text.trim().length > 0 ? <IOBlock label="入力" message={use} terminalKey={terminalKey} text={prettyInput} /> : null}
			{result !== undefined ? <IOBlock label="結果" message={result} terminalKey={terminalKey} lines /> : null}
			{pending}
		</View>
	);
}

/** thinking ステップの中身（引用スタイル）。 */
export function ThinkingBody({ message, terminalKey }: { message: AgentChatMessage; terminalKey?: string }) {
	return (
		<View style={ioStyles.body}>
			<View style={styles.quote}>
				<ExpandableText message={message} terminalKey={terminalKey} style={styles.quoteText} />
			</View>
		</View>
	);
}

function firstString(input: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = input?.[key];
		if (typeof value === 'string' && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

function hasError(message: AgentChatMessage): boolean {
	return message.isError === true;
}

function safeStringify(value: unknown): string | undefined {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return undefined;
	}
}

/** ファイル操作の対象を1枚のカードで示す（ファイル名を主、ディレクトリを従）。 */
function FileCard({ path }: { path: string }) {
	const name = basename(path);
	const dir = path.slice(0, Math.max(0, path.length - name.length));
	return (
		<View style={ioStyles.card}>
			<View style={ioStyles.cardIcon}>
				<Ionicons name="document-text-outline" size={14} color={colors.accent} />
			</View>
			<View style={ioStyles.cardBody}>
				<Text style={ioStyles.cardTitle} numberOfLines={1}>{name}</Text>
				{dir.length > 0 ? <Text style={ioStyles.cardSub} numberOfLines={1} ellipsizeMode="head">{dir}</Text> : null}
			</View>
		</View>
	);
}

/** WebFetch の取得先。 */
function SiteCard({ url }: { url: string }) {
	const host = url.replace(/^https?:\/\//, '').split('/')[0] ?? url;
	return (
		<View style={ioStyles.card}>
			<View style={ioStyles.cardIcon}>
				<Ionicons name="globe-outline" size={14} color={colors.accent} />
			</View>
			<View style={ioStyles.cardBody}>
				<Text style={ioStyles.cardTitle} numberOfLines={1}>{host}</Text>
				<Text style={ioStyles.cardSub} numberOfLines={1} ellipsizeMode="tail">{url}</Text>
			</View>
		</View>
	);
}

/**
 * Edit の old_string / new_string から作る簡易差分。unified diff は届かないので、
 * 削除行→追加行の順に並べる（GitHub モバイルの split より縦に短く収まる）。
 */
function EditDiff({ oldText, newText }: { oldText: string; newText: string }) {
	const removed = oldText.length > 0 ? oldText.replace(/\n+$/, '').split('\n') : [];
	const added = newText.length > 0 ? newText.replace(/\n+$/, '').split('\n') : [];
	const shown = [
		...removed.slice(0, 40).map(line => ({ sign: '-', line })),
		...added.slice(0, 40).map(line => ({ sign: '+', line })),
	];
	const hidden = Math.max(0, removed.length - 40) + Math.max(0, added.length - 40);
	return (
		<View>
			<View style={[ioStyles.statRow, styles.statSpacing]}>
				<Text style={[ioStyles.stat, ioStyles.statAdd]}>+{added.length}</Text>
				<Text style={[ioStyles.stat, ioStyles.statDel]}>-{removed.length}</Text>
			</View>
			<View style={styles.diff}>
				{shown.map((row, index) => (
					<Text
						key={`${row.sign}:${index}`}
						style={[styles.diffLine, row.sign === '+' ? styles.diffAdd : styles.diffDel]}
						numberOfLines={1}
						selectable
					>
						{row.sign} {row.line}
					</Text>
				))}
				{hidden > 0 ? <Text style={ioStyles.listMore}>ほか {hidden} 行</Text> : null}
			</View>
		</View>
	);
}

/** Glob / Grep の結果。1行1パスに見えるならリスト、そうでなければ素のテキスト枠。 */
function HitList({ message, terminalKey }: { message: AgentChatMessage; terminalKey?: string }) {
	const lines = message.text.replace(/\n+$/, '').split('\n').filter(line => line.trim().length > 0);
	const pathLike = lines.length > 1 && lines.slice(0, 8).every(line => !line.includes(' ') && line.includes('/'));
	if (!pathLike) {
		return <IOBlock label="結果" message={message} terminalKey={terminalKey} lines />;
	}
	const shown = lines.slice(0, 12);
	return (
		<View style={ioStyles.list}>
			{shown.map((line, index) => (
				<View key={line} style={[ioStyles.listRow, index === 0 ? ioStyles.listRowFirst : null]}>
					<Ionicons name="document-outline" size={11} color={colors.textDim} />
					<Text style={ioStyles.listText} numberOfLines={1} ellipsizeMode="head" selectable>{line}</Text>
				</View>
			))}
			{lines.length > shown.length ? <Text style={ioStyles.listMore}>ほか {lines.length - shown.length} 件</Text> : null}
		</View>
	);
}

/** TodoWrite のチェックリスト。 */
function TodoList({ input }: { input: Record<string, unknown> | undefined }) {
	const todos = Array.isArray(input?.['todos']) ? input['todos'] : [];
	const items: { content: string; status: string }[] = [];
	for (const todo of todos) {
		if (typeof todo === 'object' && todo !== null && !Array.isArray(todo)) {
			const record = todo as Record<string, unknown>;
			const content = typeof record['content'] === 'string' ? record['content'] : undefined;
			if (content !== undefined) {
				items.push({ content, status: typeof record['status'] === 'string' ? record['status'] : 'pending' });
			}
		}
	}
	if (items.length === 0) {
		return null;
	}
	return (
		<View style={ioStyles.list}>
			{items.map((item, index) => (
				<View key={`${index}:${item.content}`} style={[ioStyles.listRow, index === 0 ? ioStyles.listRowFirst : null, item.status === 'in_progress' ? styles.todoActive : null]}>
					<View style={[styles.todoBox, item.status === 'completed' ? styles.todoBoxDone : null, item.status === 'in_progress' ? styles.todoBoxActive : null]}>
						{item.status === 'completed' ? <Ionicons name="checkmark" size={9} color={colors.bg} /> : null}
						{item.status === 'in_progress' ? <View style={styles.todoDot} /> : null}
					</View>
					<Text style={[styles.todoText, item.status === 'completed' ? styles.todoTextDone : null]} numberOfLines={2}>{item.content}</Text>
				</View>
			))}
		</View>
	);
}

/** Read の結果行数など、ボディ内で使う軽い集計。 */
export function resultLineCount(message: AgentChatMessage | undefined): number {
	return message === undefined ? 0 : countLines(message.text);
}

const styles = StyleSheet.create({
	pending: { color: colors.textDim, fontSize: 11, fontStyle: 'italic' },
	caption: { color: colors.textDim, fontSize: 11, lineHeight: 16 },
	pattern: { color: colors.text, fontSize: 11, fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default, backgroundColor: colors.surface2, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 4, alignSelf: 'flex-start' },
	query: { color: colors.text, fontSize: 12 },
	quote: { borderLeftWidth: 2, borderLeftColor: 'rgba(193,147,217,0.40)', paddingLeft: 10, paddingVertical: 2 },
	quoteText: { color: '#b9b9c2', fontSize: 12, lineHeight: 19, fontStyle: 'italic' },
	statSpacing: { marginBottom: 5 },
	diff: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 10, backgroundColor: '#161b22', paddingVertical: 6, overflow: 'hidden' },
	diffLine: { fontSize: 10.5, lineHeight: 15, fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default, paddingHorizontal: 9 },
	diffAdd: { color: colors.green, backgroundColor: 'rgba(79,209,165,0.07)' },
	diffDel: { color: colors.red, backgroundColor: 'rgba(244,114,114,0.07)' },
	todoActive: { backgroundColor: 'rgba(9,175,217,0.06)' },
	todoBox: { width: 14, height: 14, borderRadius: 4, borderWidth: 1.5, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
	todoBoxDone: { backgroundColor: colors.green, borderColor: colors.green },
	todoBoxActive: { borderColor: colors.accent },
	todoDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
	todoText: { flex: 1, color: colors.text, fontSize: 11.5, lineHeight: 16 },
	todoTextDone: { color: colors.textDim, textDecorationLine: 'line-through' },
	subagent: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(217,119,87,0.24)', backgroundColor: 'rgba(217,119,87,0.045)', borderRadius: 12, padding: 10, gap: 6 },
	subagentHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
	subagentTitle: { flex: 1, color: colors.claude, fontSize: 11.5, fontWeight: '700' },
	approval: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(224,192,125,0.34)', backgroundColor: 'rgba(224,192,125,0.06)', borderRadius: 12, padding: 10, gap: 6 },
	approvalHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
	approvalTitle: { color: colors.yellow, fontSize: 11.5, fontWeight: '700' },
	approvalBody: { color: colors.text, fontSize: 11.5, lineHeight: 16, fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default },
});
