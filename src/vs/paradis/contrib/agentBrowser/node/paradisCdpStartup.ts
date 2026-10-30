/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code).

import { createServer } from 'net';

interface IParadisCdpCommandLine {
	hasSwitch(name: string): boolean;
	appendSwitch(name: string, value: string): void;
}

/** Choose a free loopback port and release the probe listener before Chromium starts. */
async function allocateLoopbackPort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(error => {
				if (error) {
					reject(error);
				} else if (address && typeof address !== 'string') {
					resolve(address.port);
				} else {
					reject(new Error('Could not allocate a loopback CDP port'));
				}
			});
		});
	});
}

/** Configure CDP before app readiness without Chromium's port-zero WebDriver mode. */
export async function paradisConfigureCdpPort(commandLine: IParadisCdpCommandLine, allocatePort: () => Promise<number> = allocateLoopbackPort): Promise<void> {
	if (commandLine.hasSwitch('remote-debugging-port') || commandLine.hasSwitch('remote-debugging-pipe')) {
		return;
	}
	const port = await allocatePort();
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error('Invalid loopback CDP port');
	}
	commandLine.appendSwitch('remote-debugging-port', String(port));
	commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}
