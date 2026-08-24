/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { IRequestContext, IRequestOptions } from '../../../../../base/parts/request/common/request.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AuthInfo, Credentials, IRequestService } from '../../../../../platform/request/common/request.js';
import { configureParadisDiagnosticReporter, type ParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { PARADIS_SERVICE_STATUS_SOURCES } from '../../common/paradisServiceStatus.js';
import { ParadisServiceStatusClient } from '../../electron-browser/paradisServiceStatusClient.js';

const privateResponseNeedles = [
	'private-response-body',
	'file:///Users/alice/service-status.json',
	'https://private.example.test/status',
];

function response(body: string): IRequestContext {
	return {
		res: { headers: {}, statusCode: 200 },
		stream: bufferToStream(VSBuffer.fromString(body)),
	};
}

class SequencedStatusRequestService implements IRequestService {
	declare readonly _serviceBrand: undefined;
	readonly onDidCompleteRequest = Event.None;
	private claudeAttempt = 0;

	async request(options: IRequestOptions, _token: CancellationToken): Promise<IRequestContext> {
		if (options.url === PARADIS_SERVICE_STATUS_SOURCES.claude.apiUrl) {
			const attempt = this.claudeAttempt++;
			if (attempt === 2) {
				return response(JSON.stringify({ status: { indicator: 'none', description: 'All Systems Operational' } }));
			}
			if (attempt === 1) {
				return response(JSON.stringify({
					status: { indicator: 123 },
					private: privateResponseNeedles.join(' '),
				}));
			}
			return response(
				'{"status":{"indicator":"none"},"private":"private-response-body file:///Users/alice/service-status.json https://private.example.test/status attempt-' + attempt + '",',
			);
		}
		return response(JSON.stringify({ status: { indicator: 'none', description: 'All Systems Operational' } }));
	}

	async resolveProxy(_url: string): Promise<string | undefined> { return undefined; }
	async lookupAuthorization(_authInfo: AuthInfo): Promise<Credentials | undefined> { return undefined; }
	async lookupKerberosAuthorization(_url: string): Promise<string | undefined> { return undefined; }
	async loadCertificates(): Promise<string[]> { return []; }
}

suite('ParadisServiceStatusClient diagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports only the start of each provider failure episode with a fixed error', async () => {
		const reports: Array<{
			readonly scope: string;
			readonly feature: string;
			readonly operation: string;
			readonly error: unknown;
			readonly safeExtra: Parameters<ParadisDiagnosticReporter>[4];
			readonly severity: string | undefined;
		}> = [];
		configureParadisDiagnosticReporter((scope, feature, operation, error, safeExtra, severity) => {
			reports.push({ scope, feature, operation, error, safeExtra, severity });
		});

		try {
			const client = new ParadisServiceStatusClient(new SequencedStatusRequestService());
			const snapshots = [];
			for (let index = 0; index < 4; index++) {
				snapshots.push(await client.getSnapshot());
			}

			assert.deepStrictEqual(
				snapshots.map(snapshot => snapshot.entries.claude.severity),
				['unknown', 'unknown', 'ok', 'unknown'],
			);
			assert.ok(snapshots[0].entries.claude.error?.includes('private-response-body'));
			assert.strictEqual(snapshots[0].entries.claude.error?.length, 161);
			assert.ok(snapshots[0].entries.claude.error?.endsWith('…'));
			assert.deepStrictEqual(reports.map(report => ({
				scope: report.scope,
				feature: report.feature,
				operation: report.operation,
				message: report.error instanceof Error ? report.error.message : String(report.error),
				provider: report.safeExtra?.['safe_provider'],
				safeExtraKeys: report.safeExtra ? Object.keys(report.safeExtra) : [],
				severity: report.severity,
			})), [{
				scope: 'owned',
				feature: 'service-status',
				operation: 'fetch-failed',
				message: 'Service status provider request failed',
				provider: 'claude',
				safeExtraKeys: ['safe_provider'],
				severity: 'warning',
			}, {
				scope: 'owned',
				feature: 'service-status',
				operation: 'fetch-failed',
				message: 'Service status provider request failed',
				provider: 'claude',
				safeExtraKeys: ['safe_provider'],
				severity: 'warning',
			}]);
			assert.ok(reports.every(report => report.error instanceof Error));
			assert.ok(reports.every(report => {
				const error = report.error as Error;
				return !Object.hasOwn(error, 'cause')
					&& Object.getOwnPropertyNames(error).sort().join(',') === 'message,stack';
			}));
			assert.ok(reports.every(report => privateResponseNeedles.every(needle => {
				const error = report.error as Error;
				return !error.message.includes(needle) && !error.stack?.includes(needle);
			})));
		} finally {
			configureParadisDiagnosticReporter(() => { });
		}
	});
});
