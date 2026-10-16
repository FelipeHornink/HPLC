// Local authenticated bridge. All actions stay inside the VS Code command flow.
const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

async function startAgentControl(directory, dispatch, actions = ['status', 'play', 'stop']) {
  const token = crypto.randomBytes(32).toString('hex');
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hplc-'));
  fs.chmodSync(privateDir, 0o700);
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\hplc-${crypto.randomBytes(12).toString('hex')}`
    : path.join(privateDir, 'control.sock');
  let busy = false;
  const server = net.createServer(socket => {
    let buffer = '';
    socket.setTimeout(10000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', async chunk => {
      buffer += chunk.toString();
      if (buffer.length > 16384) return socket.destroy();
      if (!buffer.includes('\n')) return;
      socket.removeAllListeners('data');
      const reply = value => socket.end(JSON.stringify(value) + '\n');
      let acquired = false;
      try {
        const request = JSON.parse(buffer.split('\n')[0]);
        if (request.token !== token) throw new Error('Invalid token');
        if (!actions.includes(request.action)) throw new Error('Unsupported action');
        if (busy) throw new Error('Another control request is running');
        busy = acquired = true;
        socket.setTimeout(0);
        const result = await dispatch(request.action, request.project);
        reply({ ok: true, result });
      } catch (error) { reply({ ok: false, error: error.message }); }
      finally { if (acquired) busy = false; }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });
    fs.mkdirSync(directory, { recursive: true });
    const descriptor = path.join(directory, `agent-control-${process.pid}.json`);
    fs.writeFileSync(descriptor, JSON.stringify({ endpoint, token }), { mode: 0o600 });
    return { descriptor, dispose() {
      server.close();
      fs.rmSync(descriptor, { force: true });
      fs.rmSync(privateDir, { recursive: true, force: true });
    } };
  } catch (error) {
    server.close();
    fs.rmSync(privateDir, { recursive: true, force: true });
    throw error;
  }
}
module.exports = { startAgentControl };
