// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** モバイル向けに検証済みのスラッシュ候補。 */
export interface AgentSlashCommand {
	name: string;
	insertText: string;
	description: string;
	kind: 'command' | 'skill' | 'prompt';
	source: 'built-in' | 'user' | 'project' | 'plugin' | 'mcp';
	plugin?: string;
}

/** 入力全体が先頭のスラッシュトークンだけである間、その検索語を返す。 */
export function agentSlashQuery(text: string): string | undefined {
	const match = /^\/([^/\s]*)$/.exec(text);
	return match?.[1];
}

/** CLIと同様にコマンド名の前方一致で絞り、カタログの優先順を維持する。 */
export function filterAgentSlashCommands(commands: readonly AgentSlashCommand[], query: string, limit = 8): AgentSlashCommand[] {
	const normalized = query.toLocaleLowerCase();
	return commands.filter(command => command.name.toLocaleLowerCase().startsWith(normalized)).slice(0, limit);
}

/** 候補選択時にTextInputへ挿入する文字列を返す。 */
export function selectedAgentSlashCommandText(command: AgentSlashCommand): string {
	return command.insertText;
}

/**
 * モバイルでは両エージェントのスキルを`/name`で統一する。Codex CLIへ渡す瞬間だけ、
 * カタログでskillと検証できた先頭トークンを本来の`$name`記法へ変換する。
 */
export function normalizeAgentSlashSubmission(text: string, agent: string | undefined, commands: readonly AgentSlashCommand[]): string {
	if (agent !== 'codex') {
		return text;
	}
	const match = /^\/([^/\s]+)(?=\s|$)/.exec(text);
	if (match === null) {
		return text;
	}
	const command = commands.find(candidate => candidate.kind === 'skill' && candidate.name.toLocaleLowerCase() === match[1]!.toLocaleLowerCase());
	return command === undefined ? text : `$${command.name}${text.slice(match[0].length)}`;
}

/** 一覧の中で 2 件以上ある名前（小文字で比べる）。この名前の候補には出どころを添える。 */
export function duplicateAgentSlashCommandNames(commands: readonly AgentSlashCommand[]): ReadonlySet<string> {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const command of commands) {
		const key = command.name.toLocaleLowerCase();
		if (seen.has(key)) {
			duplicates.add(key);
		}
		seen.add(key);
	}
	return duplicates;
}

/** 候補の出どころの短い札（組み込み・プラグイン名・自作・MCP）。同じ名前が並ぶときに添える。 */
export function agentSlashCommandOriginLabel(command: AgentSlashCommand): string {
	switch (command.source) {
		case 'built-in': return '組み込み';
		case 'plugin': return command.plugin ?? 'プラグイン';
		case 'mcp': return 'MCP';
		default: return '自作';
	}
}
