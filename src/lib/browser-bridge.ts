import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { cluster } from "./config";

/**
 * Local bridge between the CLI and a browser wallet (Phantom, Solflare,
 * Backpack). The CLI serves a one-page app on 127.0.0.1, the page connects
 * through Wallet Standard and signs serialized transactions, and the signature
 * comes back over HTTP. The key never leaves the extension.
 *
 * Security: loopback only, one random token per session, Host header check,
 * single pending request, three minute timeout, server closed when done.
 */

export interface BrowserWallet {
  publicKey: string;
  signTransaction(bytes: Uint8Array): Promise<Uint8Array>;
  signMessage(bytes: Uint8Array): Promise<Uint8Array>;
  close(): void;
}

interface PendingRequest {
  id: string;
  kind: "transaction" | "message";
  payload: string;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
}

const TIMEOUT_MS = 3 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const POLL_INTERVAL_MS = 400;

const CHAINS: Record<string, string> = {
  devnet: "solana:devnet",
  testnet: "solana:testnet",
  "mainnet-beta": "solana:mainnet",
  localnet: "solana:localnet",
};

export async function connectBrowserWallet(): Promise<BrowserWallet> {
  const token = randomBytes(32).toString("hex");
  let pending: PendingRequest | null = null;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();

  let resolveConnected!: (publicKey: string) => void;
  let rejectConnected!: (error: Error) => void;
  const connected = new Promise<string>((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      sendJson(res, 500, { error: String((error as Error).message ?? error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}/?token=${token}`;

  const timer = setTimeout(() => {
    rejectConnected(
      new Error("Wallet connection timed out after 3 minutes. Run the command again."),
    );
    shutdown();
  }, TIMEOUT_MS);

  function shutdown(): void {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (pending) {
      pending.reject(new Error("Wallet bridge closed before the request was signed."));
      pending = null;
    }
    server.close();
  }

  function tokenMatches(given: unknown): boolean {
    if (typeof given !== "string") return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function hostMatches(req: IncomingMessage): boolean {
    return req.headers.host === `127.0.0.1:${port}`;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostMatches(req)) {
      sendJson(res, 403, { error: "Unexpected host" });
      return;
    }

    const requestUrl = new URL(req.url ?? "/", origin);

    if (req.method === "GET" && requestUrl.pathname === "/") {
      if (!tokenMatches(requestUrl.searchParams.get("token"))) {
        sendJson(res, 403, { error: "Bad token" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
      });
      res.end(renderPage(token, CHAINS[cluster] ?? "solana:devnet"));
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/pending") {
      if (!tokenMatches(requestUrl.searchParams.get("token"))) {
        sendJson(res, 403, { error: "Bad token" });
        return;
      }
      if (!pending) {
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      sendJson(res, 200, {
        id: pending.id,
        kind: pending.kind,
        payload: pending.payload,
      });
      return;
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      if (!tokenMatches(body.token)) {
        sendJson(res, 403, { error: "Bad token" });
        return;
      }

      if (requestUrl.pathname === "/api/connect") {
        if (typeof body.publicKey !== "string" || !body.publicKey) {
          sendJson(res, 400, { error: "publicKey is required" });
          return;
        }
        resolveConnected(body.publicKey);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/api/signed") {
        if (!pending || pending.id !== body.id) {
          sendJson(res, 409, { error: "No matching request" });
          return;
        }
        if (typeof body.result !== "string") {
          sendJson(res, 400, { error: "result is required" });
          return;
        }
        pending.resolve(Buffer.from(body.result, "base64"));
        pending = null;
        sendJson(res, 200, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/api/error") {
        const message =
          typeof body.message === "string" ? body.message : "Wallet rejected the request";
        if (pending && pending.id === body.id) {
          pending.reject(new Error(message));
          pending = null;
        } else {
          rejectConnected(new Error(message));
        }
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    sendJson(res, 404, { error: "Not found" });
  }

  function request(
    kind: PendingRequest["kind"],
    payload: Uint8Array,
  ): Promise<Uint8Array> {
    const job = queue.then(
      () =>
        new Promise<Uint8Array>((resolve, reject) => {
          const id = randomBytes(8).toString("hex");
          pending = {
            id,
            kind,
            payload: Buffer.from(payload).toString("base64"),
            resolve,
            reject,
          };
        }),
    );
    queue = job.catch(() => undefined);
    return job;
  }

  openBridge(url);

  let publicKey: string;
  try {
    publicKey = await connected;
  } catch (error) {
    shutdown();
    throw error;
  }

  return {
    publicKey,
    signTransaction: (bytes) => request("transaction", bytes),
    signMessage: (bytes) => request("message", bytes),
    close: shutdown,
  };
}

function openBridge(url: string): void {
  const file = process.env.NFT_BRIDGE_URL_FILE;
  if (file) {
    // Test hook: let a script act as the wallet instead of opening a browser.
    writeFileSync(file, url);
    return;
  }

  const platform = process.platform;
  const command =
    platform === "win32"
      ? { cmd: "cmd", args: ["/c", "start", "", url] }
      : platform === "darwin"
        ? { cmd: "open", args: [url] }
        : { cmd: "xdg-open", args: [url] };

  try {
    const child = spawn(command.cmd, command.args, {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {
    // The URL is printed by the caller anyway.
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Body must be JSON");
  }
}

function renderPage(token: string, defaultChain: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Approve with your wallet</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0b0b0f; color: #f2f2f7; }
  main { width: min(560px, 92vw); padding: 28px; border-radius: 16px;
         background: #15151c; border: 1px solid #262633; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 18px; color: #a7a7b7; }
  button { font: inherit; font-weight: 600; padding: 12px 18px; border-radius: 10px;
           border: 0; background: #7c5cff; color: white; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .status { margin-top: 18px; padding: 12px; border-radius: 10px; background: #1d1d27;
            color: #cfcfe0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 13px; word-break: break-all; }
  .ok { color: #6ee7a8; } .err { color: #ff8b8b; }
  code { background: #1d1d27; padding: 2px 6px; border-radius: 6px; }
</style>
</head>
<body>
<main>
  <h1>Approve with your wallet</h1>
  <p>Connect Phantom or Solflare, then approve each transaction it shows. This page talks to your local CLI only.</p>
  <div class="row">
    <button id="connect">Connect wallet</button>
    <span id="wallet" class="status" style="margin:0;padding:6px 10px">not connected</span>
  </div>
  <div id="status" class="status">Waiting for a connection.</div>
  <p style="margin-top:18px">You can close this tab when the CLI finishes.</p>
</main>
<script>
(function () {
  var token = ${JSON.stringify(token)};
  var defaultChain = ${JSON.stringify(defaultChain)};
  var statusEl = document.getElementById("status");
  var walletEl = document.getElementById("wallet");
  var connectBtn = document.getElementById("connect");
  var account = null;
  var wallet = null;
  var chain = defaultChain;
  var running = true;

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status" + (cls ? " " + cls : "");
  }

  function candidates() {
    var list = [];
    var seen = [];
    var possible = [
      window.phantom && window.phantom.solana,
      window.solflare,
      window.backpack,
      window.solana
    ];
    for (var i = 0; i < possible.length; i++) {
      var w = possible[i];
      if (!w || seen.indexOf(w) !== -1) continue;
      seen.push(w);
      if (w.features && w.features["solana:signTransaction"]) list.push(w);
    }
    return list;
  }

  function b64ToBytes(b64) {
    var raw = atob(b64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  async function connect() {
    connectBtn.disabled = true;
    var found = candidates();
    if (!found.length) {
      setStatus("No Solana wallet found. Install Phantom or Solflare, then reload this page.", "err");
      connectBtn.disabled = false;
      return;
    }
    wallet = found[0];
    try {
      var connectFeature = wallet.features["standard:connect"];
      var result = await connectFeature.connect();
      account = result.accounts && result.accounts[0];
      if (!account) throw new Error("Wallet returned no accounts");
      var supported = account.chains || [];
      for (var i = 0; i < supported.length; i++) {
        if (supported[i] === defaultChain) { chain = defaultChain; break; }
      }
      if (supported.length && supported.indexOf(chain) === -1) chain = supported[0];
      walletEl.textContent = account.address;
      await post("/api/connect", { token: token, publicKey: account.address, chain: chain });
      setStatus("Connected. Approve the transaction in your wallet.", "ok");
      poll();
    } catch (error) {
      setStatus(String(error && error.message ? error.message : error), "err");
      connectBtn.disabled = false;
    }
  }

  async function sign(job) {
    var feature = (account.features && account.features[job.kind === "message" ? "solana:signMessage" : "solana:signTransaction"])
      || wallet.features[job.kind === "message" ? "solana:signMessage" : "solana:signTransaction"];
    if (!feature) throw new Error("Wallet does not support " + job.kind);
    var bytes = b64ToBytes(job.payload);
    var result;
    if (job.kind === "message") {
      result = await feature.signMessage({ message: bytes, account: account });
      return bytesToB64(result[0].signature);
    }
    result = await feature.signTransaction({ transaction: bytes, account: account, chain: chain });
    return bytesToB64(result[0].signedTransaction);
  }

  async function poll() {
    while (running) {
      try {
        var res = await fetch("/api/pending?token=" + encodeURIComponent(token));
        if (res.status === 204) {
          await new Promise(function (r) { setTimeout(r, ${POLL_INTERVAL_MS}); });
          continue;
        }
        if (!res.ok) { setStatus("CLI stopped responding.", "err"); running = false; break; }
        var job = await res.json();
        setStatus("Waiting for approval in your wallet...");
        try {
          var signed = await sign(job);
          await post("/api/signed", { token: token, id: job.id, result: signed });
          setStatus("Signed. Waiting for the next step.", "ok");
        } catch (error) {
          await post("/api/error", {
            token: token,
            id: job.id,
            message: String(error && error.message ? error.message : error)
          });
          setStatus("Request rejected or failed: " + String(error && error.message ? error.message : error), "err");
        }
      } catch (error) {
        setStatus("Connection to the CLI lost.", "err");
        running = false;
      }
    }
  }

  connectBtn.addEventListener("click", connect);
  window.addEventListener("beforeunload", function () { running = false; });
})();
</script>
</body>
</html>`;
}
