const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 18767);

http.createServer((req, res) => {
    const pathname = decodeURIComponent(req.url.split('?')[0]);
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
    }
    fs.readFile(file, (error, data) => {
        if (error) {
            res.writeHead(404);
            res.end('not found');
            return;
        }
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(data);
    });
}).listen(port, '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${port}/tests/regression.html?case=history-first`);
});
