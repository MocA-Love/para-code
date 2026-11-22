/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `para` コマンド（CLI）の品書き。MCP の tools/list と同じ道具の一覧から、分野・コマンド名・別名・読むだけの印・
// 分野ごとの手引きを作る。CLI は道具の表を持たず、ここで作ったものを本体から受け取る（JSON-RPC の
// {@link PARADIS_CLI_CATALOG_METHOD}）。道具を足す側は MCP の定義を 1 つ書くだけでよい。
//
// vs/* に依存しない（CLI の本体 `paradisCliCore.ts` からも型を使う）。

/** CLI と本体のやり取りの版。形を変えたら上げる（CLI は知らない版の品書きを使わない）。 */
export const PARADIS_CLI_PROTOCOL_VERSION = 1;
/** 品書きを返す JSON-RPC のメソッド。 */
export const PARADIS_CLI_CATALOG_METHOD = 'para-cli/catalog';
/** CLI が呼び出しの `params._meta` に添える印の鍵。値は {@link IParadisCliCallMeta}。 */
export const PARADIS_CLI_META_KEY = 'para-code/cli';
/** 会話の識別子の長さの上限（これより長いものは無かったものとして扱う）。 */
export const PARADIS_CLI_CONVERSATION_MAX_LENGTH = 128;

/** CLI が呼び出しごとに添えるもの。 */
export interface IParadisCliCallMeta {
	/**
	 * 会話の識別子（エージェントがシェルへ渡す会話の ID のハッシュ）。本体は、そのペインで初めて見た識別子のときに
	 * 「会話の始まり」として MCP の `initialize` と同じ片付けをする。人が手で打ったときは無い。
	 */
	readonly conversation?: string;
}

/** 分野の名前と一行の説明。並び順は `para --help` の並び順。 */
export const PARADIS_CLI_GROUPS = [
	{ name: 'browser', summary: 'The built-in browser: open, read, click, fill and capture pages.' },
	{ name: 'terminal', summary: 'Other terminals of this window: list, read, wait, send input.' },
	{ name: 'ide', summary: 'Spaces (repositories and worktrees), launching agents, previews, the guide.' },
	{ name: 'note', summary: 'The notes and to-do list of a space.' },
	{ name: 'port', summary: 'Port forwards of an SSH window.' },
	{ name: 'doc', summary: 'Documents and their comments.' },
	{ name: 'board', summary: 'Task board steps (only in terminals started from the task board).' },
	{ name: 'mobile', summary: 'Simulators and emulators.' },
	{ name: 'computer', summary: 'Other macOS apps (Computer Use).' },
] as const;

export type ParadisCliGroup = typeof PARADIS_CLI_GROUPS[number]['name'];

/** CLI 自身のフラグ。道具の引数がこの名前を持つと、その道具では引数が勝つ（`--json` で全部渡す道は残る）。 */
export const PARADIS_CLI_RESERVED_FLAGS: readonly string[] = ['help', 'json', 'out', 'raw', 'refresh'];

/** 名前の頭で分野が決まるもの（頭はコマンド名から外す。`computer_click` → `para computer click`）。 */
const PREFIX_GROUPS: readonly ParadisCliGroup[] = ['computer', 'mobile', 'board'];

/** 名前の形で分野が決まるもの（提供元の分野より先に見る。IDE の提供元が端末の道具も出すため）。 */
const NAME_RULES: readonly { readonly group: ParadisCliGroup; readonly pattern: RegExp }[] = [
	{ group: 'terminal', pattern: /(?:^|_)terminals?(?:_|$)/ },
	{ group: 'note', pattern: /(?:^|_)space_notes?(?:_|$)/ },
	{ group: 'port', pattern: /(?:^|_)port_forwards?(?:_|$)|(?:^|_)(?:re)?forward_port$/ },
];

/** 提供元を持たない道具（`paradisBrowserMcpShimCore.ts` の一覧）のうち、ブラウザの道具ではないもの。 */
const LOCAL_TOOL_GROUPS: Readonly<Record<string, ParadisCliGroup>> = {
	preview_file: 'ide',
};

/**
 * 短い別名（分野 → 別名 → 道具の名前）。道具の名前から作ったコマンド名（`take_snapshot` → `take-snapshot`）と、
 * 道具の名前そのもの（`take_snapshot`）はいつでも使える。別名は、同じ分野のコマンド名と重なれば捨てる。
 */
const ALIASES: Readonly<Partial<Record<ParadisCliGroup, Readonly<Record<string, string>>>>> = {
	browser: {
		open: 'open_browser_tab',
		close: 'close_browser_tab',
		tabs: 'list_browser_tabs',
		select: 'select_browser_tab',
		goto: 'navigate_page',
		text: 'get_text',
		snapshot: 'take_snapshot',
		screenshot: 'take_screenshot',
		capture: 'capture_screenshot',
		wait: 'wait_until',
		eval: 'evaluate_script',
		label: 'set_cursor_label',
		page: 'get_shared_page',
	},
	terminal: {
		list: 'list_terminals',
		read: 'read_terminal',
		wait: 'wait_for_terminal',
		send: 'send_terminal_input',
		key: 'send_terminal_key',
		create: 'create_terminal',
		close: 'close_terminal',
	},
	note: {
		list: 'list_space_notes',
		read: 'read_space_note',
		write: 'write_space_note',
	},
	port: {
		list: 'list_port_forwards',
	},
};

/** 品書きを作る元になる道具 1 つ（MCP の tools/list の 1 件）。 */
export interface IParadisCliSourceTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: unknown;
	readonly annotations?: unknown;
}

/** CLI のコマンド 1 つ。 */
export interface IParadisCliCommand {
	readonly group: ParadisCliGroup;
	/** コマンド名（`para <group> <verb>`）。 */
	readonly verb: string;
	/** 短い別名。 */
	readonly aliases: readonly string[];
	/** 読むだけ（ページ・端末の状態を変えない）。MCP の注釈 `readOnlyHint` と同じ元。 */
	readonly readOnly: boolean;
	/** 呼び出す道具（`tools/call` の名前）。 */
	readonly tool: string;
	readonly description: string;
	readonly inputSchema: unknown;
}

/** 分野 1 つ。 */
export interface IParadisCliCatalogGroup {
	readonly name: ParadisCliGroup;
	readonly summary: string;
	/** この分野の道具を使う前の約束（MCP のサーバーの説明文と同じ文）。無ければ空。 */
	readonly guide: string;
}

/** {@link PARADIS_CLI_CATALOG_METHOD} の返り値。 */
export interface IParadisCliCatalog {
	readonly protocolVersion: number;
	readonly groups: readonly IParadisCliCatalogGroup[];
	readonly commands: readonly IParadisCliCommand[];
}

function isReadOnlyTool(tool: IParadisCliSourceTool): boolean {
	const annotations = tool.annotations;
	return annotations !== null && typeof annotations === 'object' && (annotations as { readonly readOnlyHint?: unknown }).readOnlyHint === true;
}

/**
 * 道具の分野。名前の頭（computer_・mobile_・board_）、名前の形（端末・メモ・ポート転送）、提供元が名乗った分野、
 * 提供元の無い道具の表、の順に見て、どれにも当たらなければブラウザ。
 */
export function paradisCliGroupOfTool(name: string, providerGroup?: ParadisCliGroup): ParadisCliGroup {
	for (const group of PREFIX_GROUPS) {
		if (name.startsWith(`${group}_`)) {
			return group;
		}
	}
	for (const rule of NAME_RULES) {
		if (rule.pattern.test(name)) {
			return rule.group;
		}
	}
	return providerGroup ?? LOCAL_TOOL_GROUPS[name] ?? 'browser';
}

/** 道具の名前から作るコマンド名。 */
export function paradisCliVerbOfTool(name: string, group: ParadisCliGroup): string {
	const rest = PREFIX_GROUPS.includes(group) && name.startsWith(`${group}_`) ? name.slice(group.length + 1) : name;
	return rest.replace(/_/g, '-');
}

/**
 * 道具の一覧から CLI のコマンドの一覧を作る。同じ「分野 + コマンド名」になる道具があれば、後のものは道具の名前を
 * そのままコマンド名にする（どの道具も必ず呼べるようにする）。
 *
 * @param providerGroups 提供元が名乗った分野（道具の名前 → 分野）
 */
export function paradisCliCommands(tools: readonly IParadisCliSourceTool[], providerGroups?: ReadonlyMap<string, ParadisCliGroup>): IParadisCliCommand[] {
	const taken = new Set<string>();
	const seenTools = new Set<string>();
	const commands: { group: ParadisCliGroup; verb: string; aliases: string[]; readOnly: boolean; tool: string; description: string; inputSchema: unknown }[] = [];
	for (const tool of tools) {
		if (seenTools.has(tool.name)) {
			continue;
		}
		seenTools.add(tool.name);
		const group = paradisCliGroupOfTool(tool.name, providerGroups?.get(tool.name));
		let verb = paradisCliVerbOfTool(tool.name, group);
		if (taken.has(`${group} ${verb}`)) {
			verb = tool.name;
		}
		taken.add(`${group} ${verb}`);
		commands.push({ group, verb, aliases: [], readOnly: isReadOnlyTool(tool), tool: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? { type: 'object', properties: {} } });
	}
	for (const [group, aliases] of Object.entries(ALIASES)) {
		for (const [alias, toolName] of Object.entries(aliases ?? {})) {
			if (taken.has(`${group} ${alias}`)) {
				continue;
			}
			const command = commands.find(candidate => candidate.group === group && candidate.tool === toolName);
			if (command !== undefined) {
				command.aliases.push(alias);
				taken.add(`${group} ${alias}`);
			}
		}
	}
	return commands;
}

/** サーバーの説明文の 1 文（または数文のまとまり）。 */
export interface IParadisAgentInstructionPart {
	readonly text: string;
	/** MCP のクライアントにだけ意味がある（ToolSearch、MCP サーバーの名乗りなど）。CLI の手引きには出さない。 */
	readonly mcpOnly?: boolean;
}

/** サーバーの説明文の 1 段（1 つの提供元の説明）。MCP では段を空行で、段の中の文を空白でつなぐ。 */
export interface IParadisAgentInstructionSection {
	readonly group: ParadisCliGroup;
	readonly parts: readonly IParadisAgentInstructionPart[];
}

/** MCP の `initialize` の `instructions`。 */
export function paradisMcpInstructionsText(sections: readonly IParadisAgentInstructionSection[]): string {
	return sections.map(section => section.parts.map(part => part.text).join(' ')).filter(text => text.length > 0).join('\n\n');
}

/** CLI の `para help <分野>` の手引き（MCP 専用の文を除いた、同じ文）。 */
export function paradisCliGuideText(sections: readonly IParadisAgentInstructionSection[], group: ParadisCliGroup): string {
	return sections
		.filter(section => section.group === group)
		.map(section => section.parts.filter(part => part.mcpOnly !== true).map(part => part.text).join(' '))
		.filter(text => text.length > 0)
		.join('\n\n');
}

/** 品書きを組み立てる。コマンドの無い分野は、手引きも無ければ載せない。 */
export function paradisBuildCliCatalog(tools: readonly IParadisCliSourceTool[], sections: readonly IParadisAgentInstructionSection[], providerGroups?: ReadonlyMap<string, ParadisCliGroup>): IParadisCliCatalog {
	const commands = paradisCliCommands(tools, providerGroups);
	const groups: IParadisCliCatalogGroup[] = [];
	for (const group of PARADIS_CLI_GROUPS) {
		const guide = paradisCliGuideText(sections, group.name);
		if (guide.length > 0 || commands.some(command => command.group === group.name)) {
			groups.push({ name: group.name, summary: group.summary, guide });
		}
	}
	return { protocolVersion: PARADIS_CLI_PROTOCOL_VERSION, groups, commands };
}

/** 呼び出しの `params._meta` から CLI の印を読む。CLI からの呼び出しでなければ undefined。 */
export function paradisCliCallMetaOf(params: unknown): IParadisCliCallMeta | undefined {
	if (params === null || typeof params !== 'object' || Array.isArray(params)) {
		return undefined;
	}
	const meta = (params as { readonly _meta?: unknown })._meta;
	if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
		return undefined;
	}
	const cli = (meta as Record<string, unknown>)[PARADIS_CLI_META_KEY];
	if (cli === null || typeof cli !== 'object' || Array.isArray(cli)) {
		return undefined;
	}
	const conversation = (cli as { readonly conversation?: unknown }).conversation;
	return typeof conversation === 'string' && conversation.length > 0 && conversation.length <= PARADIS_CLI_CONVERSATION_MAX_LENGTH ? { conversation } : {};
}

/** 1 ペインで覚える会話の識別子の数（古いものから忘れる）。 */
const MAX_CONVERSATIONS_PER_PANE = 32;

/**
 * ペインごとに、CLI が名乗った会話の識別子を覚える。初めて見た識別子のときだけ「会話の始まり」と答える。
 * 「直前と違えば」ではなく「初めて見たら」にするのは、同じペインで親とサブエージェント、または 2 つのエージェントが
 * 交互に呼んでも、呼ぶたびに片付けが走らないようにするため。
 */
export class ParadisCliConversations {
	private readonly _seen = new Map<string, Set<string>>();

	/** @returns この識別子をこのペインで初めて見たら true */
	note(paneToken: string, conversation: string): boolean {
		let seen = this._seen.get(paneToken);
		if (seen === undefined) {
			seen = new Set();
			this._seen.set(paneToken, seen);
		}
		if (seen.has(conversation)) {
			return false;
		}
		seen.add(conversation);
		while (seen.size > MAX_CONVERSATIONS_PER_PANE) {
			const oldest = seen.values().next();
			if (oldest.done) {
				break;
			}
			seen.delete(oldest.value);
		}
		return true;
	}

	forget(paneToken: string): void {
		this._seen.delete(paneToken);
	}
}
