/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { UriComponents } from '../../../base/common/uri.js';
import { ISerializableEnvironmentVariableCollection, ISerializableEnvironmentVariableCollections } from './environmentVariable.js';
import { IFixedTerminalDimensions, IRawTerminalTabLayoutInfo, IReconnectionProperties, ITerminalEnvironment, ITerminalTabAction, ITerminalTabLayoutInfoById, TerminalIcon, TerminalType, TitleEventSource, WaitOnExitValue } from './terminal.js';

export interface ISingleTerminalConfiguration<T> {
	userValue: T | undefined;
	value: T | undefined;
	defaultValue: T | undefined;
}

export interface ICompleteTerminalConfiguration {
	'terminal.integrated.env.windows': ISingleTerminalConfiguration<ITerminalEnvironment>;
	'terminal.integrated.env.osx': ISingleTerminalConfiguration<ITerminalEnvironment>;
	'terminal.integrated.env.linux': ISingleTerminalConfiguration<ITerminalEnvironment>;
	'terminal.integrated.cwd': string;
	'terminal.integrated.detectLocale': 'auto' | 'off' | 'on';
}

export type ITerminalEnvironmentVariableCollections = [string, ISerializableEnvironmentVariableCollection][];

export interface IWorkspaceFolderData {
	uri: UriComponents;
	name: string;
	index: number;
}

export interface ISetTerminalLayoutInfoArgs {
	workspaceId: string;
	tabs: ITerminalTabLayoutInfoById[];
	background: number[] | null;
}

export interface IGetTerminalLayoutInfoArgs {
	workspaceId: string;
}

export interface IProcessDetails {
	id: number;
	pid: number;
	title: string;
	titleSource: TitleEventSource;
	cwd: string;
	workspaceId: string;
	workspaceName: string;
	isOrphan: boolean;
	icon: TerminalIcon | undefined;
	color: string | undefined;
	fixedDimensions: IFixedTerminalDimensions | undefined;
	environmentVariableCollections: ISerializableEnvironmentVariableCollections | undefined;
	reconnectionProperties?: IReconnectionProperties;
	waitOnExit?: WaitOnExitValue;
	hideFromUser?: boolean;
	isFeatureTerminal?: boolean;
	type?: TerminalType;
	hasChildProcesses: boolean;
	shellIntegrationNonce: string;
	// PARA-PATCH: mobile relay recovery — carry the exact pane token across PTY revive and detach
	/** PARA-CODE: Carries the exact pane token across PTY revive and detach. */
	paradisPaneToken?: string;
	// PARA-PATCH: space ownership — `listProcesses` already reports this for orphans (ptyService.ts)
	/** PARA-CODE: The process ID used by the previous PTY host before full application revival. */
	paradisRevivedFromPersistentProcessId?: number;
	// PARA-PATCH: space ownership — an adopted terminal's id says nothing about earlier sessions
	/**
	 * PARA-CODE: Whether this terminal was taken back from a daemon that kept it running across an
	 * update, rather than started here.
	 *
	 * It matters to anything keyed by persistent process id. Adoption hands out a new id and, unlike
	 * reviving, cannot say which id the terminal had before — the previous id is nowhere in what the
	 * daemon was given to hold. So the new id must not be used to read a table written by an earlier
	 * session: it does not merely miss, it can land on another terminal's entry. Match on the nonce
	 * instead, which is carried across.
	 */
	paradisAdopted?: boolean;
	tabActions?: ITerminalTabAction[];
}

export type ITerminalTabLayoutInfoDto = IRawTerminalTabLayoutInfo<IProcessDetails>;

export interface ReplayEntry {
	cols: number;
	rows: number;
	data: string;
}
