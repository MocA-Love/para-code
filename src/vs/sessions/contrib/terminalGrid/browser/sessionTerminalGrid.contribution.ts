/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import './media/sessionTerminalGrid.css';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Direction, ITerminalGroupService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalContextKeys } from '../../../../workbench/contrib/terminal/common/terminalContextKey.js';
import { terminalStrings } from '../../../../workbench/contrib/terminal/common/terminalStrings.js';
import { SessionTerminalGridGroup } from './sessionTerminalGridGroup.js';

/**
 * True when the active terminal group is a {@link SessionTerminalGridGroup}, i.e. when the 2D
 * grid split commands below are actually applicable. The legacy single-axis `TerminalGroup` is
 * fully replaced at the DI level (see the `PARA-PATCH` in `terminalGroupService.ts`), so in
 * practice this should always be `true` whenever a terminal group exists; the context key mainly
 * guards against future/alternate `ITerminalGroup` implementations.
 */
export const IsSessionTerminalGridActiveContext = new RawContextKey<boolean>('sessionTerminalGridActive', false, localize('sessionTerminalGridActive', "Whether the active terminal group is a 2D grid-based group."));

class SessionTerminalGridContextContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessionTerminalGridContext';

	constructor(
		@ITerminalGroupService terminalGroupService: ITerminalGroupService,
		@IContextKeyService contextKeyService: IContextKeyService
	) {
		super();

		const isGridActive = IsSessionTerminalGridActiveContext.bindTo(contextKeyService);
		const update = () => isGridActive.set(terminalGroupService.activeGroup instanceof SessionTerminalGridGroup);

		this._register(terminalGroupService.onDidChangeActiveGroup(update));
		this._register(terminalGroupService.onDidChangeGroups(update));
		update();
	}
}

registerWorkbenchContribution2(SessionTerminalGridContextContribution.ID, SessionTerminalGridContextContribution, WorkbenchPhase.AfterRestored);

/**
 * Shared `run` implementation for the 4 directional grid split commands below: downcasts the
 * active terminal group to {@link SessionTerminalGridGroup} and calls its fork-only
 * `splitInDirection` API. Intentionally a no-op (rather than falling back to the legacy 1-axis
 * split) when the active group isn't a grid group.
 */
abstract class AbstractSessionTerminalSplitGridAction extends Action2 {
	protected abstract getDirection(): Direction;

	override run(accessor: ServicesAccessor): void {
		const terminalGroupService = accessor.get(ITerminalGroupService);
		const group = terminalGroupService.activeGroup;
		if (!(group instanceof SessionTerminalGridGroup)) {
			return;
		}
		const activeInstance = group.activeInstance;
		if (!activeInstance) {
			return;
		}
		group.splitInDirection(activeInstance, this.getDirection());
	}
}

class SessionTerminalSplitGridUpAction extends AbstractSessionTerminalSplitGridAction {
	constructor() {
		super({
			id: 'sessions.action.terminal.splitGridUp',
			title: localize2('workbench.action.terminal.splitGridUp', 'Split Terminal Up'),
			category: terminalStrings.actionCategory,
			f1: true,
			precondition: IsSessionTerminalGridActiveContext,
			keybinding: {
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.Alt | KeyCode.UpArrow),
				when: ContextKeyExpr.and(TerminalContextKeys.focus, IsSessionTerminalGridActiveContext),
				weight: KeybindingWeight.WorkbenchContrib
			}
		});
	}
	protected getDirection(): Direction { return Direction.Up; }
}

class SessionTerminalSplitGridDownAction extends AbstractSessionTerminalSplitGridAction {
	constructor() {
		super({
			id: 'sessions.action.terminal.splitGridDown',
			title: localize2('workbench.action.terminal.splitGridDown', 'Split Terminal Down'),
			category: terminalStrings.actionCategory,
			f1: true,
			precondition: IsSessionTerminalGridActiveContext,
			keybinding: {
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.Alt | KeyCode.DownArrow),
				when: ContextKeyExpr.and(TerminalContextKeys.focus, IsSessionTerminalGridActiveContext),
				weight: KeybindingWeight.WorkbenchContrib
			}
		});
	}
	protected getDirection(): Direction { return Direction.Down; }
}

class SessionTerminalSplitGridLeftAction extends AbstractSessionTerminalSplitGridAction {
	constructor() {
		super({
			id: 'sessions.action.terminal.splitGridLeft',
			title: localize2('workbench.action.terminal.splitGridLeft', 'Split Terminal Left'),
			category: terminalStrings.actionCategory,
			f1: true,
			precondition: IsSessionTerminalGridActiveContext,
			keybinding: {
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.Alt | KeyCode.LeftArrow),
				when: ContextKeyExpr.and(TerminalContextKeys.focus, IsSessionTerminalGridActiveContext),
				weight: KeybindingWeight.WorkbenchContrib
			}
		});
	}
	protected getDirection(): Direction { return Direction.Left; }
}

class SessionTerminalSplitGridRightAction extends AbstractSessionTerminalSplitGridAction {
	constructor() {
		super({
			id: 'sessions.action.terminal.splitGridRight',
			title: localize2('workbench.action.terminal.splitGridRight', 'Split Terminal Right'),
			category: terminalStrings.actionCategory,
			f1: true,
			precondition: IsSessionTerminalGridActiveContext,
			keybinding: {
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.Alt | KeyCode.RightArrow),
				when: ContextKeyExpr.and(TerminalContextKeys.focus, IsSessionTerminalGridActiveContext),
				weight: KeybindingWeight.WorkbenchContrib
			}
		});
	}
	protected getDirection(): Direction { return Direction.Right; }
}

registerAction2(SessionTerminalSplitGridUpAction);
registerAction2(SessionTerminalSplitGridDownAction);
registerAction2(SessionTerminalSplitGridLeftAction);
registerAction2(SessionTerminalSplitGridRightAction);
