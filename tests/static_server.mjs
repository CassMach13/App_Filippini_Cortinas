import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = normalize(join(process.cwd(), process.argv[2] || '.'));
const port = Number(process.env.TEST_PORT || 4178);
const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png'
};

createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
        const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const filePath = normalize(join(root, relativePath));
        if (!filePath.startsWith(root)) {
            response.writeHead(403).end('Forbidden');
            return;
        }

        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) throw new Error('Not a file');
        response.writeHead(200, { 'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream' });
        createReadStream(filePath).pipe(response);
    } catch {
        response.writeHead(404).end('Not found');
    }
}).listen(port, '127.0.0.1', () => {
    console.log(`Test server listening on http://127.0.0.1:${port}`);
});
