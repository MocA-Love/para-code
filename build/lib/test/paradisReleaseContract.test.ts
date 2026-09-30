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
import { planParadisRelease, toParadisReleaseOutputs, type IParadisReleaseRef } from '../paradisReleaseChannel.ts';
import type { IExtensionDefinition } from '../builtInExtensions.ts';
import { fromMarketplace } from '../extensions.ts';

interface IWorkflowStep {
	readonly name?: string;
	readonly id?: string;
	readonly if?: string;
	readonly uses?: string;
	readonly run?: string;
	readonly with?: Record<string, string>;
	readonly env?: Record<string, string>;
}

interface IWorkflowJob {
	readonly needs?: string | readonly string[];
	readonly if?: string;
	readonly env?: Record<string, string>;
	readonly outputs?: Record<string, string>;
	readonly strategy?: { readonly matrix?: { readonly arch?: readonly string[] } };
	readonly steps: readonly IWorkflowStep[];
}

interface IReleaseWorkflow {
	readonly env?: Record<string, string>;
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

function readRehWorkflow(): IReleaseWorkflow {
	return load(fs.readFileSync(path.join(repositoryRoot, '.github/workflows/para-reh.yml'), 'utf8')) as IReleaseWorkflow;
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
	const publishScript = workflow.jobs.publish.steps.find(step => step.name === 'Publish artifacts to R2 + update feed KV')?.run;
	assert.ok(publishScript);
	// The KV key prefix is the channel (`$CHANNEL:<platform>`), so the call sites only carry the platform.
	return [...publishScript.matchAll(/^\s*publish\s+"(?<platform>[^"]+)"\s+"(?<directory>[^"]+)"\s+"(?<file>[^"]+)"\s+"(?<artifact>[^"]+)"/gm)].map(match => ({
		platform: match.groups!.platform,
		directory: match.groups!.directory,
		file: match.groups!.file,
		artifact: match.groups!.artifact,
	}));
}

function getStep(job: IWorkflowJob, name: string): IWorkflowStep {
	const step = job.steps.find(candidate => candidate.name === name);
	assert.ok(step, name);
	return step;
}

interface IExpressionContext {
	readonly cancelled?: boolean;
	readonly eventName?: string;
	readonly inputs?: Record<string, string | boolean>;
	readonly needs?: Record<string, { readonly result: string; readonly outputs?: Record<string, string> }>;
	readonly steps?: Record<string, Record<string, string>>;
}

const EXPRESSION_PATTERN = /\$\{\{\s*(?<expr>[\s\S]+?)\s*\}\}/g;

/**
 * Evaluates the subset of GitHub Actions expressions these workflows use (`needs.*.result`,
 * `needs.*.outputs.*`, `steps.*.outputs.*`, `github.event_name`, `inputs.*`, `secrets.*` (as a
 * placeholder), `cancelled()`, string
 * literals, `==`, `!=`, `&&`, `||`, `!`, parentheses). Missing outputs are '' like on GitHub.
 * Anything else throws, so a new construct in the workflow makes this test fail instead of passing.
 */
function evaluateExpression(expression: string, context: IExpressionContext): unknown {
	const literal = (value: unknown) => JSON.stringify(value ?? '');
	const translated = expression
		.replace(/'(?<text>[^']*)'/g, (_match, text: string) => literal(text))
		.replace(/\bcancelled\(\)/g, () => literal(context.cancelled ?? false))
		.replace(/\bneeds\.(?<job>[\w-]+)\.result\b/g, (_match, job: string) => literal(context.needs?.[job]?.result))
		.replace(/\bneeds\.(?<job>[\w-]+)\.outputs\.(?<key>\w+)/g, (_match, job: string, key: string) => literal(context.needs?.[job]?.outputs?.[key]))
		.replace(/\bsteps\.(?<step>[\w-]+)\.outputs\.(?<key>\w+)/g, (_match, step: string, key: string) => literal(context.steps?.[step]?.[key]))
		.replace(/\bgithub\.event_name\b/g, () => literal(context.eventName))
		.replace(/\binputs\.(?<key>\w+)/g, (_match, key: string) => literal(context.inputs?.[key]))
		.replace(/\bsecrets\.(?<key>\w+)/g, (_match, key: string) => literal(`@secrets.${key}@`));
	const withoutStrings = translated.replace(/"(?:[^"\\]|\\.)*"|\btrue\b|\bfalse\b/g, '');
	assert.match(withoutStrings, /^[\s!=&|()]*$/, `unsupported expression: ${expression}`);
	return new Function(`return (${translated.replace(/==/g, '===').replace(/!===/g, '!==')});`)();
}

/** Evaluates a workflow value that is either a whole `${{ }}` expression or a plain string. */
function evaluateValue(value: string | undefined, context: IExpressionContext): unknown {
	if (value === undefined) {
		return undefined;
	}
	const match = /^\s*\$\{\{\s*(?<expr>[\s\S]+?)\s*\}\}\s*$/.exec(value);
	return match?.groups ? evaluateExpression(match.groups.expr, context) : value;
}

/** Truthiness of a job/step `if:` the way GitHub reads it (a string expression without `${{ }}` is allowed). */
function evaluateCondition(condition: string | undefined, context: IExpressionContext): boolean {
	if (condition === undefined) {
		return true;
	}
	const inner = /\$\{\{/.test(condition) ? condition : `\${{ ${condition} }}`;
	return Boolean(evaluateValue(inner, context));
}

interface IScriptFixture {
	readonly env?: Record<string, string>;
	/** Value for `${{ expr }}` inside the script; `@expr@` is used when this returns undefined. */
	readonly substitute?: (expression: string) => string | undefined;
	/** `gh release view <tag>` succeeds (the release already exists). */
	readonly releaseExists?: boolean;
	/** Stdout of `gh release list`. */
	readonly releaseList?: readonly string[];
	/** Stdout of `gh release view reh --json assets ...`; `undefined` makes that call fail. */
	readonly rehAssets?: readonly string[];
}

/**
 * Runs workflow `run:` scripts in bash with `aws`, `wrangler`, `gh` and `sha256sum` replaced by
 * functions that record their arguments, and returns the recorded calls. The real
 * build/lib/paradisReleaseChannel.ts is available at its repository path, so `node` pipelines run
 * the real code.
 */
function runStepScripts(scripts: readonly string[], fixture: IScriptFixture): readonly string[] {
	const stubs = [
		'aws() { echo "aws $*" >> "$CALL_LOG"; }',
		'wrangler() { echo "wrangler $*" >> "$CALL_LOG"; }',
		'sha256sum() { :; }',
		'gh() {',
		'  echo "gh $*" >> "$CALL_LOG"',
		'  if [ "$1 $2" = "release list" ]; then printf "%s" "$GH_RELEASE_LIST"; return 0; fi',
		'  if [ "$1 $2" = "release view" ]; then',
		'    case " $* " in *" --json "*) if [ "$GH_ASSETS_FAIL" = 1 ]; then return 1; fi; printf "%s" "$GH_ASSETS"; return 0;; esac',
		'    if [ "$GH_RELEASE_EXISTS" = 1 ]; then return 0; fi; return 1',
		'  fi',
		'}',
	].join('\n');
	const cwd = fs.mkdtempSync(path.join(tmpdir(), 'para-release-'));
	const callLog = path.join(cwd, 'calls.log');
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
		fs.mkdirSync(path.join(cwd, 'build/lib'), { recursive: true });
		fs.copyFileSync(path.join(repositoryRoot, 'build/lib/paradisReleaseChannel.ts'), path.join(cwd, 'build/lib/paradisReleaseChannel.ts'));
		fs.writeFileSync(callLog, '');
		const env = {
			PATH: process.env['PATH'],
			CALL_LOG: callLog,
			GITHUB_REPOSITORY: 'owner/repo',
			CLOUDFLARE_ACCOUNT_ID: 'account',
			GH_RELEASE_EXISTS: fixture.releaseExists ? '1' : '0',
			GH_RELEASE_LIST: (fixture.releaseList ?? []).map(tag => `${tag}\n`).join(''),
			GH_ASSETS: (fixture.rehAssets ?? []).map(name => `${name}\n`).join(''),
			GH_ASSETS_FAIL: fixture.rehAssets ? '0' : '1',
			...fixture.env,
		};
		for (const script of scripts) {
			const rendered = script.replace(EXPRESSION_PATTERN, (_match, expr: string) => fixture.substitute?.(expr) ?? `@${expr}@`);
			execFileSync('bash', ['-c', `${stubs}\n${rendered}`], { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
		}
		return fs.readFileSync(callLog, 'utf8').split('\n').filter(line => line.length > 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

/** Runs the publish job's two publishing steps for one channel/tag. */
function simulatePublishSteps(workflow: IReleaseWorkflow, channel: string, tag: string, fixture: IScriptFixture = {}): readonly string[] {
	const publish = workflow.jobs.publish;
	return runStepScripts(
		[getStep(publish, 'Publish artifacts to R2 + update feed KV').run!, getStep(publish, 'Create GitHub Release with artifacts').run!],
		{ ...fixture, env: { CHANNEL: channel, GITHUB_REF: `refs/tags/${tag}`, ...fixture.env } },
	);
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

	// The stable expectation spells out the exact R2 keys, KV keys/values and Release calls. They are
	// what the workflow produced before channels existed (hard-coded `stable/...`, `stable:*`,
	// `changelog:stable`, `gh release create --generate-notes`) with one deliberate change: the stable
	// Release now passes `--notes-start-tag <previous stable tag>` (found through `gh release list`), so
	// its generated notes never start from a beta tag. Any other drift on the stable path fails here.
	test('publishes stable as before and keeps beta under beta/ and beta:* only', () => {
		const workflow = readReleaseWorkflow();
		const r2 = (channel: string, platdir: string, file: string, artifact: string) =>
			`aws s3 cp artifacts/${artifact}/${file} s3://@secrets.CF_R2_BUCKET@/${channel}/${platdir}/@steps.meta.outputs.commit@/${file} --endpoint-url https://account.r2.cloudflarestorage.com --no-progress`;
		const kv = (channel: string, platform: string, platdir: string, file: string) =>
			`wrangler kv key put --namespace-id @secrets.CF_KV_NAMESPACE_ID@ --remote ${channel}:${platform} {"commit":"@steps.meta.outputs.commit@","version":"@steps.meta.outputs.version@","productVersion":"@steps.meta.outputs.version@","url":"@secrets.CF_R2_PUBLIC_BASE_URL@/${channel}/${platdir}/@steps.meta.outputs.commit@/${file}","sha256hash":"hash-${file}","timestamp":@steps.meta.outputs.timestamp@}`;
		const feed = (channel: string, platform: string, platdir: string, file: string, artifact: string) => [r2(channel, platdir, file, artifact), kv(channel, platform, platdir, file)];
		const changelog = (channel: string) => `wrangler kv key put --namespace-id @secrets.CF_KV_NAMESPACE_ID@ --remote --path src/vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md changelog:${channel}`;
		const setup = 'aws configure set default.s3.multipart_threshold 1GB';
		const upload = (tag: string, files: readonly string[]) => `gh release upload ${tag} --repo owner/repo --clobber ${files.map(file => `release-assets/ParaCode-${tag}-${file}`).join(' ')}`;
		const listReleases = 'gh release list --repo owner/repo --exclude-drafts --exclude-pre-releases --limit 100 --json tagName --jq .[].tagName';
		const releaseList = ['v1.139.1-paracode-147', 'reh', 'v1.139.1-paracode-146-beta.2', 'v1.135.0-paracode-145', 'v1.135.0-paracode-144'];

		const stableTag = 'v1.139.1-paracode-146';
		const stableFeed = [
			setup,
			...feed('stable', 'darwin', 'darwin-x64', 'darwin-x64.zip', 'darwin-x64'),
			...feed('stable', 'darwin-arm64', 'darwin-arm64', 'darwin-arm64.zip', 'darwin-arm64'),
			...feed('stable', 'win32-x64-user', 'win32-x64-user', 'win32-x64-user-setup.exe', 'win32-x64'),
			...feed('stable', 'win32-arm64-user', 'win32-arm64-user', 'win32-arm64-user-setup.exe', 'win32-arm64'),
			...feed('stable', 'linux-x64', 'linux-x64', 'linux-x64.deb', 'linux-x64'),
			changelog('stable'),
		];
		const stableAssets = ['SHA256SUMS.txt', 'darwin-arm64.zip', 'darwin-x64.zip', 'linux-x64.deb', 'win32-arm64-setup.exe', 'win32-x64-setup.exe'];
		const betaTag = 'v1.139.1-paracode-146-beta.1';
		const betaFeed = [
			setup,
			...feed('beta', 'darwin', 'darwin-x64', 'darwin-x64.zip', 'darwin-x64'),
			...feed('beta', 'darwin-arm64', 'darwin-arm64', 'darwin-arm64.zip', 'darwin-arm64'),
			changelog('beta'),
		];
		const betaAssets = ['SHA256SUMS.txt', 'darwin-arm64.zip', 'darwin-x64.zip'];

		assert.deepStrictEqual({
			stableNew: simulatePublishSteps(workflow, 'stable', stableTag, { releaseList }),
			stableFirstEver: simulatePublishSteps(workflow, 'stable', stableTag, { releaseList: ['reh'] }).filter(line => line.startsWith('gh release create')),
			stableExisting: simulatePublishSteps(workflow, 'stable', stableTag, { releaseExists: true, releaseList }),
			betaNew: simulatePublishSteps(workflow, 'beta', betaTag, { releaseList }),
			betaExisting: simulatePublishSteps(workflow, 'beta', betaTag, { releaseExists: true, releaseList }),
		}, {
			stableNew: [
				...stableFeed,
				`gh release view ${stableTag} --repo owner/repo`,
				listReleases,
				`gh release create ${stableTag} --repo owner/repo --title ${stableTag} --generate-notes --notes-start-tag v1.135.0-paracode-145`,
				upload(stableTag, stableAssets),
			],
			stableFirstEver: [`gh release create ${stableTag} --repo owner/repo --title ${stableTag} --generate-notes`],
			stableExisting: [
				...stableFeed,
				`gh release view ${stableTag} --repo owner/repo`,
				upload(stableTag, stableAssets),
			],
			betaNew: [
				...betaFeed,
				`gh release view ${betaTag} --repo owner/repo`,
				`gh release create ${betaTag} --repo owner/repo --title ${betaTag} --generate-notes --prerelease --latest=false`,
				upload(betaTag, betaAssets),
			],
			betaExisting: [
				...betaFeed,
				`gh release view ${betaTag} --repo owner/repo`,
				`gh release edit ${betaTag} --repo owner/repo --prerelease --latest=false`,
				upload(betaTag, betaAssets),
			],
		});

		assert.throws(() => simulatePublishSteps(workflow, '', stableTag));
	});

	// Feeds the real classifier's outputs through the workflow's own `outputs:`, `if:` and `env:`
	// expressions, so the wiring from classify to PARA_UPDATE_CHANNEL / CHANNEL is what is tested,
	// not a copy of it.
	test('routes the classify plan through the release workflow jobs', () => {
		const workflow = readReleaseWorkflow();
		const classify = workflow.jobs.classify;
		const buildJobs = ['build-darwin', 'build-win32', 'build-linux'] as const;
		assert.deepStrictEqual({
			classifyRun: getStep(classify, 'Classify the ref'),
			outputs: classify.outputs,
			needs: Object.fromEntries([...buildJobs, 'publish'].map(job => [job, workflow.jobs[job].needs])),
			isBetaEnv: workflow.jobs['build-darwin'].env?.PARA_RELEASE_IS_BETA,
			publishChannelEnv: workflow.jobs.publish.env?.CHANNEL,
		}, {
			classifyRun: { name: 'Classify the ref', id: 'plan', env: { PARA_RELEASE_PLATFORMS: '${{ github.event.inputs.platforms }}' }, run: 'node build/lib/paradisReleaseChannel.ts' },
			outputs: Object.fromEntries(['kind', 'channel', 'is_beta', 'publish', 'build_darwin', 'build_win32', 'build_linux'].map(key => [key, `\${{ steps.plan.outputs.${key} }}`])),
			needs: { 'build-darwin': 'classify', 'build-win32': 'classify', 'build-linux': 'classify', publish: ['classify', 'build-darwin', 'build-win32', 'build-linux'] },
			isBetaEnv: '${{ needs.classify.outputs.is_beta }}',
			publishChannelEnv: '${{ needs.classify.outputs.channel }}',
		});

		const simulate = (planOutputs: Record<string, string>, buildResult: (job: string) => string = () => 'success', cancelled = false) => {
			const classifyOutputs = Object.fromEntries(Object.entries(classify.outputs ?? {}).map(([key, value]) => [key, String(evaluateValue(value, { steps: { plan: planOutputs } }))]));
			const needs: Record<string, { result: string; outputs?: Record<string, string> }> = { classify: { result: 'success', outputs: classifyOutputs } };
			const builds: Record<string, string | null> = {};
			for (const job of buildJobs) {
				const runs = evaluateCondition(workflow.jobs[job].if, { needs });
				needs[job] = { result: runs ? buildResult(job) : 'skipped' };
				builds[job] = runs ? String(evaluateValue(workflow.jobs[job].env?.PARA_UPDATE_CHANNEL, { needs })) : null;
			}
			const publishes = evaluateCondition(workflow.jobs.publish.if, { needs, cancelled });
			return { ...builds, publish: publishes ? String(evaluateValue(workflow.jobs.publish.env?.CHANNEL, { needs })) : null };
		};
		const plan = (ref: IParadisReleaseRef) => toParadisReleaseOutputs(planParadisRelease(ref));
		const stable = plan({ eventName: 'push', refType: 'tag', refName: 'v1.139.1-paracode-146', platforms: '' });
		const beta = plan({ eventName: 'push', refType: 'tag', refName: 'v1.139.1-paracode-146-beta.1', platforms: '' });
		const row = (darwin: string | null, win32: string | null, linux: string | null, publish: string | null) => ({ 'build-darwin': darwin, 'build-win32': win32, 'build-linux': linux, publish });

		assert.deepStrictEqual({
			stableTag: simulate(stable),
			stableWin32Failed: simulate(stable, job => job === 'build-win32' ? 'failure' : 'success'),
			stableCancelled: simulate(stable, undefined, true),
			betaTag: simulate(beta),
			betaDarwinFailed: simulate(beta, job => job === 'build-darwin' ? 'failure' : 'success'),
			branchDispatch: simulate(plan({ eventName: 'workflow_dispatch', refType: 'branch', refName: 'main', platforms: '' })),
			stableTagSubset: simulate(plan({ eventName: 'workflow_dispatch', refType: 'tag', refName: 'v1.139.1-paracode-146', platforms: 'darwin' })),
			emptyPlan: simulate({}),
		}, {
			stableTag: row('stable', 'stable', 'stable', 'stable'),
			stableWin32Failed: row('stable', 'stable', 'stable', null),
			stableCancelled: row('stable', 'stable', 'stable', null),
			betaTag: row('beta', null, null, 'beta'),
			betaDarwinFailed: row('beta', null, null, null),
			branchDispatch: row('stable', 'stable', 'stable', null),
			stableTagSubset: row('stable', null, null, null),
			emptyPlan: row(null, null, null, null),
		});

		// An empty plan is also a failed run, not a green one that published nothing.
		const guard = getStep(classify, 'Fail on an empty plan');
		const runGuard = (outputs: Record<string, string>) => runStepScripts([guard.run!], {
			env: Object.fromEntries(Object.entries(guard.env ?? {}).map(([key, value]) => [key, String(evaluateValue(value, { steps: { plan: outputs } }))])),
		});
		assert.throws(() => runGuard({}));
		assert.deepStrictEqual(runGuard(stable), []);
	});

	test('publishes REH only from release tags and never overwrites an existing asset for a beta', () => {
		const job = readRehWorkflow().jobs['build-reh-linux-x64'];
		const publishStep = getStep(job, 'Publish to reh release');
		const tarball = 'para-code-server-linux-x64-abc.tar.gz';
		const plan = (ref: IParadisReleaseRef) => toParadisReleaseOutputs(planParadisRelease(ref));
		const stable = plan({ eventName: 'push', refType: 'tag', refName: 'v1.139.1-paracode-146', platforms: '' });
		const beta = plan({ eventName: 'push', refType: 'tag', refName: 'v1.139.1-paracode-146-beta.1', platforms: '' });
		const branch = plan({ eventName: 'workflow_dispatch', refType: 'branch', refName: 'main', platforms: '' });
		const stepContext = (outputs: Record<string, string>, eventName: string, publishInput: boolean): IExpressionContext =>
			({ eventName, inputs: { publish: publishInput }, steps: { plan: outputs, pack: { tarball } } });
		const publish = (outputs: Record<string, string>, fixture: IScriptFixture) => {
			const context = stepContext(outputs, 'push', true);
			return runStepScripts([publishStep.run!], {
				...fixture,
				env: Object.fromEntries(Object.entries(publishStep.env ?? {}).map(([key, value]) => [key, String(evaluateValue(value, context))])),
				substitute: expression => { const value = evaluateExpression(expression, context); return typeof value === 'string' && value ? value : undefined; },
			});
		};
		const uploadCall = `gh release upload reh ${tarball} ${tarball}.sha256 --clobber`;
		const listCall = 'gh release view reh --json assets --jq .assets[].name';

		assert.deepStrictEqual({
			classifyRun: getStep(job, 'Classify the ref').run,
			runsOn: {
				stableTagPush: evaluateCondition(publishStep.if, stepContext(stable, 'push', true)),
				betaTagPush: evaluateCondition(publishStep.if, stepContext(beta, 'push', true)),
				tagDispatchPublishOff: evaluateCondition(publishStep.if, stepContext(stable, 'workflow_dispatch', false)),
				branchDispatch: evaluateCondition(publishStep.if, stepContext(branch, 'workflow_dispatch', true)),
				emptyPlan: evaluateCondition(publishStep.if, stepContext({}, 'push', true)),
			},
			stableExistingAsset: publish(stable, { releaseExists: true, rehAssets: [tarball] }),
			betaExistingAsset: publish(beta, { releaseExists: true, rehAssets: [tarball] }),
			betaNewAsset: publish(beta, { releaseExists: true, rehAssets: ['para-code-server-linux-x64-other.tar.gz'] }),
		}, {
			classifyRun: 'node build/lib/paradisReleaseChannel.ts',
			runsOn: { stableTagPush: true, betaTagPush: true, tagDispatchPublishOff: false, branchDispatch: false, emptyPlan: false },
			stableExistingAsset: ['gh release view reh', uploadCall],
			betaExistingAsset: ['gh release view reh', listCall],
			betaNewAsset: ['gh release view reh', listCall, uploadCall],
		});
		// If the asset list cannot be read, the beta run stops instead of uploading over it.
		assert.throws(() => publish(beta, { releaseExists: true }));
	});

	// The app reports the release stamped into product.json by the gulp packaging and the upload step
	// creates the release and uploads the source maps under its own name. Both must come from the same
	// function and inputs (build/lib/paradisReleaseChannel.ts), or every event loses its release.
	test('names the Sentry release of the app and of its uploaded source maps the same way', () => {
		const workflow = readReleaseWorkflow();
		const read = (file: string) => fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
		const overridesRef = (...envs: (Record<string, string> | undefined)[]) => envs.some(env => Object.keys(env ?? {}).some(key => key.startsWith('GITHUB_REF')));
		assert.deepStrictEqual({
			uploads: Object.fromEntries(['build-darwin', 'build-win32', 'build-linux'].map(name => {
				const job = workflow.jobs[name];
				const step = getStep(job, 'Upload desktop source maps to Sentry');
				return [name, { script: step.run?.split(' ').slice(0, 2).join(' '), overridesRef: overridesRef(workflow.env, job.env, step.env) }];
			})),
			gulpStamp: read('build/gulpfile.vscode.ts').includes('json.paradisSentryRelease = getParadisSentryReleaseFromEnv(packageJson.version, commit);'),
			uploadRelease: read('build/sentry/upload-desktop-sourcemaps.ts').includes('const release = getParadisSentryReleaseFromEnv(packageJson.version, process.env.GITHUB_SHA);'),
		}, {
			uploads: Object.fromEntries(['build-darwin', 'build-win32', 'build-linux'].map(name => [name, { script: 'node build/sentry/upload-desktop-sourcemaps.ts', overridesRef: false }])),
			gulpStamp: true,
			uploadRelease: true,
		});
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
