import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import handler, { PIXEL_GIF, sanitizeToken } from '../api/track-open.js';

const originalFetch = globalThis.fetch;

function mockAnalytics(impl) {
  globalThis.fetch = (url, init) => {
    const href = String(url);
    if (href.startsWith('https://www.google-analytics.com/')) return impl(href, init);
    return originalFetch(url, init);
  };
}

function captureLogs() {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(' '));
  };
  return {
    lines,
    restore() { console.log = orig; },
    opens() {
      return lines
        .filter((line) => line.startsWith('EMAIL_OPEN '))
        .map((line) => JSON.parse(line.slice('EMAIL_OPEN '.length)));
    },
  };
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    req.query = Object.fromEntries(url.searchParams.entries());
    return handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

test('sanitizeToken keeps campaign and shop slugs and drops emails', () => {
  assert.equal(sanitizeToken('wave19'), 'wave19');
  assert.equal(sanitizeToken('Anjoe'), 'anjoe');
  assert.equal(sanitizeToken(' shop-name '), 'shop-name');
  assert.equal(sanitizeToken('person@example.com'), null);
  assert.equal(sanitizeToken('wave 19'), null);
  assert.equal(sanitizeToken(''), null);
  assert.equal(sanitizeToken(undefined), null);
});

test('GET returns a 1x1 GIF and a second GET is a separate open', async () => {
  const analytics = [];
  mockAnalytics((url) => {
    analytics.push(url);
    return Promise.resolve({ ok: true, status: 204 });
  });
  const logs = captureLogs();
  const server = await startServer();
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/t/o.gif?c=wave19&s=anjoe&email=person@example.com`;

  try {
    const first = await fetch(url);
    const second = await fetch(url);
    const firstBody = Buffer.from(await first.arrayBuffer());
    const secondBody = Buffer.from(await second.arrayBuffer());

    for (const res of [first, second]) {
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/gif');
      assert.match(res.headers.get('cache-control'), /no-store/);
      assert.equal(res.headers.get('location'), null);
      assert.equal(res.redirected, false);
    }

    assert.ok(firstBody.equals(PIXEL_GIF));
    assert.ok(secondBody.equals(PIXEL_GIF));
    assert.equal(firstBody.subarray(0, 6).toString('ascii'), 'GIF89a');
    assert.equal(firstBody.readUInt16LE(6), 1);
    assert.equal(firstBody.readUInt16LE(8), 1);

    const opens = logs.opens().filter((entry) => entry.shop === 'anjoe');
    assert.equal(opens.length, 2);
    assert.equal(opens[0].campaign, 'wave19');
    assert.equal(opens[1].campaign, 'wave19');
    assert.equal(opens[0].event, 'email_open');
    assert.notEqual(opens[0].id, opens[1].id);

    const logged = logs.lines.join('\n');
    assert.equal(logged.includes('person@example.com'), false);
    assert.equal(analytics.length, 2);
    for (const hit of analytics) {
      const parsed = new URL(hit);
      assert.equal(parsed.searchParams.get('tid'), 'G-VYB6HSZS5M');
      assert.equal(parsed.searchParams.get('en'), 'email_open');
      assert.equal(parsed.searchParams.get('ep.campaign'), 'wave19');
      assert.equal(parsed.searchParams.get('ep.shop_slug'), 'anjoe');
      assert.equal(hit.includes('person@example.com'), false);
    }
  } finally {
    logs.restore();
    globalThis.fetch = originalFetch;
    await closeServer(server);
  }
});

test('image response is not blocked on analytics', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  mockAnalytics(() => gate);
  const logs = captureLogs();
  const server = await startServer();
  const { port } = server.address();

  try {
    const result = await Promise.race([
      fetch(`http://127.0.0.1:${port}/t/o.gif?c=wave19&s=anjoe`).then(async (res) => ({
        kind: 'image',
        status: res.status,
        type: res.headers.get('content-type'),
        body: Buffer.from(await res.arrayBuffer()),
      })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 400)),
    ]);

    assert.equal(result.kind, 'image');
    assert.equal(result.status, 200);
    assert.equal(result.type, 'image/gif');
    assert.ok(result.body.equals(PIXEL_GIF));
    assert.equal(logs.opens().length, 1);
  } finally {
    release({ ok: true, status: 204 });
    logs.restore();
    globalThis.fetch = originalFetch;
    await closeServer(server);
  }
});

test('HEAD does not count as an open and other methods are rejected', async () => {
  mockAnalytics(() => Promise.resolve({ ok: true, status: 204 }));
  const logs = captureLogs();
  const server = await startServer();
  const { port } = server.address();

  try {
    const head = await fetch(`http://127.0.0.1:${port}/t/o.gif?c=wave19&s=anjoe`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'image/gif');
    assert.equal(Buffer.from(await head.arrayBuffer()).length, 0);

    const post = await fetch(`http://127.0.0.1:${port}/t/o.gif?c=wave19&s=anjoe`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(logs.opens().length, 0);
  } finally {
    logs.restore();
    globalThis.fetch = originalFetch;
    await closeServer(server);
  }
});
