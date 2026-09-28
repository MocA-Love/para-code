/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 公開ワイヤの固定形（test/golden/）どうしの食い違いを見つける。
 *
 * 形そのものは PC 側（paradisMobileWireGolden.test.ts）とアプリ側（app/mobile/src/wireGolden.test.ts）が
 * それぞれの実装に通して確かめる。ここは固定形のファイルが互いに矛盾していないこと
 * （同じ PC・同じターミナルを指していること、W2-17 より前の形が W2-17 の項目だけを欠くこと）を守る。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { JSON_GZIP_RESPONSE_ENCODING } from '../src/gzipJson.js';
import { TERMINAL_BINARY_DATA_ENCODING } from '../src/terminalData.js';

type Json = Record<string, unknown>;

function readGolden<T>(name: string): T {
	return JSON.parse(readFileSync(fileURLToPath(new URL(`./golden/${name}`, import.meta.url)), 'utf8')) as T;
}

const state = readGolden<{ current: Json & { terminals: Json[]; workspaces: Json[]; renderers: Json[] }; preW217: Json }>('state.json');
const stateRequest = readGolden<{ current: Json; preW217: Json }>('state-request.json');
const term = readGolden<{ toPc: Json[]; toMobile: Json[] }>('term.json');
const agent = readGolden<{ toPc: Json[]; toMobile: Json[] }>('agent.json');

describe('wire golden fixtures', () => {
	test('W2-17 より前の形は、W2-17 で足した項目だけを欠く', () => {
		const added = (current: Json, legacy: Json) => Object.keys(current).filter(key => !(key in legacy)).sort();
		expect({
			state: added(state.current, state.preW217).filter(key => ['minCompatibleMobile', 'capabilities'].includes(key)),
			stateRequest: added(stateRequest.current, stateRequest.preW217),
			legacyHasNoW217Fields: ['minCompatibleMobile', 'capabilities', 'minCompatiblePc'].some(key => key in state.preW217 || key in stateRequest.preW217),
		}).toEqual({
			state: ['capabilities', 'minCompatibleMobile'],
			stateRequest: ['capabilities', 'minCompatiblePc'],
			legacyHasNoW217Fields: false,
		});
	});

	test('term と agent の固定形は state の current と同じ PC・同じターミナルを指す', () => {
		const terminal = state.current.terminals[0]!;
		const workspace = state.current.workspaces[0]!;
		const renderer = state.current.renderers[0]!;
		expect({
			termToPc: term.toPc.every(message => message.protocolVersion === state.current.protocolVersion && message.desktopEpoch === state.current.desktopEpoch
				&& (message.t === 'create' ? message.windowId === renderer.windowId && message.ws === workspace.sourceId : message.terminalKey === terminal.terminalKey)),
			termToMobile: term.toMobile.every(message => message.t === 'operation-result' || message.terminalKey === terminal.terminalKey),
			agent: [...agent.toPc, ...agent.toMobile].every(message => message.id === terminal.id && message.token === terminal.agentToken),
			encodings: [stateRequest.current.stateEncoding, term.toPc.find(message => message.t === 'attach')?.dataEncoding],
		}).toEqual({
			termToPc: true,
			termToMobile: true,
			agent: true,
			encodings: [JSON_GZIP_RESPONSE_ENCODING, TERMINAL_BINARY_DATA_ENCODING],
		});
	});
});
