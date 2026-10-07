import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { DaemonClient } from '../completion/DaemonClient';

describe('daemon worktree protocol', () => {
    it('preserves canonical edit identity and keys snapshots by checkout', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blamely-daemon-test-'));
        const previous = process.env.BLAMELY_HOME;
        const requests: { url?: string; body: any }[] = [];
        const server = http.createServer((req, res) => {
            let data = '';
            req.on('data', chunk => { data += chunk; });
            req.on('end', () => {
                requests.push({ url: req.url, body: JSON.parse(data) });
                res.writeHead(204).end();
            });
        });
        try {
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            fs.writeFileSync(path.join(home, 'daemon.port'), String((server.address() as { port: number }).port));
            process.env.BLAMELY_HOME = home;
            const daemon = new DaemonClient();
            assert.equal(await daemon.send({ tool: 'copilot', repo_path: '/main', worktree_path: '/linked',
                file_path: 'file.txt', lines: [{ start: 1, end: 1 }] }), true);
            await daemon.putSnapshot('/main', 'file.txt', 'main baseline');
            await daemon.putSnapshot('/linked', 'file.txt', 'linked baseline');
            assert.equal(requests[0].body.repo_path, '/main');
            assert.equal(requests[0].body.worktree_path, '/linked');
            assert.deepEqual(requests.slice(1).map(r => r.body), [
                { repo: '/main', file: 'file.txt', content: 'main baseline' },
                { repo: '/linked', file: 'file.txt', content: 'linked baseline' },
            ]);
        } finally {
            if (previous === undefined) delete process.env.BLAMELY_HOME;
            else process.env.BLAMELY_HOME = previous;
            await new Promise<void>(resolve => server.close(() => resolve()));
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});
