#!/usr/bin/env node
// Usage: node scripts/plc-control.js <descriptor.json> status|play|stop|views [absolute-project]
const fs = require('fs');
const net = require('net');
const [descriptor, action, project] = process.argv.slice(2);
if (!descriptor || !['status', 'play', 'stop', 'views'].includes(action) || (action !== 'status' && !project)) {
  console.error('Usage: plc-control.js <descriptor.json> status|play|stop|views [absolute-project]');
  process.exit(2);
}
const { endpoint, token } = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
const socket = net.createConnection(endpoint);
socket.setTimeout(300000, () => socket.destroy(new Error('Control request timed out')));
let response = '';
socket.on('connect', () => socket.write(JSON.stringify({ token, action, project }) + '\n'));
socket.on('data', data => { response += data; });
socket.on('end', () => {
  try {
    const result = JSON.parse(response);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
});
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
