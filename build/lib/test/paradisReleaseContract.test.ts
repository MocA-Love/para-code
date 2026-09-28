/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { createServer } from 'http';
import { tmpdir } from 'os';
import JSZip from 'jszip';
import { load } from 'js-yaml';
import * as path from 'path';
import { Stream } from 'stream';
import { suite, test } from 'node:test';
import File from 'vinyl';
import { getParadisDesktopUpdatePlatform } from '../../../src/vs/platform/update/common/paradisUpdatePlatform.ts';
import type { IExtensionDefinition } from '../builtInExtensions.ts';
import { fromMarketplace } from '../extensions.ts';

interface IWorkflowStep {
	readonly name?: string;
	readonly uses?: string;
	readonly run?: string;
	readonly with?: Record<string, string>;
}

interface IWorkflowJob {
	readonly strategy?: { readonly matrix?: { readonly arch?: readonly string[] } };
	readonly steps: readonly IWorkflowStep[];
}

interface IReleaseWorkflow {
	readonly jobs: Record<string, IWorkflowJob>;
}

interface IProductManifest {
	readonly updateUrl: string;
	readonly extensionsGallery: { readonly serviceUrl: string };
	readonly builtInExtensions: readonly IExtensionDefinition[];
}

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

function readReleaseWorkflow(): IReleaseWorkflow {
	return load(fs.readFileSync(path.join(repositoryRoot, '.github/workflows/para-release.yml'), 'utf8')) as IReleaseWorkflow;
}

function readProductManifest(): IProductManifest {
	return JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'product.json'), 'utf8')) as IProductManifest;
}

function getUploadContract(job: IWorkflowJob): { readonly artifact: string; readonly files: readonly string[] } {
	const upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
	assert.ok(upload?.with?.name);
	assert.ok(upload.with.path);
	return {
		artifact: upload.with.name,
		files: upload.with.path.split('\n').map(file => file.trim()).filter(file => file.length > 0),
	};
}

function expandUploadContract(contract: { readonly artifact: string; readonly files: readonly string[] }, architectures: readonly string[] = ['']): readonly { readonly artifact: string; readonly file: string }[] {
	return architectures.flatMap(arch => contract.files
		.filter(file => !file.endsWith('.sha256'))
		.map(file => ({
			artifact: contract.artifact.replaceAll('${{ matrix.arch }}', arch),
			file: file.replaceAll('${{ matrix.arch }}', arch),
		})));
}

function getPublishedArtifacts(workflow: IReleaseWorkflow): readonly { readonly platform: string; readonly directory: string; readonly file: string; readonly artifact: string }[] {
	const publishScript = workflow.jobs['publish'].steps.find(step => step.name === 'Publish artifacts to R2 + update feed KV')?.run;
	assert.ok(publishScript);
	// The KV key prefix is the channel (`$CHANNEL:<platform>`), so the call sites only carry the platform.
	return [...publishScript.matchAll(/^\s*publish\s+"(?<platform>[^"]+)"\s+"(?<directory>[^"]+)"\s+"(?<file>[^"]+)"\s+"(?<artifact>[^"]+)"/gm)].map(match => ({
		platform: match.groups!.platform,
		directory: match.groups!.directory,
		file: match.groups!.file,
		artifact: match.groups!.artifact,
	}));
}

function getPublishStepScript(workflow: IReleaseWorkflow, name: string): string {
	const script = workflow.jobs.publish.steps.find(step => step.name === name)?.run;
	assert.ok(script, name);
	return script;
}

/**
 * Runs publish-job step scripts in bash with `aws`, `wrangler`, `gh` and `sha256sum` replaced by
 * functions that print their arguments, and returns the printed calls. `${{ expr }}` becomes
 * `@expr@`. `gh release view` reports the release as missing so the create path is taken (its
 * output goes to /dev/null in the workflow, so it does not show up in the returned calls).
 */
function simulatePublishSteps(workflow: IReleaseWorkflow, channel: string, tag: string): readonly string[] {
	const stubs = [
		'aws() { echo "aws $*"; }',
		'wrangler() { echo "wrangler $*"; }',
		'sha256sum() { echo "sha256sum $*" >&2; }',
		'gh() { echo "gh $*"; if [ "$1 $2" = "release view" ]; then return 1; fi; }',
	].join('\n');
	const scripts = ['Publish artifacts to R2 + update feed KV', 'Create GitHub Release with artifacts']
		.map(name => getPublishStepScript(workflow, name).replace(/\$\{\{\s*(?<expr>[^}]+?)\s*\}\}/g, (_match, expr: string) => `@${expr}@`));
	const cwd = fs.mkdtempSync(path.join(tmpdir(), 'para-release-'));
	try {
		for (const [artifact, file] of [
			['darwin-x64', 'darwin-x64.zip'],
			['darwin-arm64', 'darwin-arm64.zip'],
			['win32-x64', 'win32-x64-user-setup.exe'],
			['win32-arm64', 'win32-arm64-user-setup.exe'],
			['linux-x64', 'linux-x64.deb'],
		]) {
			fs.mkdirSync(path.join(cwd, 'artifacts', artifact), { recursive: true });
			fs.writeFileSync(path.join(cwd, 'artifacts', artifact, file), file);
			fs.writeFileSync(path.join(cwd, 'artifacts', artifact, `${file}.sha256`), `hash-${file}\n`);
		}
		return scripts.flatMap(script => execFileSync('bash', ['-c', `${stubs}\n${script}`], {
			cwd,
			encoding: 'utf8',
			env: { PATH: process.env['PATH'], CHANNEL: channel, GITHUB_REF: `refs/tags/${tag}`, GITHUB_REPOSITORY: 'owner/repo', CLOUDFLARE_ACCOUNT_ID: 'account' },
		}).split('\n').filter(line => line.length > 0));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

async function createVsixFixture(): Promise<Buffer> {
	const zip = new JSZip();
	zip.file('extension/package.json', JSON.stringify({ publisher: 'ms-vscode', name: 'vscode-js-profile-table', version: '1.0.11' }));
	zip.file('extension/out/extension.js', 'module.exports = {};');
	return zip.generateAsync({ type: 'nodebuffer' });
}

function collectFiles(stream: Stream): Promise<readonly File[]> {
	return new Promise((resolve, reject) => {
		const files: File[] = [];
		stream.on('data', file => files.push(file));
		stream.on('error', reject);
		stream.on('end', () => resolve(files));
	});
}

async function consumeMarketplaceFixture(extension: IExtensionDefinition): Promise<{ readonly requestedPath: string; readonly files: readonly File[] }> {
	const vsix = await createVsixFixture();
	let requestedPath: string | undefined;
	const server = createServer((request, response) => {
		requestedPath = request.url;
		response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
		response.end(vsix);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});

	try {
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const files = await collectFiles(fromMarketplace(`http://127.0.0.1:${address.port}`, {
			...extension,
			sha256: createHash('sha256').update(vsix).digest('hex'),
		}));
		assert.ok(requestedPath);
		return { requestedPath, files };
	} finally {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
}

suite('Para Code release contract', () => {
	test('publishes the platform names consumed by desktop update clients from matching workflow artifacts', () => {
		const workflow = readReleaseWorkflow();
		const published = getPublishedArtifacts(workflow);
		const desktopPlatforms = [
			getParadisDesktopUpdatePlatform('darwin', 'x64'),
			getParadisDesktopUpdatePlatform('darwin', 'arm64'),
			getParadisDesktopUpdatePlatform('win32', 'x64', { target: 'user' }),
			getParadisDesktopUpdatePlatform('win32', 'arm64', { target: 'user' }),
			getParadisDesktopUpdatePlatform('linux', 'x64'),
		];
		const uploadContracts = {
			darwin: getUploadContract(workflow.jobs['build-darwin']),
			win32: getUploadContract(workflow.jobs['build-win32']),
			linux: getUploadContract(workflow.jobs['build-linux']),
		};

		assert.deepStrictEqual(workflow.jobs['build-darwin'].strategy?.matrix?.arch, ['x64', 'arm64']);
		assert.deepStrictEqual(workflow.jobs['build-win32'].strategy?.matrix?.arch, ['x64', 'arm64']);
		assert.deepStrictEqual(published.map(item => item.platform).sort(), desktopPlatforms.sort());
		assert.deepStrictEqual(uploadContracts, {
			darwin: { artifact: 'darwin-${{ matrix.arch }}', files: ['darwin-${{ matrix.arch }}.zip', 'darwin-${{ matrix.arch }}.zip.sha256'] },
			win32: { artifact: 'win32-${{ matrix.arch }}', files: ['win32-${{ matrix.arch }}-user-setup.exe', 'win32-${{ matrix.arch }}-user-setup.exe.sha256'] },
			linux: { artifact: 'linux-x64', files: ['linux-x64.deb', 'linux-x64.deb.sha256'] },
		});
		const uploaded = [
			...expandUploadContract(uploadContracts.darwin, workflow.jobs['build-darwin'].strategy?.matrix?.arch),
			...expandUploadContract(uploadContracts.win32, workflow.jobs['build-win32'].strategy?.matrix?.arch),
			...expandUploadContract(uploadContracts.linux),
		];
		assert.deepStrictEqual(
			published.map(item => JSON.stringify({ artifact: item.artifact, file: item.file })).sort(),
			uploaded.map(item => JSON.stringify(item)).sort(),
		);
	});

	// The stable expectation spells out the exact R2 keys, KV keys/values and Release calls the
	// workflow produced before channels existed (hard-coded `stable/...`, `stable:*`,
	// `changelog:stable`, plain `gh release create`), so any drift on the stable path fails here.
	test('publishes stable exactly as before and keeps beta under beta/ and beta:* only', () => {
		const workflow = readReleaseWorkflow();
		const r2 = (channel: string, platdir: string, file: string, artifact: string) =>
			`aws s3 cp artifacts/${artifact}/${file} s3://@secrets.CF_R2_BUCKET@/${channel}/${platdir}/@steps.meta.outputs.commit@/${file} --endpoint-url https://account.r2.cloudflarestorage.com --no-progress`;
		const kv = (channel: string, platform: string, platdir: string, file: string) =>
			`wrangler kv key put --namespace-id @secrets.CF_KV_NAMESPACE_ID@ --remote ${channel}:${platform} {"commit":"@steps.meta.outputs.commit@","version":"@steps.meta.outputs.version@","productVersion":"@steps.meta.outputs.version@","url":"@secrets.CF_R2_PUBLIC_BASE_URL@/${channel}/${platdir}/@steps.meta.outputs.commit@/${file}","sha256hash":"hash-${file}","timestamp":@steps.meta.outputs.timestamp@}`;
		const feed = (channel: string, platform: string, platdir: string, file: string, artifact: string) => [r2(channel, platdir, file, artifact), kv(channel, platform, platdir, file)];
		const changelog = (channel: string) => `wrangler kv key put --namespace-id @secrets.CF_KV_NAMESPACE_ID@ --remote --path src/vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md changelog:${channel}`;
		const setup = 'aws configure set default.s3.multipart_threshold 1GB';

		const stableTag = 'v1.139.1-paracode-146';
		assert.deepStrictEqual(simulatePublishSteps(workflow, 'stable', stableTag), [
			setup,
			...feed('stable', 'darwin', 'darwin-x64', 'darwin-x64.zip', 'darwin-x64'),
			...feed('stable', 'darwin-arm64', 'darwin-arm64', 'darwin-arm64.zip', 'darwin-arm64'),
			...feed('stable', 'win32-x64-user', 'win32-x64-user', 'win32-x64-user-setup.exe', 'win32-x64'),
			...feed('stable', 'win32-arm64-user', 'win32-arm64-user', 'win32-arm64-user-setup.exe', 'win32-arm64'),
			...feed('stable', 'linux-x64', 'linux-x64', 'linux-x64.deb', 'linux-x64'),
			changelog('stable'),
			`gh release create ${stableTag} --repo owner/repo --title ${stableTag} --generate-notes`,
			`gh release upload ${stableTag} --repo owner/repo --clobber ${[
				'ParaCode-v1.139.1-paracode-146-SHA256SUMS.txt',
				'ParaCode-v1.139.1-paracode-146-darwin-arm64.zip',
				'ParaCode-v1.139.1-paracode-146-darwin-x64.zip',
				'ParaCode-v1.139.1-paracode-146-linux-x64.deb',
				'ParaCode-v1.139.1-paracode-146-win32-arm64-setup.exe',
				'ParaCode-v1.139.1-paracode-146-win32-x64-setup.exe',
			].map(file => `release-assets/${file}`).join(' ')}`,
		]);

		const betaTag = 'v1.139.1-paracode-146-beta.1';
		assert.deepStrictEqual(simulatePublishSteps(workflow, 'beta', betaTag), [
			setup,
			...feed('beta', 'darwin', 'darwin-x64', 'darwin-x64.zip', 'darwin-x64'),
			...feed('beta', 'darwin-arm64', 'darwin-arm64', 'darwin-arm64.zip', 'darwin-arm64'),
			changelog('beta'),
			`gh release create ${betaTag} --repo owner/repo --title ${betaTag} --generate-notes --prerelease --latest=false`,
			`gh release upload ${betaTag} --repo owner/repo --clobber ${[
				'ParaCode-v1.139.1-paracode-146-beta.1-SHA256SUMS.txt',
				'ParaCode-v1.139.1-paracode-146-beta.1-darwin-arm64.zip',
				'ParaCode-v1.139.1-paracode-146-beta.1-darwin-x64.zip',
			].map(file => `release-assets/${file}`).join(' ')}`,
		]);

		assert.throws(() => simulatePublishSteps(workflow, '', stableTag));
	});

	// This used to pin the digest Open VSX served when its repackaged bytes differed from the
	// marketplace ones. Open VSX has since gone back to byte-identical packages, so product.json
	// carries the upstream digest again (see NOTES.md, 2026-08-27) and pinning either literal here
	// just rots the moment upstream bumps the extension. What matters is that the gallery is Open VSX,
	// that the builtin carries a well-formed digest, and that `fromMarketplace` actually verifies it.
	test('pins a well-formed builtin checksum and consumes it through fromMarketplace', async () => {
		const product = readProductManifest();
		assert.strictEqual(product.extensionsGallery.serviceUrl, 'https://open-vsx.org/vscode/gallery');
		const extension = product.builtInExtensions.find(candidate => candidate.name === 'ms-vscode.vscode-js-profile-table');
		assert.ok(extension);
		assert.deepStrictEqual({
			hasVersion: /^\d+\.\d+\.\d+$/.test(extension.version),
			hasSha256: /^[0-9a-f]{64}$/.test(extension.sha256 ?? ''),
		}, { hasVersion: true, hasSha256: true });
		const result = await consumeMarketplaceFixture(extension);
		const [publisher, name] = extension.name.split('.');
		const packageJson = result.files.find(file => file.relative === 'package.json');
		assert.ok(packageJson?.contents);
		assert.deepStrictEqual({
			requestedPath: result.requestedPath,
			files: result.files.map(file => file.relative).sort(),
			metadata: JSON.parse(packageJson.contents.toString()).__metadata,
		}, {
			requestedPath: `/publishers/${publisher}/vsextensions/${name}/${extension.version}/vspackage`,
			files: ['out', 'out/extension.js', 'package.json'],
			metadata: extension.metadata,
		});
	});
});
