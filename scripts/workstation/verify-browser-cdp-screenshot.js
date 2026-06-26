#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_VIEWPORT = { width: 900, height: 600 };
const TARGETS = {
  "brave-origin-nightly": ["brave-origin-nightly"],
  brave: ["brave-browser", "brave"],
  chrome: ["google-chrome", "google-chrome-stable", "chrome"],
  chromium: ["chromium", "chromium-browser"],
};
const DEFAULT_TARGET_ORDER = [
  "brave-origin-nightly",
  "brave",
  "chrome",
  "chromium",
];
const DEFAULT_TEST_HTML = [
  "<!doctype html>",
  "<meta charset=\"utf-8\">",
  "<title>Codex browser-control CDP screenshot probe</title>",
  "<style>",
  "body{margin:0;display:grid;place-items:center;min-height:100vh;background:#101827;color:#f8fafc;font:24px sans-serif}",
  "main{border:2px solid #38bdf8;border-radius:12px;padding:32px;background:#1e293b}",
  "</style>",
  "<main>Codex browser-control CDP screenshot probe</main>",
].join("");

function usage() {
  return `Usage: verify-browser-cdp-screenshot.js [options]

Options:
  --browser <path|command>       Browser executable to launch.
  --target <id>                  Browser target: ${Object.keys(TARGETS).join(", ")}.
  --cdp-url <url>                Attach to an existing CDP endpoint instead of launching.
  --cdp-port <port>              CDP port for launched browser (default: free port).
  --url <url>                    Page URL to capture (default: built-in data URL).
  --screenshot <path>            Output PNG path (default: temp file).
  --timeout-ms <ms>              Probe timeout (default: ${DEFAULT_TIMEOUT_MS}).
  --headed                       Do not pass --headless=new to the launched browser.
  --keep-profile                 Keep the temporary browser profile.
  --json                         Print machine-readable JSON.
  --help                         Show this help.

Environment:
  CODEX_BROWSER_CONTROL_EXECUTABLE  Browser executable override for this probe.
  CODEX_BROWSER_CONTROL_TARGET      Browser target id for this probe.
  CODEX_CHROME_EXECUTABLE           Existing Codex Chrome opener override.
`;
}

function parseArgs(argv) {
  const options = {
    browser: null,
    target: null,
    cdpUrl: null,
    cdpPort: null,
    targetUrl: defaultTargetUrl(),
    screenshotPath: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    headless: true,
    keepProfile: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inlineValue] = arg.split("=", 2);
    const nextValue = () => {
      if (inlineValue != null) return inlineValue;
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[index];
    };

    switch (name) {
      case "--browser":
        options.browser = nextValue();
        break;
      case "--target":
      case "--browser-target":
        options.target = nextValue();
        break;
      case "--cdp-url":
        options.cdpUrl = nextValue();
        break;
      case "--cdp-port":
        options.cdpPort = Number(nextValue());
        if (!Number.isInteger(options.cdpPort) || options.cdpPort <= 0) {
          throw new Error("--cdp-port must be a positive integer");
        }
        break;
      case "--url":
        options.targetUrl = nextValue();
        break;
      case "--screenshot":
        options.screenshotPath = nextValue();
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(nextValue());
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
          throw new Error("--timeout-ms must be a positive number");
        }
        break;
      case "--headed":
        options.headless = false;
        break;
      case "--keep-profile":
        options.keepProfile = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function defaultTargetUrl() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(DEFAULT_TEST_HTML)}`;
}

function commandExists(command, env = process.env) {
  return resolveExecutable(command, env) != null;
}

function resolveExecutable(command, env = process.env) {
  if (!command || command.trim().length === 0) return null;
  if (command.includes(path.sep)) {
    return isExecutable(command) ? command : null;
  }
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

const defaultBrowserCommandRunner = {
  resolveExecutable: (command, env) => resolveExecutable(command, env),
  spawnSync: (...args) => childProcess.spawnSync(...args),
};

function selectBrowserCommand(options = {}, env = process.env, diagnosticsRunner = defaultBrowserCommandRunner) {
  const explicit =
    options.browser ||
    trimmed(env.CODEX_BROWSER_CONTROL_EXECUTABLE) ||
    trimmed(env.CODEX_CHROME_EXECUTABLE);
  if (explicit) {
    const resolved = resolveExecutable(explicit, env);
    if (!resolved) {
      throw new Error(
        `Browser executable is not available: ${explicit}. ` +
          formatBrowserSelectionDiagnostics({
            explicit,
            targetOrder: [],
            env,
            runner: diagnosticsRunner,
          }),
      );
    }
    const target = options.target || "custom";
    return { command: normalizeBrowserExecutable(resolved, target), target };
  }

  const requestedTarget = options.target || trimmed(env.CODEX_BROWSER_CONTROL_TARGET);
  const targetOrder = requestedTarget ? [requestedTarget] : DEFAULT_TARGET_ORDER;
  for (const target of targetOrder) {
    const commands = TARGETS[target];
    if (!commands) {
      throw new Error(
        `Unsupported browser target: ${target}. Supported targets: ${Object.keys(TARGETS).join(", ")}. ` +
          formatBrowserSelectionDiagnostics({
            targetOrder,
            env,
            runner: diagnosticsRunner,
          }),
      );
    }
    for (const command of commands) {
      const resolved = resolveExecutable(command, env);
      if (resolved) return { command: normalizeBrowserExecutable(resolved, target), target };
    }
  }

  throw new Error(
    `No supported browser executable found. ` +
      formatBrowserSelectionDiagnostics({
        targetOrder,
        env,
        runner: diagnosticsRunner,
      }),
  );
}

function formatBrowserSelectionDiagnostics({
  explicit = null,
  targetOrder = DEFAULT_TARGET_ORDER,
  env = process.env,
  runner = defaultBrowserCommandRunner,
} = {}) {
  const details = [];
  if (explicit) {
    details.push(`explicit executable: ${explicit}`);
  }
  if (targetOrder.length > 0) {
    details.push(`target order: ${targetOrder.join(", ")}`);
    details.push(`candidate commands: ${formatCandidateCommands(targetOrder)}`);
  }
  details.push(`system default browser: ${formatDefaultWebBrowser(readDefaultWebBrowser(env, runner))}`);
  details.push("system default unchanged: this probe only reads xdg-settings get default-web-browser");
  return details.join("; ");
}

function formatCandidateCommands(targetOrder) {
  return targetOrder
    .map((target) => {
      const commands = TARGETS[target];
      return commands ? `${target}=[${commands.join(", ")}]` : `${target}=[unsupported]`;
    })
    .join("; ");
}

function readDefaultWebBrowser(env = process.env, runner = defaultBrowserCommandRunner) {
  const xdgSettings = runner.resolveExecutable("xdg-settings", env);
  if (!xdgSettings) {
    return { value: null, detail: "xdg-settings not found" };
  }

  const result = runner.spawnSync(xdgSettings, ["get", "default-web-browser"], {
    encoding: "utf8",
    env,
    timeout: 1500,
  });
  if (result.error) {
    return { value: null, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = trimmed(result.stderr) || `exit ${result.status}`;
    return { value: null, detail };
  }

  return { value: trimmed(result.stdout), detail: null };
}

function formatDefaultWebBrowser(defaultBrowser) {
  if (defaultBrowser.value) return defaultBrowser.value;
  return defaultBrowser.detail ? `unavailable (${defaultBrowser.detail})` : "unreported";
}

function normalizeBrowserExecutable(command, target) {
  if (target === "brave-origin-nightly" && path.basename(command) === "brave-origin-nightly") {
    const directBinary = "/opt/brave.com/brave-origin-nightly/brave";
    if (isExecutable(directBinary)) return directBinary;
  }
  return command;
}

function trimmed(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port == null) reject(new Error("Could not allocate a TCP port"));
        else resolve(port);
      });
    });
  });
}

function buildBrowserArgs({ cdpPort, profileDir, headless }) {
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter",
    `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
  ];
  if (headless) args.push("--headless=new", "--hide-scrollbars");
  return args;
}

async function launchBrowser({ command, cdpPort, targetUrl, headless }) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-cdp-profile-"));
  const args = buildBrowserArgs({ cdpPort, profileDir, targetUrl, headless });
  const child = childProcess.spawn(command, args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });
  return { child, profileDir, stderr: () => stderr };
}

async function waitForCdp(cdpUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await httpJson("GET", new URL("/json/version", cdpUrl));
    } catch (error) {
      lastError = error;
      await delay(150);
    }
  }
  throw new Error(`Timed out waiting for CDP at ${cdpUrl}: ${lastError?.message || "no response"}`);
}

async function captureFromCdp({ cdpUrl, targetUrl, outputPath, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  await waitForCdp(cdpUrl, timeoutMs);
  const target = await createTarget(cdpUrl, targetUrl);
  if (!target.webSocketDebuggerUrl) {
    throw new Error("CDP target did not include webSocketDebuggerUrl");
  }

  const connection = await CdpWebSocket.connect(target.webSocketDebuggerUrl, timeoutMs);
  try {
    await connection.send("Page.enable");
    await connection.send("Emulation.setDeviceMetricsOverride", {
      width: DEFAULT_VIEWPORT.width,
      height: DEFAULT_VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await connection.send("Runtime.evaluate", {
      expression: "document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true",
      awaitPromise: true,
      returnByValue: true,
    });
    const screenshot = await connection.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    if (!screenshot || typeof screenshot.data !== "string") {
      throw new Error("Page.captureScreenshot did not return PNG data");
    }
    const bytes = Buffer.from(screenshot.data, "base64");
    if (!hasPngHeader(bytes)) {
      throw new Error("Captured screenshot is not a PNG");
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, bytes);
    return {
      targetId: target.id || null,
      screenshotPath: outputPath,
      screenshotBytes: bytes.length,
    };
  } finally {
    connection.close();
    if (target.id) {
      await httpText("GET", new URL(`/json/close/${target.id}`, cdpUrl)).catch(() => null);
    }
  }
}

async function createTarget(cdpUrl, targetUrl) {
  const endpoint = new URL(`/json/new?${encodeURIComponent(targetUrl)}`, cdpUrl);
  try {
    return await httpJson("PUT", endpoint);
  } catch {
    return await httpJson("GET", endpoint);
  }
}

function hasPngHeader(bytes) {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

async function runVerification(options) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const outputPath =
    options.screenshotPath ||
    path.join(os.tmpdir(), `codex-browser-cdp-screenshot-${process.pid}.png`);
  let launched = null;
  let selected = null;
  let cdpUrl = options.cdpUrl;
  let cdpPort = options.cdpPort;

  try {
    if (!cdpUrl) {
      selected = selectBrowserCommand(options);
      cdpPort = cdpPort || await findFreePort();
      cdpUrl = `http://127.0.0.1:${cdpPort}`;
      launched = await launchBrowser({
        command: selected.command,
        cdpPort,
        targetUrl: options.targetUrl,
        headless: options.headless,
      });
    }

    const capture = await captureFromCdp({
      cdpUrl,
      targetUrl: options.targetUrl,
      outputPath,
      timeoutMs,
    });
    return {
      ok: true,
      launched: Boolean(launched),
      browser: selected?.command || null,
      target: selected?.target || null,
      browserPid: launched?.child.pid || null,
      cdpUrl,
      profileDir: launched?.profileDir || null,
      keptProfile: Boolean(launched && options.keepProfile),
      ...capture,
    };
  } catch (error) {
    return {
      ok: false,
      launched: Boolean(launched),
      browser: selected?.command || null,
      target: selected?.target || null,
      browserPid: launched?.child.pid || null,
      cdpUrl,
      profileDir: launched?.profileDir || null,
      keptProfile: Boolean(launched && options.keepProfile),
      message: error instanceof Error ? error.message : String(error),
      browserStderr: launched?.stderr?.() || "",
    };
  } finally {
    if (launched) {
      await stopBrowserProcess(launched.child);
      if (!options.keepProfile) {
        fs.rmSync(launched.profileDir, { recursive: true, force: true });
      }
    }
  }
}

async function stopBrowserProcess(child) {
  if (!child || child.exitCode != null) return;
  const waitForClose = onceClose(child);
  killProcessGroup(child.pid, "SIGTERM");
  const closed = await Promise.race([waitForClose.then(() => true), delay(750).then(() => false)]);
  if (!closed && child.exitCode == null) {
    killProcessGroup(child.pid, "SIGKILL");
    await Promise.race([waitForClose, delay(1000)]);
  }
}

function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

function onceClose(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null) {
      resolve();
      return;
    }
    child.once("close", resolve);
  });
}

function httpJson(method, url) {
  return httpText(method, url).then((body) => {
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(`Invalid JSON from ${url}: ${error.message}`);
    }
  });
}

function httpText(method, url) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if ((response.statusCode || 0) >= 400) {
          reject(new Error(`${method} ${url} returned ${response.statusCode}: ${body.slice(0, 200)}`));
        } else {
          resolve(body);
        }
      });
    });
    request.on("error", reject);
    request.setTimeout(5000, () => {
      request.destroy(new Error(`${method} ${url} timed out`));
    });
    request.end();
  });
}

class CdpWebSocket {
  constructor(socket, commandTimeoutMs) {
    this.socket = socket;
    this.commandTimeoutMs = commandTimeoutMs;
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.closed = false;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("close", () => this.rejectAll(new Error("CDP WebSocket closed")));
  }

  static async connect(wsUrl, timeoutMs) {
    const url = new URL(wsUrl);
    if (url.protocol !== "ws:") {
      throw new Error(`Only ws:// CDP URLs are supported: ${wsUrl}`);
    }
    const socket = await connectTcp(url.hostname, Number(url.port || 80), timeoutMs);
    await websocketHandshake(socket, url, timeoutMs);
    return new CdpWebSocket(socket, timeoutMs);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP WebSocket is closed"));
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    this.socket.write(encodeWebSocketTextFrame(payload, { masked: true }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const decoded = decodeWebSocketFrames(this.buffer);
    this.buffer = decoded.remaining;
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x9) {
        this.socket.write(encodeWebSocketFrame(frame.payload, { opcode: 0xa, masked: true }));
        continue;
      }
      if (frame.opcode !== 0x1) continue;
      const message = JSON.parse(frame.payload.toString("utf8"));
      if (message.id == null) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  rejectAll(error) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    this.socket.destroy();
  }
}

function connectTcp(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy(new Error("CDP WebSocket TCP connection timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function websocketHandshake(socket, url, timeoutMs) {
  const key = crypto.randomBytes(16).toString("base64");
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const request = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");

  socket.write(request);
  const response = await readUntil(socket, Buffer.from("\r\n\r\n"), timeoutMs);
  const header = response.toString("utf8");
  if (!/^HTTP\/1\.[01] 101\b/.test(header)) {
    throw new Error(`CDP WebSocket upgrade failed: ${header.split("\r\n")[0] || "empty response"}`);
  }
}

function readUntil(socket, marker, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out during CDP WebSocket handshake"));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf(marker);
      if (index !== -1) {
        cleanup();
        resolve(buffer.subarray(0, index + marker.length));
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function encodeWebSocketTextFrame(text, options = {}) {
  return encodeWebSocketFrame(Buffer.from(text, "utf8"), { opcode: 0x1, ...options });
}

function encodeWebSocketFrame(payload, { opcode = 0x1, masked = false } = {}) {
  const length = payload.length;
  let lengthBytes;
  let lengthMarker;
  if (length < 126) {
    lengthMarker = length;
    lengthBytes = Buffer.alloc(0);
  } else if (length <= 0xffff) {
    lengthMarker = 126;
    lengthBytes = Buffer.alloc(2);
    lengthBytes.writeUInt16BE(length, 0);
  } else {
    lengthMarker = 127;
    lengthBytes = Buffer.alloc(8);
    lengthBytes.writeBigUInt64BE(BigInt(length), 0);
  }

  const mask = masked ? crypto.randomBytes(4) : Buffer.alloc(0);
  const header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | lengthMarker]);
  const body = masked ? Buffer.from(payload) : payload;
  if (masked) {
    for (let index = 0; index < body.length; index += 1) {
      body[index] ^= mask[index % 4];
    }
  }
  return Buffer.concat([header, lengthBytes, mask, body]);
}

function decodeWebSocketFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("WebSocket frame is too large");
      }
      length = Number(bigLength);
      headerLength = 10;
    }
    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + (masked ? 4 : 0);
    const frameEnd = payloadOffset + length;
    if (buffer.length < frameEnd) break;

    const payload = Buffer.from(buffer.subarray(payloadOffset, frameEnd));
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    frames.push({ opcode, payload });
    offset = frameEnd;
  }

  return { frames, remaining: buffer.subarray(offset) };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return 0;
    }
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    return 2;
  }

  const report = await runVerification(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log(`OK: CDP screenshot captured at ${report.screenshotPath} (${report.screenshotBytes} bytes)`);
    if (report.browser) console.log(`Browser: ${report.browser}`);
    console.log(`CDP: ${report.cdpUrl}`);
  } else {
    console.error(`FAIL: ${report.message}`);
    if (report.target) console.error(`Target: ${report.target}`);
    if (report.browser) console.error(`Browser: ${report.browser}`);
    if (report.profileDir) console.error(`Profile: ${report.profileDir}`);
    if (report.cdpUrl) console.error(`CDP: ${report.cdpUrl}`);
    if (report.browserStderr) {
      console.error(report.browserStderr.trim());
    }
  }
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  DEFAULT_TEST_HTML,
  TARGETS,
  buildBrowserArgs,
  captureFromCdp,
  decodeWebSocketFrames,
  defaultTargetUrl,
  encodeWebSocketFrame,
  encodeWebSocketTextFrame,
  hasPngHeader,
  formatBrowserSelectionDiagnostics,
  parseArgs,
  readDefaultWebBrowser,
  runVerification,
  selectBrowserCommand,
  normalizeBrowserExecutable,
};
