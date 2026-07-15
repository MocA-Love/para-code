// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** モバイル向けに検証済みのスラッシュ候補。 */
export interface AgentSlashCommand {
	name: string;
	insertText: string;
	description: string;
	kind: 'command' | 'skill' | 'prompt';
	source: 'built-in' | 'user' | 'project';
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
