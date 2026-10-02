/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { createHash } from 'crypto';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IParadisMachineIdSources, paradisMachineIdHash, paradisReadMachineIdHash } from '../../node/paradisMachineId.js';

suite('ParadisMachineId', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function sources(platform: NodeJS.Platform, commands: Record<string, string>, files: Record<string, string>, calls: string[] = [], username: string | null = 'alice'): IParadisMachineIdSources {
		return {
			platform,
			username: () => username ?? undefined,
			fileExists: async filePath => files[filePath] !== undefined,
			env: { SystemRoot: 'C:\\Windows' },
			execFile: async (file, args) => {
				calls.push([file, ...args].join(' '));
				const output = commands[file];
				if (output === undefined) {
					throw new Error(`ENOENT ${file}`);
				}
				return output;
			},
			readFile: async filePath => {
				calls.push(`read ${filePath}`);
				const content = files[filePath];
				if (content === undefined) {
					throw new Error(`ENOENT ${filePath}`);
				}
				return content;
			},
		};
	}

	const expected = (id: string, username = 'alice') => createHash('sha256').update('para-code-machine-v1:' + id + ':' + username).digest('hex');

	// 同じ機械なら PC 版と SSH 先の REH で同じ値になる（OS の機械 ID から作る）。生の ID は出さない。
	test('hashes the OS machine id on macOS, Linux and Windows', async () => {
		const calls: string[] = [];
		const ioreg = '+-o J314sAP  <class IOPlatformExpertDevice>\n    "IOPlatformSerialNumber" = "SERIAL"\n    "IOPlatformUUID" = "0A1B2C3D-0000-1111-2222-333344445555"\n';
		const reg = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    6f1e2d3c-aaaa-bbbb-cccc-0123456789ab\r\n\r\n';
		const results = {
			darwin: await paradisReadMachineIdHash(sources('darwin', { '/usr/sbin/ioreg': ioreg }, {}, calls)),
			linux: await paradisReadMachineIdHash(sources('linux', {}, { '/etc/machine-id': '4c4c4544004d3610804bb4c04f4b4d32\n' }, calls)),
			linuxDbus: await paradisReadMachineIdHash(sources('linux', {}, { '/etc/machine-id': '\n', '/var/lib/dbus/machine-id': 'abcdef0123456789\n' }, calls)),
			win32: await paradisReadMachineIdHash(sources('win32', { 'C:\\Windows\\System32\\reg.exe': reg }, {}, calls)),
		};
		assert.deepStrictEqual({ results, calls }, {
			results: {
				darwin: expected('0a1b2c3d-0000-1111-2222-333344445555'),
				linux: expected('4c4c4544004d3610804bb4c04f4b4d32'),
				linuxDbus: expected('abcdef0123456789'),
				win32: expected('6f1e2d3c-aaaa-bbbb-cccc-0123456789ab'),
			},
			calls: [
				'/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice',
				'read /proc/1/cgroup',
				'read /proc/1/mountinfo',
				'read /etc/machine-id',
				'read /proc/1/cgroup',
				'read /proc/1/mountinfo',
				'read /etc/machine-id',
				'read /var/lib/dbus/machine-id',
				'C:\\Windows\\System32\\reg.exe query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid /reg:64',
			],
		});
		assert.strictEqual(paradisMachineIdHash('abc', 'bob'), expected('abc', 'bob'));
	});

	// 同じ機械でもユーザーが違えば別の印（別のユーザーへの SSH は別の相手として数える）。
	// Linux のコンテナの中では印を出さない（/etc/machine-id をイメージから受け継ぐため）。
	test('separates OS users and withholds the id inside a Linux container', async () => {
		const machineId = { '/etc/machine-id': '4c4c4544004d3610804bb4c04f4b4d32\n' };
		assert.deepStrictEqual({
			alice: await paradisReadMachineIdHash(sources('linux', {}, machineId)),
			bob: await paradisReadMachineIdHash(sources('linux', {}, machineId, [], 'bob')),
			noUser: await paradisReadMachineIdHash(sources('linux', {}, machineId, [], null)),
			dockerenv: await paradisReadMachineIdHash(sources('linux', {}, { ...machineId, '/.dockerenv': '' })),
			podman: await paradisReadMachineIdHash(sources('linux', {}, { ...machineId, '/run/.containerenv': '' })),
			kubepods: await paradisReadMachineIdHash(sources('linux', {}, { ...machineId, '/proc/1/cgroup': '0::/kubepods/besteffort/pod1234\n' })),
			host: await paradisReadMachineIdHash(sources('linux', {}, { ...machineId, '/proc/1/cgroup': '0::/init.scope\n' })),
			kubernetesEnv: await paradisReadMachineIdHash({ ...sources('linux', {}, machineId), env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' } }),
			kubernetesSecrets: await paradisReadMachineIdHash(sources('linux', {}, { ...machineId, '/run/secrets/kubernetes.io': '' })),
			overlayRoot: await paradisReadMachineIdHash(sources('linux', {}, { ...machineId, '/proc/1/mountinfo': '22 1 0:21 / /proc rw - proc proc rw\n401 380 0:55 / / rw,relatime - overlay overlay rw,lowerdir=/x\n' })),
			ext4Root: await paradisReadMachineIdHash(sources('linux', {}, { ...machineId, '/proc/1/mountinfo': '26 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw\n' })),
		}, {
			alice: expected('4c4c4544004d3610804bb4c04f4b4d32'),
			bob: expected('4c4c4544004d3610804bb4c04f4b4d32', 'bob'),
			noUser: undefined,
			dockerenv: undefined,
			podman: undefined,
			kubepods: undefined,
			host: expected('4c4c4544004d3610804bb4c04f4b4d32'),
			kubernetesEnv: undefined,
			kubernetesSecrets: undefined,
			overlayRoot: undefined,
			ext4Root: expected('4c4c4544004d3610804bb4c04f4b4d32'),
		});
	});

	// 読めない・仮の値（すべて 0）のときは印を作らない（無関係な機械どうしが同じになるため）。
	test('returns undefined when the id cannot be read or is a placeholder', async () => {
		assert.deepStrictEqual({
			commandFails: await paradisReadMachineIdHash(sources('darwin', {}, {})),
			noUuid: await paradisReadMachineIdHash(sources('darwin', { '/usr/sbin/ioreg': '"IOPlatformSerialNumber" = "X"' }, {})),
			zeroUuid: await paradisReadMachineIdHash(sources('darwin', { '/usr/sbin/ioreg': '"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"' }, {})),
			noFiles: await paradisReadMachineIdHash(sources('linux', {}, {})),
			noGuid: await paradisReadMachineIdHash(sources('win32', { 'C:\\Windows\\System32\\reg.exe': 'ERROR: not found' }, {})),
		}, {
			commandFails: undefined,
			noUuid: undefined,
			zeroUuid: undefined,
			noFiles: undefined,
			noGuid: undefined,
		});
	});
});
