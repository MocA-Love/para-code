import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const file = join(root, 'agent-ui-catalog.html');
const portFlag = process.argv.indexOf('--port');
const requestedPort = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 4179;
const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65_536 ? requestedPort : 4179;

const server = createServer(async (request, response) => {
	if (request.method !== 'GET') {
		response.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
		response.end('Method Not Allowed');
		return;
	}
	const url = new URL(request.url ?? '/', 'http://localhost');
	if (url.pathname !== '/' && url.pathname !== '/agent-ui-catalog.html') {
		response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
		response.end('Not Found');
		return;
	}
	try {
		const metadata = await stat(file);
		response.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Length': metadata.size,
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
		});
		createReadStream(file).pipe(response);
	} catch {
		response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
		response.end('UI catalog is unavailable');
	}
});

server.listen(port, '127.0.0.1', () => {
	process.stdout.write(`Paracode Mobile Agent UI Catalog: http://127.0.0.1:${port}\n`);
});
