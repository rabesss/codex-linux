#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildBrowserArgs,
  captureFromCdp,
  decodeWebSocketFrames,
  encodeWebSocketFrame,
  encodeWebSocketTextFrame,
  formatBrowserSelectionDiagnostics,
  hasPngHeader,
  normalizeBrowserExecutable,
  parseArgs,
  readDefaultWebBrowser,
  selectBrowserCommand,
} = require("./verify-browser-cdp-screenshot.js");

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP0I7wAAAABJRU5ErkJggg==",
  "base64",
);

function defaultBrowserRunner(value, calls = []) {
  return {
    resolveExecutable(command, env) {
      calls.push({ type: "resolve", command, path: env.PATH });
      return "/usr/bin/xdg-settings";
    },
    spawnSync(command, args, options) {
      calls.push({ type: "spawn", command, args, env: options.env });
      return { status: 0, stdout: `${value}\n`, stderr: "" };
    },
  };
}

test("argument parser accepts target, CDP, screenshot, and JSON options", () => {
  const options = parseArgs([
    "--target",
    "chromium",
    "--cdp-url=http://127.0.0.1:9222",
    "--screenshot",
    "/tmp/out.png",
    "--timeout-ms",
    "1200",
    "--headed",
    "--json",
  ]);
  assert.equal(options.target, "chromium");
  assert.equal(options.cdpUrl, "http://127.0.0.1:9222");
  assert.equal(options.screenshotPath, "/tmp/out.png");
  assert.equal(options.timeoutMs, 1200);
  assert.equal(options.headless, false);
  assert.equal(options.json, true);
});

test("browser selection honors explicit executable without consulting target order", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-select-"));
  try {
    const browser = path.join(temp, "browser");
    fs.writeFileSync(browser, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(browser, 0o755);
    const selected = selectBrowserCommand({ browser, target: "chromium" }, { PATH: "" });
    assert.equal(selected.command, browser);
    assert.equal(selected.target, "chromium");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("browser selection defaults to Brave Origin Nightly before other supported browsers", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-select-order-"));
  try {
    const braveOrigin = path.join(temp, "brave-origin-nightly");
    const chrome = path.join(temp, "google-chrome");
    fs.writeFileSync(braveOrigin, "#!/bin/sh\nexit 0\n");
    fs.writeFileSync(chrome, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(braveOrigin, 0o755);
    fs.chmodSync(chrome, 0o755);

    const selected = selectBrowserCommand({}, { PATH: temp });
    if (fs.existsSync("/opt/brave.com/brave-origin-nightly/brave")) {
      assert.equal(selected.command, "/opt/brave.com/brave-origin-nightly/brave");
    } else {
      assert.equal(selected.command, braveOrigin);
    }
    assert.equal(selected.target, "brave-origin-nightly");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("browser selection failure reports candidates and reads the default browser without changing it", () => {
  const calls = [];
  const env = { PATH: "" };
  assert.throws(
    () => selectBrowserCommand(
      { target: "brave-origin-nightly" },
      env,
      defaultBrowserRunner("zen.desktop", calls),
    ),
    (error) => {
      assert.match(error.message, /No supported browser executable found/);
      assert.match(error.message, /target order: brave-origin-nightly/);
      assert.match(error.message, /brave-origin-nightly=\[brave-origin-nightly\]/);
      assert.match(error.message, /system default browser: zen\.desktop/);
      assert.match(error.message, /system default unchanged/);
      return true;
    },
  );
  assert.deepEqual(calls, [
    { type: "resolve", command: "xdg-settings", path: "" },
    { type: "spawn", command: "/usr/bin/xdg-settings", args: ["get", "default-web-browser"], env },
  ]);
});

test("browser selection diagnostics include explicit override failures", () => {
  const diagnostic = formatBrowserSelectionDiagnostics({
    explicit: "/missing/browser",
    targetOrder: [],
    env: { PATH: "" },
  });
  assert.match(diagnostic, /explicit executable: \/missing\/browser/);
  assert.match(diagnostic, /system default browser: unavailable \(xdg-settings not found\)/);
  assert.match(diagnostic, /system default unchanged/);
});

test("default browser diagnostic shells out to xdg-settings get only", () => {
  const calls = [];
  const env = { PATH: "/bin" };
  assert.deepEqual(readDefaultWebBrowser(env, defaultBrowserRunner("brave-origin-nightly.desktop", calls)), {
    value: "brave-origin-nightly.desktop",
    detail: null,
  });
  assert.deepEqual(calls, [
    { type: "resolve", command: "xdg-settings", path: "/bin" },
    { type: "spawn", command: "/usr/bin/xdg-settings", args: ["get", "default-web-browser"], env },
  ]);
});

test("Brave Origin wrapper is normalized to the direct packaged binary when present", () => {
  const normalized = normalizeBrowserExecutable(
    "/usr/bin/brave-origin-nightly",
    "brave-origin-nightly",
  );
  if (fs.existsSync("/opt/brave.com/brave-origin-nightly/brave")) {
    assert.equal(normalized, "/opt/brave.com/brave-origin-nightly/brave");
  } else {
    assert.equal(normalized, "/usr/bin/brave-origin-nightly");
  }
});

test("browser launch arguments use a temporary profile, CDP port, and headless mode", () => {
  const args = buildBrowserArgs({
    cdpPort: 3333,
    profileDir: "/tmp/codex-profile",
    targetUrl: "data:text/html,test",
    headless: true,
  });
  assert(args.includes("--user-data-dir=/tmp/codex-profile"));
  assert(args.includes("--remote-debugging-port=3333"));
  assert(args.includes("--headless=new"));
  assert.equal(args.includes("data:text/html,test"), false);
});

test("websocket frame codec handles masked text and fragmented buffers", () => {
  const payload = JSON.stringify({ id: 1, result: { ok: true } });
  const frame = encodeWebSocketTextFrame(payload, { masked: true });
  const first = decodeWebSocketFrames(frame.subarray(0, 4));
  assert.equal(first.frames.length, 0);
  assert.equal(first.remaining.length, 4);
  const second = decodeWebSocketFrames(Buffer.concat([first.remaining, frame.subarray(4)]));
  assert.equal(second.frames.length, 1);
  assert.equal(second.frames[0].opcode, 1);
  assert.equal(second.frames[0].payload.toString("utf8"), payload);
  assert.equal(second.remaining.length, 0);
});

test("PNG header validation rejects non-PNG data", () => {
  assert.equal(hasPngHeader(PNG_1X1), true);
  assert.equal(hasPngHeader(Buffer.from("not png")), false);
});

test("CDP screenshot capture writes PNG output through a fake CDP server", async () => {
  const server = await startFakeCdpServer();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cdp-capture-"));
  try {
    const screenshotPath = path.join(temp, "screenshot.png");
    const result = await captureFromCdp({
      cdpUrl: server.cdpUrl,
      targetUrl: "data:text/html,fake",
      outputPath: screenshotPath,
      timeoutMs: 3000,
    });

    assert.equal(result.targetId, "page-1");
    assert.equal(result.screenshotPath, screenshotPath);
    assert.equal(result.screenshotBytes, PNG_1X1.length);
    assert.deepEqual(fs.readFileSync(screenshotPath), PNG_1X1);
    assert.deepEqual(server.methods, [
      "Page.enable",
      "Emulation.setDeviceMetricsOverride",
      "Runtime.evaluate",
      "Page.captureScreenshot",
    ]);
    assert.equal(server.closedTargets.includes("page-1"), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    await server.close();
  }
});

async function startFakeCdpServer() {
  const methods = [];
  const closedTargets = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const host = request.headers.host;
    const cdpUrl = `http://${host}`;
    if (request.url === "/json/version") {
      writeJson(response, { Browser: "FakeChrome/1", protocolVersion: "1.3" });
      return;
    }
    if (request.url?.startsWith("/json/new?")) {
      writeJson(response, {
        id: "page-1",
        type: "page",
        webSocketDebuggerUrl: `${cdpUrl.replace(/^http:/, "ws:")}/devtools/page/page-1`,
      });
      return;
    }
    if (request.url === "/json/close/page-1") {
      closedTargets.push("page-1");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("Target is closing");
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));

    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeWebSocketFrames(buffer);
      buffer = decoded.remaining;
      for (const frame of decoded.frames) {
        if (frame.opcode !== 1) continue;
        const message = JSON.parse(frame.payload.toString("utf8"));
        methods.push(message.method);
        const result = message.method === "Page.captureScreenshot"
          ? { data: PNG_1X1.toString("base64") }
          : {};
        socket.write(encodeWebSocketFrame(
          Buffer.from(JSON.stringify({ id: message.id, result }), "utf8"),
          { opcode: 1, masked: false },
        ));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    cdpUrl: `http://127.0.0.1:${address.port}`,
    methods,
    closedTargets,
    close: () => new Promise((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      for (const socket of sockets) socket.destroy();
      server.close(finish);
      setTimeout(finish, 50).unref?.();
    }),
  };
}

function writeJson(response, data) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}
