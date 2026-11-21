// KING yt-dlp worker: no dependencies, Node 18+
// Env: PORT, WORKER_KEY (required), YTDLP_PATH, COOKIES (path to cookies.txt), PROXY, MAX_JOBS
const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const KEY = process.env.WORKER_KEY;
const BIN = process.env.YTDLP_PATH || './yt-dlp';
const COOKIES = process.env.COOKIES || '';
const PROXY = process.env.PROXY || '';
const MAX_JOBS = +(process.env.MAX_JOBS || 3);
const TIMEOUT_MS = 5 * 60 * 1000;
// YouTube mode retries: tried in order until one works
const YT_CLIENTS = ['default', 'tv', 'web_safari', 'android'];

if (!KEY) { console.error('Set WORKER_KEY first.'); process.exit(1); }
let jobs = 0;

function baseArgs(client) {
  const a = ['--no-playlist', '--no-warnings', '--socket-timeout', '20'];
  if (COOKIES) a.push('--cookies', COOKIES);
  if (PROXY) a.push('--proxy', PROXY);
  if (client && client !== 'default') a.push('--extractor-args', 'youtube:player_client=' + client);
  return a;
}

function formatFor(type, q) {
  const h = Math.min(+q || 720, 1080);
  // Pre-merged formats, so ffmpeg is not required
  return type === 'audio'
    ? 'bestaudio[ext=m4a]/bestaudio'
    : `best[ext=mp4][height<=${h}]/best[height<=${h}]/best`;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(BIN, args);
    let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), 60000);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', c => { clearTimeout(t); c === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || 'yt-dlp failed')); });
    p.on('error', reject);
  });
}

async function info(url) {
  let last;
  for (const c of YT_CLIENTS) {
    try {
      const j = JSON.parse(await run([...baseArgs(c), '-J', '--', url]));
      return { title: j.title, duration: j.duration, thumbnail: j.thumbnail, uploader: j.uploader, site: j.extractor_key, client: c };
    } catch (e) { last = e; if (!/youtube/i.test(url)) break; }
  }
  throw last;
}

// Streams the file; retries the next client only if nothing was sent yet
function download(url, type, q, res, i = 0) {
  const client = YT_CLIENTS[i];
  const p = spawn(BIN, [...baseArgs(client), '-f', formatFor(type, q), '-o', '-', '--', url]);
  let started = false, err = '';
  const t = setTimeout(() => p.kill('SIGKILL'), TIMEOUT_MS);
  p.stderr.on('data', d => err += d);
  p.stdout.once('data', () => {
    started = true;
    res.writeHead(200, { 'Content-Type': type === 'audio' ? 'audio/mp4' : 'video/mp4', 'X-Client': client });
  });
  p.stdout.on('data', d => res.write(d));
  p.on('close', code => {
    clearTimeout(t);
    if (started) return res.end();
    if (code !== 0 && /youtube/i.test(url) && i + 1 < YT_CLIENTS.length) return download(url, type, q, res, i + 1);
    jobs--;
    send(res, 502, { error: err.trim().split('\n').pop() || 'download failed' });
  });
  p.on('close', () => { if (started) jobs--; });
  res.on('close', () => p.kill('SIGKILL'));
}

function send(res, code, obj) {
  if (res.headersSent) return res.end();
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const fs = require('fs');
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.headers['x-worker-key'] !== KEY) return send(res, 401, { error: 'unauthorized' });
  if (u.pathname === '/health') {
    try { return send(res, 200, { ok: true, ytdlp: (await run(['--version'])).trim(), jobs }); }
    catch (e) { return send(res, 500, { ok: false, error: e.message }); }
  }
  const url = u.searchParams.get('url') || '';
  if (!/^(https?:\/\/|scsearch1:)/i.test(url)) return send(res, 400, { error: 'valid http(s) url or scsearch1: query required' });
  if (u.pathname === '/info') {
    try { return send(res, 200, await info(url)); } catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (u.pathname === '/download') {
    if (jobs >= MAX_JOBS) return send(res, 429, { error: 'worker busy, retry shortly' });
    jobs++;
    return download(url, u.searchParams.get('type') === 'audio' ? 'audio' : 'video', u.searchParams.get('quality'), res);
  }
  send(res, 404, { error: 'not found' });
});

// Downloads the yt-dlp Linux binary on first run, then tries a self-update
async function ensureBinary() {
  if (!fs.existsSync(BIN)) {
    console.log('downloading yt-dlp...');
    const r = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux');
    if (!r.ok) throw new Error('yt-dlp download failed: ' + r.status);
    fs.writeFileSync(BIN, Buffer.from(await r.arrayBuffer()), { mode: 0o755 });
  }
  run(['-U']).catch(() => {});
}

// Standalone: node server.js (uses PORT).
// Embedded in your API: require('./server').start(3001, '127.0.0.1')
async function start(port = PORT, host = '0.0.0.0') {
  await ensureBinary();
  return new Promise(ok => server.listen(port, host, () => { console.log('worker on ' + host + ':' + port); ok(server); }));
}
module.exports = { start };
if (require.main === module) start();
