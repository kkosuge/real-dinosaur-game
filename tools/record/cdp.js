/* Headless Chrome over the DevTools protocol + a throwaway static server, for the video recorder. Node 22, no deps
 * (global WebSocket / fetch).
 *
 *   var cdp = require('./cdp');
 *   await cdp.withSession({ width: 1920, height: 1080, workDir }, async function (s) {
 *     await s.goto(s.url('index.html?seed=1&freeze=1'));
 *     var v = await s.eval('__rdg.sim.tick');
 *     await s.screenshot('/path/out.png');
 *   });
 *
 * withSession always closes Chrome (Browser.close, then SIGKILL of its pid) and stops the server, even on errors:
 * headless Chrome with its own --user-data-dir does not exit by itself. The server is python3 -m http.server on a
 * random free port in 9100-9999, bound to 127.0.0.1 (never 8765). */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var net = require('net');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..', '..');
var CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function portFree(port) {
  return new Promise(function (res) {
    var srv = net.createServer();
    srv.once('error', function () { res(false); });
    srv.listen(port, '127.0.0.1', function () { srv.close(function () { res(true); }); });
  });
}

async function startServer(root) {
  for (var tries = 0; tries < 50; tries++) {
    var port = 9100 + Math.floor(Math.random() * 900);
    if (port === 8765 || !(await portFree(port))) continue;
    var proc = cp.spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', root || ROOT], { stdio: 'ignore' });
    for (var i = 0; i < 100; i++) {
      await sleep(50);
      if (proc.exitCode != null) break;
      try { var r = await fetch('http://127.0.0.1:' + port + '/index.html'); if (r.ok) return { port: port, proc: proc, base: 'http://127.0.0.1:' + port + '/' }; } catch (e) { /* not up yet */ }
    }
    try { proc.kill('SIGKILL'); } catch (e) { /* gone */ }
  }
  throw new Error('could not start the static server');
}

/** Minimal CDP client on one browser websocket (flattened sessions). */
function Client(ws) {
  var self = this;
  this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
  ws.addEventListener('message', function (m) {
    var msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8'));
    if (msg.id != null && self.pending.has(msg.id)) {
      var p = self.pending.get(msg.id);
      self.pending.delete(msg.id);
      if (msg.error) p.rej(new Error(p.method + ': ' + msg.error.message + (msg.error.data ? ' ' + msg.error.data : '')));
      else p.res(msg.result);
    } else if (msg.method) {
      self.listeners.forEach(function (l) { if (l.method === msg.method && (!l.sessionId || l.sessionId === msg.sessionId)) l.fn(msg.params, msg); });
    }
  });
  ws.addEventListener('close', function () {
    self.pending.forEach(function (p) { p.rej(new Error('websocket closed (' + p.method + ')')); });
    self.pending.clear();
  });
}
Client.prototype.send = function (method, params, sessionId) {
  var self = this, id = ++this.id;
  var msg = { id: id, method: method, params: params || {} };
  if (sessionId) msg.sessionId = sessionId;
  return new Promise(function (res, rej) {
    self.pending.set(id, { res: res, rej: rej, method: method });
    self.ws.send(JSON.stringify(msg));
  });
};
Client.prototype.on = function (method, fn, sessionId) { this.listeners.push({ method: method, fn: fn, sessionId: sessionId }); };

async function launchChrome(opts) {
  var width = opts.width || 1920, height = opts.height || 1080;
  var work = opts.workDir || os.tmpdir();
  fs.mkdirSync(work, { recursive: true });
  var profile = fs.mkdtempSync(path.join(work, 'chrome-profile-'));
  var args = [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--window-size=' + width + ',' + height, '--hide-scrollbars', '--force-device-scale-factor=1',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-sync', '--mute-audio', '--autoplay-policy=no-user-gesture-required', 'about:blank'
  ];
  var proc = cp.spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  var stderr = '';
  proc.stderr.on('data', function (d) { stderr = (stderr + d).slice(-4000); });
  var portFile = path.join(profile, 'DevToolsActivePort'), lines = null;
  for (var i = 0; i < 200 && !lines; i++) {
    await sleep(50);
    if (proc.exitCode != null) throw new Error('chrome exited: ' + stderr);
    try { var t = fs.readFileSync(portFile, 'utf8').trim().split('\n'); if (t.length >= 2) lines = t; } catch (e) { /* not yet */ }
  }
  var chrome = { proc: proc, profile: profile, client: null };
  // last resort (an uncaught error / exit before closeChrome): never leave this Chrome behind
  chrome.onExit = function () { if (proc.exitCode == null && proc.signalCode == null) { try { proc.kill('SIGKILL'); } catch (e) { /* gone */ } } };
  process.on('exit', chrome.onExit);
  if (!lines) { await closeChrome(chrome); throw new Error('no DevToolsActivePort: ' + stderr); }
  var ws = new WebSocket('ws://127.0.0.1:' + lines[0] + lines[1]);
  await new Promise(function (res, rej) { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', function (e) { rej(new Error('ws error ' + (e && e.message))); }, { once: true }); });
  chrome.client = new Client(ws);
  return chrome;
}

async function closeChrome(chrome) {
  if (!chrome) return;
  try {
    if (chrome.client) {
      await Promise.race([chrome.client.send('Browser.close').catch(function () {}), sleep(2000)]);
      try { chrome.client.ws.close(); } catch (e) { /* closed */ }
    }
  } finally {
    for (var i = 0; i < 40 && chrome.proc.exitCode == null && chrome.proc.signalCode == null; i++) await sleep(50);
    if (chrome.proc.exitCode == null && chrome.proc.signalCode == null) { try { chrome.proc.kill('SIGKILL'); } catch (e) { /* gone */ } }
    for (var j = 0; j < 40 && chrome.proc.exitCode == null && chrome.proc.signalCode == null; j++) await sleep(50);
    try { fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    if (chrome.onExit) process.removeListener('exit', chrome.onExit);
  }
}

/** A page session: goto(url), eval(expr), screenshot(file | null -> Buffer), plus the raw send(). */
async function openPage(chrome, width, height) {
  var c = chrome.client;
  var t = await c.send('Target.createTarget', { url: 'about:blank' });
  var a = await c.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  var sid = a.sessionId;
  var s = {
    client: c, sessionId: sid, targetId: t.targetId,
    send: function (m, p) { return c.send(m, p, sid); },
    on: function (m, fn) { c.on(m, fn, sid); }
  };
  s.logs = [];
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  s.on('Runtime.consoleAPICalled', function (p) { s.logs.push(p.type + ': ' + p.args.map(function (x) { return x.value != null ? x.value : x.description; }).join(' ')); });
  s.on('Runtime.exceptionThrown', function (p) { s.logs.push('exception: ' + (p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text)); });
  await s.send('Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 1, mobile: false });
  s.goto = async function (url, readyExpr, timeoutMs) {
    var loaded = new Promise(function (res) { s.on('Page.loadEventFired', res); });
    await s.send('Page.navigate', { url: url });
    await Promise.race([loaded, sleep(15000)]);
    if (readyExpr) {
      var t0 = Date.now();
      for (;;) {
        var ok = await s.eval(readyExpr).catch(function () { return false; });
        if (ok) break;
        if (Date.now() - t0 > (timeoutMs || 30000)) throw new Error('page not ready: ' + readyExpr + '\n' + s.logs.join('\n'));
        await sleep(100);
      }
    }
  };
  s.eval = async function (expr) {
    var r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    return r.result.value;
  };
  // fast: optimizeForSpeed (a quicker, larger PNG; still lossless). The capture always shows the latest DOM / canvas
  // state (checked: a shot right after __rdg.step() equals one taken two animation frames later).
  s.screenshot = async function (file, format, fast) {
    var r = await s.send('Page.captureScreenshot', { format: format || 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: !!fast });
    var buf = Buffer.from(r.data, 'base64');
    if (file) fs.writeFileSync(file, buf);
    return buf;
  };
  return s;
}

/** Server + Chrome + one page; always cleaned up. fn(session) gets session.url(rel) for the served project. */
async function withSession(opts, fn) {
  opts = opts || {};
  var server = null, chrome = null;
  var killServer = function () { if (server) { try { server.proc.kill('SIGKILL'); } catch (e) { /* gone */ } } };
  process.on('exit', killServer);
  try {
    server = await startServer(opts.root || ROOT);
    chrome = await launchChrome(opts);
    var s = await openPage(chrome, opts.width || 1920, opts.height || 1080);
    s.url = function (rel) { return server.base + rel; };
    return await fn(s);
  } finally {
    await closeChrome(chrome);
    killServer();
    process.removeListener('exit', killServer);
  }
}

module.exports = { ROOT: ROOT, startServer: startServer, launchChrome: launchChrome, closeChrome: closeChrome, openPage: openPage, withSession: withSession, sleep: sleep };
