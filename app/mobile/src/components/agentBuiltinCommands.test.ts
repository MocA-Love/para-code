import { describe, expect, it } from 'vitest';
import { agentBuiltinCommandBadge, agentComposerIntercept, agentPanelLabel } from './agentBuiltinCommands.js';
import type { AgentSlashCommand } from './agentSlashCommands.js';

const builtIn = (name: string): AgentSlashCommand => ({ name, insertText: `/${name}`, description: '', kind: 'command', source: 'built-in' });
const commands: AgentSlashCommand[] = [builtIn('model'), builtIn('effort'), builtIn('config'), builtIn('usage'), builtIn('context'), builtIn('compact')];

describe('agentComposerIntercept', () => {
	it('opens the sheet for a bare /model or /effort and switches with an alias, without sending to the PC', () => {
		expect([
			'/model', '  /Model  ', '/effort', '/model sonnet', '/model Opus[1M]', '/model claude-sonnet-5-5', '/effort high', '/effort turbo',
		].map(text => agentComposerIntercept(text, 'claude', commands))).toEqual([
			{ kind: 'model-sheet' }, { kind: 'model-sheet' }, { kind: 'effort-sheet' },
			{ kind: 'model-switch', alias: 'sonnet' }, { kind: 'model-switch', alias: 'opus[1m]' },
			{ kind: 'model-not-alias', value: 'claude-sonnet-5-5' },
			{ kind: 'effort-switch', level: 'high' }, undefined,
		]);
	});

	it('opens usage and status here, asks before a command that opens a panel unless it was picked from the list, and leaves the rest alone', () => {
		expect({
			usage: agentComposerIntercept('/usage', 'claude', commands),
			status: agentComposerIntercept('/status', 'claude', []),
			config: agentComposerIntercept('/config', 'claude', commands),
			picked: agentComposerIntercept('/config', 'claude', commands, 'config'),
			pickedOther: agentComposerIntercept('/permissions', 'claude', commands, 'config'),
			plain: ['/context', '/compact', 'hello', '/Users/me/file'].map(text => agentComposerIntercept(text, 'claude', commands)),
		}).toEqual({
			usage: { kind: 'usage' },
			status: { kind: 'status' },
			config: { kind: 'confirm-panel', command: 'config', title: '設定' },
			picked: undefined,
			pickedOther: { kind: 'confirm-panel', command: 'permissions', title: '許可の設定' },
			plain: [undefined, undefined, undefined, undefined],
		});
	});

	it('does not take over a custom command of the same name that runs first, and stops Codex /model', () => {
		const custom: AgentSlashCommand[] = [{ ...builtIn('status'), source: 'user' }, builtIn('status')];
		expect({
			custom: agentComposerIntercept('/status', 'claude', custom),
			codex: ['/model', '/model gpt-5', '/status'].map(text => agentComposerIntercept(text, 'codex', [])),
		}).toEqual({ custom: undefined, codex: [{ kind: 'codex-model' }, { kind: 'codex-model' }, undefined] });
	});
});

describe('agentBuiltinCommandBadge', () => {
	it('labels the built-in commands of Claude Code only', () => {
		expect({
			badges: commands.map(command => agentBuiltinCommandBadge('claude', command, commands)?.label),
			codex: agentBuiltinCommandBadge('codex', builtIn('config'), []),
			user: agentBuiltinCommandBadge('claude', { ...builtIn('config'), source: 'user' }, []),
			panels: [agentPanelLabel('config'), agentPanelLabel('mystery'), agentPanelLabel(undefined), agentPanelLabel('constructor')],
		}).toEqual({
			badges: ['シートで選ぶ', 'シートで選ぶ', 'PC で画面が開きます', 'この端末で開く', '結果を表示', undefined],
			codex: undefined,
			user: undefined,
			panels: ['/config（設定）', '/mystery', undefined, '/constructor'],
		});
	});
});
