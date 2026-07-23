/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export const PARADIS_SENTRY_DESKTOP_DSN = 'https://c854d2571bf85beb19b9a8abd94240aa@o4511131276804096.ingest.us.sentry.io/4511784070676480';
export const PARADIS_SENTRY_ENVIRONMENT = 'development';

export function paradisSentryRelease(version: string, commit?: string): string {
	return `para-code@${version}${commit ? `+${commit}` : ''}`;
}
