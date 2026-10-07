// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Claude Code のエージェントチームを、トークの 1 枚のカードとチームの画面に出すための純ロジック（`team-card-mock.html` の
 * 案 T1。Q261 A: 許可はトークの許可カードで答え、チームの側は「許可待ち」の行と導線。Q262 A: 計画は読めるだけ。
 * Q263 A: やりとりは要約を並べ、押すと本文。Q264 A: 別のペインのメンバーは「別のペインで動いています」）。
 *
 * PC は agent の snapshot / delta に任意項目 `teams`・`teamsAt` を載せる（`agent.teams.v1`。PC 側は
 * `src/vs/paradis/contrib/agentChat/common/paradisAgentTeams.ts`）。PC は変わったときだけ載せる。古い PC は送らないので、
 * そのときは一覧が無い（undefined）＝トークは今までどおりメンバーの起動をサブエージェントのカードに出す。
 */

export type AgentTeamMemberState = 'running' | 'idle' | 'waiting' | 'plan' | 'completed' | 'failed' | 'stopped';
export type AgentTeamBackend = 'in-process' | 'tmux' | 'iterm2' | 'other';
export type AgentTeamMessageKind = 'instruction' | 'message' | 'plan' | 'shutdown';

export interface AgentTeamMember {
	name: string;
	agentId?: string;
	toolUseId?: string;
	color?: string;
	model?: string;
	agentType?: string;
	description?: string;
	backend: AgentTeamBackend;
	state: AgentTeamMemberState;
	estimated?: true;
	activity?: string;
	/** 許可待ちの承認の ID（トークの許可カードと同じ ID）。 */
	approvalId?: string;
	approvalTool?: string;
	failure?: string;
	/** 手元の時計。 */
	startedAt: number;
	updatedAt: number;
}

export interface AgentTeamMessage {
	id: string;
	from: string;
	to: string;
	kind: AgentTeamMessageKind;
	summary?: string;
	text: string;
	truncated?: true;
	/** 手元の時計。 */
	at: number;
}

export interface AgentTeamPlan {
	from: string;
	text: string;
	truncated?: true;
	/** 手元の時計。 */
	at: number;
	approved?: boolean;
	feedback?: string;
}

export interface AgentTeam {
	name: string;
	leadName: string;
	toolUseIds: string[];
	members: AgentTeamMember[];
	messages: AgentTeamMessage[];
	messageCount: number;
	plans?: AgentTeamPlan[];
	/** 手元の時計。 */
	startedAt: number;
	updatedAt: number;
}

const MAX_TEAMS = 10;
const MAX_MEMBERS = 40;
const MAX_MESSAGES = 100;
const MAX_PLANS = 40;
const STATES = new Set<AgentTeamMemberState>(['running', 'idle', 'waiting', 'plan', 'completed', 'failed', 'stopped']);
const BACKENDS = new Set<AgentTeamBackend>(['in-process', 'tmux', 'iterm2', 'other']);
const KINDS = new Set<AgentTeamMessageKind>(['instruction', 'message', 'plan', 'shutdown']);
const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const NAME = /^[A-Za-z0-9._@:*-]{1,100}$/;
const COLOR = /^[a-z]{1,20}$/;

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, limit: number): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.slice(0, limit) : undefined;
}

function pattern(value: unknown, test: RegExp): string | undefined {
	return typeof value === 'string' && test.test(value) ? value : undefined;
}

function parseMember(raw: unknown): AgentTeamMember | undefined {
	const item = record(raw);
	const name = pattern(item?.['name'], NAME);
	if (item === undefined || name === undefined || !STATES.has(item['state'] as AgentTeamMemberState) || !finite(item['startedAt']) || !finite(item['updatedAt'])) {
		return undefined;
	}
	const agentId = pattern(item['agentId'], ID);
	const toolUseId = pattern(item['toolUseId'], ID);
	const color = pattern(item['color'], COLOR);
	const model = text(item['model'], 100);
	const agentType = text(item['agentType'], 100);
	const description = text(item['description'], 300);
	const activity = text(item['activity'], 200);
	const approvalId = pattern(item['approvalId'], /^[A-Za-z0-9._:-]{1,300}$/);
	const approvalTool = text(item['approvalTool'], 200);
	const failure = text(item['failure'], 500);
	return {
		name,
		...(agentId !== undefined ? { agentId } : {}),
		...(toolUseId !== undefined ? { toolUseId } : {}),
		...(color !== undefined ? { color } : {}),
		...(model !== undefined ? { model } : {}),
		...(agentType !== undefined ? { agentType } : {}),
		...(description !== undefined ? { description } : {}),
		backend: BACKENDS.has(item['backend'] as AgentTeamBackend) ? item['backend'] as AgentTeamBackend : 'other',
		state: item['state'] as AgentTeamMemberState,
		...(item['estimated'] === true ? { estimated: true as const } : {}),
		...(activity !== undefined ? { activity } : {}),
		...(approvalId !== undefined ? { approvalId, ...(approvalTool !== undefined ? { approvalTool } : {}) } : {}),
		...(failure !== undefined ? { failure } : {}),
		startedAt: item['startedAt'],
		updatedAt: item['updatedAt'],
	};
}

function parseMessage(raw: unknown): AgentTeamMessage | undefined {
	const item = record(raw);
	const id = pattern(item?.['id'], ID);
	const from = pattern(item?.['from'], NAME);
	const to = pattern(item?.['to'], NAME);
	if (item === undefined || id === undefined || from === undefined || to === undefined || !KINDS.has(item['kind'] as AgentTeamMessageKind) || typeof item['text'] !== 'string' || !finite(item['at'])) {
		return undefined;
	}
	const summary = text(item['summary'], 300);
	return {
		id, from, to, kind: item['kind'] as AgentTeamMessageKind,
		...(summary !== undefined ? { summary } : {}),
		text: item['text'].slice(0, 4_000),
		...(item['truncated'] === true ? { truncated: true as const } : {}),
		at: item['at'],
	};
}

function parsePlan(raw: unknown): AgentTeamPlan | undefined {
	const item = record(raw);
	const from = pattern(item?.['from'], NAME);
	if (item === undefined || from === undefined || typeof item['text'] !== 'string' || !finite(item['at'])) {
		return undefined;
	}
	const feedback = text(item['feedback'], 4_000);
	return {
		from, text: item['text'].slice(0, 12_000), at: item['at'],
		...(item['truncated'] === true ? { truncated: true as const } : {}),
		...(typeof item['approved'] === 'boolean' ? { approved: item['approved'] } : {}),
		...(feedback !== undefined ? { feedback } : {}),
	};
}

/** PC から届いた `teams` を読む。配列でなければ undefined（古い PC・壊れた値）。形の合わない要素は捨てる。 */
export function parseAgentTeams(value: unknown): AgentTeam[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const teams: AgentTeam[] = [];
	for (const candidate of value.slice(-MAX_TEAMS)) {
		const item = record(candidate);
		const name = pattern(item?.['name'], NAME);
		if (item === undefined || name === undefined || !finite(item['startedAt']) || !finite(item['updatedAt'])) {
			continue;
		}
		const members = (Array.isArray(item['members']) ? item['members'].slice(0, MAX_MEMBERS) : []).map(parseMember).filter((member): member is AgentTeamMember => member !== undefined);
		const messages = (Array.isArray(item['messages']) ? item['messages'].slice(-MAX_MESSAGES) : []).map(parseMessage).filter((message): message is AgentTeamMessage => message !== undefined);
		const plans = (Array.isArray(item['plans']) ? item['plans'].slice(-MAX_PLANS) : []).map(parsePlan).filter((plan): plan is AgentTeamPlan => plan !== undefined);
		const toolUseIds = (Array.isArray(item['toolUseIds']) ? item['toolUseIds'].slice(0, MAX_MEMBERS * 2) : []).filter((id): id is string => typeof id === 'string' && ID.test(id));
		teams.push({
			name,
			leadName: pattern(item['leadName'], NAME) ?? 'team-lead',
			toolUseIds,
			members,
			messages,
			messageCount: finite(item['messageCount']) ? Math.max(messages.length, Math.trunc(item['messageCount'])) : messages.length,
			...(plans.length > 0 ? { plans } : {}),
			startedAt: item['startedAt'],
			updatedAt: item['updatedAt'],
		});
	}
	return teams;
}

/** PC の時計の時刻を手元の時計へ直す（`teamsAt` は PC の送信時刻）。 */
export function localizeAgentTeams(teams: readonly AgentTeam[], teamsAt: unknown, receivedAt: number): AgentTeam[] {
	if (!finite(teamsAt)) {
		return [...teams];
	}
	const shift = receivedAt - teamsAt;
	return teams.map(team => ({
		...team,
		startedAt: team.startedAt + shift,
		updatedAt: team.updatedAt + shift,
		members: team.members.map(member => ({ ...member, startedAt: member.startedAt + shift, updatedAt: member.updatedAt + shift })),
		messages: team.messages.map(message => ({ ...message, at: message.at + shift })),
		...(team.plans !== undefined ? { plans: team.plans.map(plan => ({ ...plan, at: plan.at + shift })) } : {}),
	}));
}

export const TEAM_MEMBER_STATE_LABEL: Record<AgentTeamMemberState, string> = {
	running: '作業中',
	idle: '待機',
	waiting: '許可待ち',
	plan: '計画の承認待ち',
	completed: '完了',
	failed: '失敗',
	stopped: '停止',
};

/** 並べる順（要対応 → 作業中 → 待機 → 失敗 → 停止 → 完了）。 */
const STATE_ORDER: Record<AgentTeamMemberState, number> = { waiting: 0, plan: 1, running: 2, idle: 3, failed: 4, stopped: 5, completed: 6 };

/** 要対応と作業中を先に、同じ状態なら起動の順に並べる。 */
export function sortTeamMembers(members: readonly AgentTeamMember[]): AgentTeamMember[] {
	return [...members].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.startedAt - b.startedAt || a.name.localeCompare(b.name));
}

/** カードに出すメンバー（{@link limit} 人を超えたら要対応と作業中を先に。残りは「ほか N 人」）。 */
export function teamCardMembers(team: Pick<AgentTeam, 'members'>, limit = 5): { readonly shown: AgentTeamMember[]; readonly hidden: number } {
	const sorted = sortTeamMembers(team.members);
	// 6 人までは全員出す（「ほか 1 人」だけのために 1 行を隠さない）
	const shown = sorted.length <= limit + 1 ? sorted : sorted.slice(0, limit);
	return { shown, hidden: sorted.length - shown.length };
}

/** チーム全体の状態（カードのピル）。 */
export type AgentTeamTone = 'attention' | 'running' | 'idle' | 'done' | 'stopped';

export function teamTone(team: Pick<AgentTeam, 'members'>): AgentTeamTone {
	const states = new Set(team.members.map(member => member.state));
	if (states.has('waiting') || states.has('plan')) {
		return 'attention';
	}
	if (states.has('running')) {
		return 'running';
	}
	if (states.has('idle') || states.has('failed')) {
		return 'idle';
	}
	return states.has('stopped') ? 'stopped' : 'done';
}

export const TEAM_TONE_LABEL: Record<AgentTeamTone, string> = {
	attention: '要対応',
	running: '作業中',
	idle: '待機',
	done: '完了',
	stopped: '停止',
};

/** カードの見出しの下の「作業中 2 · 待機 1 · 許可待ち 1」。 */
export function teamStateSummary(team: Pick<AgentTeam, 'members'>): string {
	const counts = new Map<AgentTeamMemberState, number>();
	for (const member of team.members) {
		counts.set(member.state, (counts.get(member.state) ?? 0) + 1);
	}
	return [...counts].sort((a, b) => STATE_ORDER[a[0]] - STATE_ORDER[b[0]]).map(([state, value]) => `${TEAM_MEMBER_STATE_LABEL[state]} ${value}`).join(' · ');
}

/** 別のペイン（別のプロセス）で動くメンバーか。手元に記録が無く、状態は分からない。 */
export function isOtherPaneMember(member: Pick<AgentTeamMember, 'backend'>): boolean {
	return member.backend !== 'in-process';
}

/** メンバーの行の 2 行目（今やっていること・許可待ちのツール・失敗の理由・別のペイン）。 */
export function teamMemberLine(member: AgentTeamMember): string | undefined {
	if (isOtherPaneMember(member)) {
		return member.backend === 'iterm2' ? '別のペイン（iTerm2）で動いています' : '別のペインで動いています';
	}
	switch (member.state) {
		case 'waiting': return member.approvalTool !== undefined ? `${member.approvalTool} の許可を待っています` : '許可を待っています';
		case 'plan': return '計画の承認を待っています';
		case 'failed': return member.failure ?? member.activity;
		case 'completed': return '終了しました';
		default: return member.activity ?? member.description;
	}
}

/** Claude Code の色の名前を色にする（知らない名前は undefined）。 */
export function teamMemberColor(color: string | undefined): string | undefined {
	switch (color) {
		case 'red': return '#ef4444';
		case 'blue': return '#3b82f6';
		case 'green': return '#22c55e';
		case 'yellow': return '#eab308';
		case 'purple': return '#a78bfa';
		case 'orange': return '#f97316';
		case 'pink': return '#ec4899';
		case 'cyan': return '#06b6d4';
		default: return undefined;
	}
}

/** やりとりの一覧の 1 行目（要約。無ければ本文の先頭）。 */
export function teamMessageHeadline(message: AgentTeamMessage): string {
	switch (message.kind) {
		case 'plan': return message.summary ?? (message.text.length > 0 ? '計画' : '計画への答え');
		case 'shutdown': return message.summary ?? '終了のやりとり';
		default: {
			if (message.summary !== undefined) {
				return message.summary;
			}
			const first = message.text.split('\n').find(line => line.trim().length > 0)?.trim() ?? '';
			return first.length > 80 ? `${first.slice(0, 79)}…` : first;
		}
	}
}

/** 許可待ちのメンバー（カードと画面の「許可待ち」の行）。 */
export function teamWaitingMembers(team: Pick<AgentTeam, 'members'>): AgentTeamMember[] {
	return sortTeamMembers(team.members).filter(member => member.state === 'waiting' && member.approvalId !== undefined);
}

/** 会話の中のチーム（名前で引く）。 */
export function teamByName(teams: readonly AgentTeam[] | undefined, name: string | undefined): AgentTeam | undefined {
	return name === undefined ? undefined : teams?.find(team => team.name === name);
}
