const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { startAgentControl } = require('../agent-control');

test('authenticated local control rejects unauthorized actions and cleans up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-control-test-'));
  const calls = [];
  const bridge = await startAgentControl(dir, async (...args) => { calls.push(args); return 'done'; });
  const { endpoint, token } = JSON.parse(fs.readFileSync(bridge.descriptor));
  const request = data => new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let response = '';
    socket.on('connect', () => socket.write(JSON.stringify(data) + '\n'));
    socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => resolve(JSON.parse(response)));
    socket.on('error', reject);
  });
  try {
    assert.equal((await request({ token: 'wrong', action: 'play' })).ok, false);
    assert.equal((await request({ token, action: 'shell' })).ok, false);
    assert.equal(calls.length, 0);
    assert.deepEqual(await request({ token, action: 'play', project: '/example' }), { ok: true, result: 'done' });
    assert.deepEqual(calls, [['play', '/example']]);
    if (process.platform !== 'win32') assert.equal(fs.statSync(bridge.descriptor).mode & 0o777, 0o600);
  } finally { bridge.dispose(); }
  assert.equal(fs.existsSync(bridge.descriptor), false);
  fs.rmSync(dir, { recursive: true });
});
