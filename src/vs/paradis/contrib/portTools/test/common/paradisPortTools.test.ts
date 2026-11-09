/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_PORT_TOOLS, paradisParsePortToolCall, paradisPortToolRequestChanges } from '../../common/paradisPortTools.js';

function parse(name: string, args: unknown): unknown {
	const result = paradisParsePortToolCall(name, args);
	if (result === undefined) {
		return 'not mine';
	}
	return result.ok ? result.request : `error: ${result.error}`;
}

suite('ParadisPortTools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('defines the five tools with their arguments and annotations', () => {
		assert.deepStrictEqual(PARADIS_PORT_TOOLS.map(tool => {
			const schema = tool.inputSchema as { properties: Record<string, unknown>; required?: string[]; additionalProperties: boolean };
			return {
				name: tool.name,
				properties: Object.keys(schema.properties),
				required: schema.required ?? [],
				additionalProperties: schema.additionalProperties,
				annotations: tool.annotations,
			};
		}), [
			{ name: 'list_port_forwards', properties: ['include_detected'], required: [], additionalProperties: false, annotations: { readOnlyHint: true, openWorldHint: false } },
			{ name: 'forward_port', properties: ['ports', 'remote_port', 'local_port', 'label', 'protocol'], required: [], additionalProperties: false, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
			{ name: 'stop_port_forward', properties: ['ports', 'remote_port'], required: [], additionalProperties: false, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
			{ name: 'reforward_port', properties: ['ports', 'remote_port', 'align_local_port'], required: [], additionalProperties: false, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
			{ name: 'clean_up_port_forwards', properties: ['mode', 'dry_run'], required: [], additionalProperties: false, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
		]);
		const forward = PARADIS_PORT_TOOLS[1].inputSchema as { properties: Record<string, { minimum?: number; maximum?: number }> };
		assert.deepStrictEqual([forward.properties.remote_port.minimum, forward.properties.remote_port.maximum, forward.properties.local_port.minimum, forward.properties.local_port.maximum], [1, 65535, 1, 65535]);
	});

	test('fills the defaults and tells which requests change forwards', () => {
		const requests = [
			paradisParsePortToolCall('list_port_forwards', undefined),
			paradisParsePortToolCall('forward_port', { remote_port: 21004 }),
			paradisParsePortToolCall('forward_port', { remote_port: 21004, local_port: 31004, label: ' vite ', protocol: 'https' }),
			paradisParsePortToolCall('stop_port_forward', { remote_port: [21004, 21005, 21004] }),
			paradisParsePortToolCall('stop_port_forward', { remote_port: 65535 }),
			paradisParsePortToolCall('reforward_port', { remote_port: 1 }),
			paradisParsePortToolCall('forward_port', { ports: [{ remote_port: 21004 }, { remote_port: 21005, local_port: 31005, label: 'api' }] }),
			paradisParsePortToolCall('stop_port_forward', { ports: [{ remote_port: 21004 }, { remote_port: 21005 }] }),
			paradisParsePortToolCall('reforward_port', { ports: [{ remote_port: 21004 }, { remote_port: 21005, align_local_port: false }], align_local_port: true }),
			paradisParsePortToolCall('clean_up_port_forwards', {}),
			paradisParsePortToolCall('clean_up_port_forwards', { mode: 'mismatched', dry_run: false }),
		].map(result => result?.ok ? result.request : undefined);
		assert.deepStrictEqual(requests.map(request => request && { request, changes: paradisPortToolRequestChanges(request) }), [
			{ request: { op: 'list', includeDetected: false }, changes: false },
			{ request: { op: 'forward', items: [{ remotePort: 21004, localPort: 21004 }], batch: false }, changes: true },
			{ request: { op: 'forward', items: [{ remotePort: 21004, localPort: 31004, label: 'vite', protocol: 'https' }], batch: false }, changes: true },
			{ request: { op: 'stop', remotePorts: [21004, 21005] }, changes: true },
			{ request: { op: 'stop', remotePorts: [65535] }, changes: true },
			{ request: { op: 'reforward', items: [{ remotePort: 1, alignLocalPort: false }], batch: false }, changes: true },
			{ request: { op: 'forward', items: [{ remotePort: 21004, localPort: 21004 }, { remotePort: 21005, localPort: 31005, label: 'api' }], batch: true }, changes: true },
			{ request: { op: 'stop', remotePorts: [21004, 21005] }, changes: true },
			{ request: { op: 'reforward', items: [{ remotePort: 21004, alignLocalPort: true }, { remotePort: 21005, alignLocalPort: false }], batch: true }, changes: true },
			{ request: { op: 'cleanUp', mode: 'not_listening', dryRun: true }, changes: false },
			{ request: { op: 'cleanUp', mode: 'mismatched', dryRun: false }, changes: true },
		]);
	});

	test('refuses port numbers outside 1-65535, non-integers and unknown arguments', () => {
		assert.deepStrictEqual([
			parse('forward_port', { remote_port: 0 }),
			parse('forward_port', { remote_port: 65536 }),
			parse('forward_port', { remote_port: 80.5 }),
			parse('forward_port', { remote_port: '80' }),
			parse('forward_port', {}),
			parse('forward_port', { remote_port: 80, local_port: -1 }),
			parse('forward_port', { remote_port: 80, remote_host: '10.0.0.5' }),
			parse('forward_port', { remote_port: 80, protocol: 'ftp' }),
			parse('stop_port_forward', { remote_port: [] }),
			parse('stop_port_forward', { remote_port: [80, 70000] }),
			parse('reforward_port', { remote_port: 80, align_local_port: 'yes' }),
			parse('clean_up_port_forwards', { mode: 'everything' }),
			parse('list_port_forwards', []),
			parse('forward_port', { ports: [{ remote_port: 80 }], remote_port: 81 }),
			parse('forward_port', { ports: [{ remote_port: 80 }, { remote_port: 80, local_port: 8080 }] }),
			parse('reforward_port', { ports: [{ remote_port: 80, local_port: 81 }] }),
			parse('reforward_port', { ports: [{ remote_port: 80 }, { remote_port: 0 }] }),
			parse('forward_port', { ports: Array.from({ length: 101 }, (_, index) => ({ remote_port: 1000 + index })) }),
			parse('stop_port_forward', { remote_port: Array.from({ length: 101 }, (_, index) => 1000 + index) }),
			parse('reforward_port', { ports: [] }),
			parse('take_snapshot', {}),
		], [
			'error: "remote_port" must be an integer port number from 1 to 65535.',
			'error: "remote_port" must be an integer port number from 1 to 65535.',
			'error: "remote_port" must be an integer port number from 1 to 65535.',
			'error: "remote_port" must be an integer port number from 1 to 65535.',
			'error: "remote_port" is required.',
			'error: "local_port" must be an integer port number from 1 to 65535.',
			'error: Unknown argument "remote_host". Allowed: ports, remote_port, local_port, label, protocol.',
			'error: "protocol" must be "http" or "https".',
			'error: "remote_port" is required: a port number or a list of port numbers (or pass "ports").',
			'error: "remote_port" must be an integer port number from 1 to 65535, or a list of them.',
			'error: "align_local_port" must be true or false.',
			'error: "mode" must be "not_listening" or "mismatched".',
			'error: The arguments must be an object.',
			'error: Pass either "ports" or "remote_port", not both. Put every forward in "ports".',
			'error: remote_port 80 is listed more than once. List each port once.',
			'error: Unknown argument "ports[0].local_port". Allowed: remote_port, align_local_port.',
			'error: "ports[1].remote_port" must be an integer port number from 1 to 65535.',
			'error: "ports" may list at most 100 forwards in one call. Split them into several calls of up to 100.',
			'error: "remote_port" may list at most 100 ports in one call. Split them into several calls of up to 100.',
			'error: "ports" must be a non-empty list of objects such as { "remote_port": 21004 }.',
			'not mine',
		]);
	});
});
