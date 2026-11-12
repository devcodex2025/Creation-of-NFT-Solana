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
  close(): Promise<void>;
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
  let finished = false;
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

  async function finish(): Promise<void> {
    if (closed || finished) return;
    finished = true;
    // Give the page one poll cycle to see the finished state before the
    // socket closes, so it can report a clean ending instead of a network error.
    await new Promise((resolve) => setTimeout(resolve, 700));
    shutdown();
  }

  process.once("beforeExit", () => {
    void finish();
  });

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
      if (finished) {
        sendJson(res, 200, { finished: true });
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

  if (!process.env.NFT_BRIDGE_URL_FILE) {
    console.log(`\n🌐  Wallet bridge: ${url}`);
    console.log(
      "   If no tab opened, paste that URL into the browser where Phantom or Solflare is installed.",
    );
  }

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
    close: finish,
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
  const cluster = defaultChain.replace("solana:", "");
  const chainLabel = cluster.charAt(0).toUpperCase() + cluster.slice(1);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Approve with your wallet</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f4ef;
    --surface: #ffffff;
    --text: #15181a;
    --muted: #5c625e;
    --line: #d7d8d0;
    --hover: #f3f5f0;
    --accent: #0f6b52;
    --accent-strong: #0b5641;
    --accent-contrast: #ffffff;
    --danger: #a12a1f;
    --focus: #0f6b52;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d100f;
      --surface: #181c1a;
      --text: #e9ece9;
      --muted: #a4aba6;
      --line: #333a35;
      --hover: #202723;
      --accent: #6fd7ac;
      --accent-strong: #8ae3bd;
      --accent-contrast: #0b2019;
      --danger: #ffb4ab;
      --focus: #6fd7ac;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    padding: clamp(24px, 8vh, 72px) 16px 48px;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex;
    justify-content: center;
    align-items: flex-start;
  }
  main {
    width: min(560px, 100%);
    padding: 24px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
  }
  h1 { margin: 0 0 6px; font-size: 20px; line-height: 1.3; letter-spacing: -0.01em; }
  .lede { margin: 0 0 6px; max-width: 52ch; color: var(--muted); font-size: 14px; }
  .meta { margin: 0 0 20px; color: var(--muted); font-size: 12.5px; }
  ul.wallets { list-style: none; margin: 0 0 16px; padding: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  ul.wallets li + li { border-top: 1px solid var(--line); }
  button { font: inherit; cursor: pointer; }
  button.wallet {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 56px;
    padding: 8px 14px;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
  }
  button.wallet:hover { background: var(--hover); }
  button.wallet:active { background: var(--line); }
  button.wallet:disabled { opacity: 0.55; cursor: not-allowed; }
  button.wallet img { width: 22px; height: 22px; border-radius: 5px; flex: none; }
  button.wallet .name { font-weight: 600; overflow-wrap: anywhere; }
  button.wallet .action { margin-left: auto; color: var(--accent); font-size: 13.5px; font-weight: 600; }
  .empty { margin: 0 0 16px; padding: 16px; border: 1px solid var(--line); border-radius: 8px; }
  .empty p { margin: 0 0 12px; color: var(--muted); font-size: 14px; }
  .empty strong { color: var(--text); }
  button.secondary {
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: transparent;
    color: var(--text);
    font-weight: 600;
  }
  button.secondary:hover { background: var(--hover); }
  #status { margin: 12px 0 0; min-height: 1.55em; color: var(--muted); font-size: 14px; }
  #status:empty { margin: 0; min-height: 0; }
  #status.ok { color: var(--accent); }
  #status.err { color: var(--danger); }
  #connected { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
  #connected p { margin: 0; }
  #connected .who { color: var(--text); font-weight: 600; }
  #connected code { font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace; font-size: 12.5px; overflow-wrap: anywhere; }
  #connected .count { margin-top: 6px; font-size: 12.5px; }
  button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Approve with your wallet</h1>
    <p class="lede">The CLI on this machine is asking for signatures. Your keys stay in the wallet extension.</p>
    <p class="meta">${chainLabel}, local bridge</p>
  </header>
  <ul id="wallets" class="wallets" hidden></ul>
  <div id="empty" class="empty" hidden>
    <p><strong>No wallet detected.</strong> Open this page in the browser where Phantom, Solflare or Backpack is installed.</p>
    <button type="button" id="rescan" class="secondary">Scan again</button>
  </div>
  <div id="connected" hidden>
    <p>Connected as <span id="wallet-name" class="who"></span></p>
    <code id="wallet-address"></code>
    <p id="count" class="count">No requests signed yet.</p>
  </div>
  <p id="status" role="status" aria-live="polite">Looking for a wallet.</p>
</main>
<script>
(function () {
  var token = ${JSON.stringify(token)};
  var defaultChain = ${JSON.stringify(defaultChain)};
  var statusEl = document.getElementById("status");
  var walletsEl = document.getElementById("wallets");
  var emptyEl = document.getElementById("empty");
  var rescanEl = document.getElementById("rescan");
  var connectedEl = document.getElementById("connected");
  var walletNameEl = document.getElementById("wallet-name");
  var walletAddressEl = document.getElementById("wallet-address");
  var countEl = document.getElementById("count");
  var account = null;
  var wallet = null;
  var chain = defaultChain;
  var running = false;
  var connected = false;
  var settled = false;
  var approvals = 0;
  var discovered = [];

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || "";
  }

  function show(element, visible) {
    element.hidden = !visible;
  }

  function errorText(error) {
    return String(error && error.message ? error.message : error);
  }

  function addWallet(candidate) {
    if (!candidate || !candidate.features || !candidate.features["standard:connect"]) return;
    for (var i = 0; i < discovered.length; i++) {
      if (discovered[i] === candidate) return;
      if (candidate.name && discovered[i].name === candidate.name) return;
    }
    discovered.push(candidate);
    render();
  }

  function registerWallets() {
    for (var i = 0; i < arguments.length; i++) addWallet(arguments[i]);
  }

  // Wallet Standard discovery. Wallets that loaded before this page answer the
  // app-ready event; wallets injected later fire register-wallet. Both paths
  // end in addWallet, so a wallet never needs a Phantom-specific global.
  var api = { register: registerWallets };
  try {
    window.addEventListener("wallet-standard:register-wallet", function (event) {
      try { event.detail(api); } catch (error) {}
    });
  } catch (error) {}
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  } catch (error) {}

  function render() {
    walletsEl.textContent = "";
    for (var i = 0; i < discovered.length; i++) {
      (function (candidate) {
        var item = document.createElement("li");
        var button = document.createElement("button");
        button.type = "button";
        button.className = "wallet";

        if (candidate.icon) {
          var icon = document.createElement("img");
          icon.src = candidate.icon;
          icon.alt = "";
          icon.width = 22;
          icon.height = 22;
          icon.addEventListener("error", function () { icon.remove(); });
          button.appendChild(icon);
        }

        var name = document.createElement("span");
        name.className = "name";
        name.textContent = candidate.name || "Wallet";
        button.appendChild(name);

        var action = document.createElement("span");
        action.className = "action";
        action.textContent = "Connect";
        button.appendChild(action);

        button.addEventListener("click", function () { connect(candidate); });
        item.appendChild(button);
        walletsEl.appendChild(item);
      })(discovered[i]);
    }

    var hasWallets = discovered.length > 0;
    show(walletsEl, hasWallets && !connected);
    show(emptyEl, !hasWallets && settled && !connected);
    if (!connected) {
      if (hasWallets) setStatus("Choose a wallet to connect.");
      else setStatus("");
    }
  }

  function useLegacyProviders() {
    if (discovered.length) return;
    var possible = [
      window.phantom && window.phantom.solana,
      window.solflare,
      window.backpack,
      window.solana
    ];
    for (var i = 0; i < possible.length; i++) addWallet(possible[i]);
  }

  function scan() {
    try {
      window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
    } catch (error) {}
    useLegacyProviders();
  }

  setTimeout(function () {
    useLegacyProviders();
    settled = true;
    render();
  }, 1200);

  rescanEl.addEventListener("click", function () {
    settled = false;
    setStatus("Looking for a wallet.");
    scan();
    setTimeout(function () {
      settled = true;
      render();
    }, 600);
  });

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

  async function connect(candidate) {
    if (connected) return;
    wallet = candidate;
    setStatus("Connecting to " + (wallet.name || "wallet") + ".");
    var buttons = walletsEl.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    try {
      var connectFeature = wallet.features["standard:connect"];
      var result = await connectFeature.connect();
      var accounts = (result && result.accounts) || wallet.accounts || [];
      account = accounts[0];
      if (!account) throw new Error("Wallet returned no accounts");
      chain = defaultChain;
      var supported = account.chains || wallet.chains || [];
      if (supported.length && supported.indexOf(defaultChain) === -1) chain = supported[0];
      await post("/api/connect", { token: token, publicKey: account.address, chain: chain });
      connected = true;
      running = true;
      walletNameEl.textContent = wallet.name || "wallet";
      walletAddressEl.textContent = account.address;
      show(connectedEl, true);
      show(walletsEl, false);
      setStatus("Connected. Approve each request in your wallet.", "ok");
      watchAccount();
      poll();
    } catch (error) {
      setStatus("Could not connect. " + errorText(error), "err");
      for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
    }
  }

  function watchAccount() {
    var events = wallet.features["standard:events"];
    if (!events || !events.on) return;
    events.on("change", function (props) {
      if (!props || !props.accounts) return;
      var next = props.accounts[0];
      if (!next) {
        running = false;
        setStatus("Wallet disconnected. Run the CLI command again.", "err");
        return;
      }
      if (account && next.address !== account.address) {
        running = false;
        walletAddressEl.textContent = next.address;
        setStatus("Account changed in the wallet. Run the CLI command again so it signs with the right account.", "err");
        return;
      }
      account = next;
    });
  }

  async function sign(job) {
    var key = job.kind === "message" ? "solana:signMessage" : "solana:signTransaction";
    var feature = (account.features && account.features[key])
      || (wallet.features && wallet.features[key]);
    if (!feature) {
      throw new Error("This wallet does not support " + (job.kind === "message" ? "message signing" : "transaction signing"));
    }
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
        if (!res.ok) { setStatus("The CLI closed the connection. If the command finished, close this tab."); running = false; break; }
        var job = await res.json();
        if (job.finished) { setStatus("The CLI finished. Close this tab."); running = false; break; }
        setStatus("Waiting for approval. Check your wallet.");
        try {
          var signed = await sign(job);
          await post("/api/signed", { token: token, id: job.id, result: signed });
          approvals = approvals + 1;
          countEl.textContent = approvals === 1 ? "1 request signed." : approvals + " requests signed.";
          setStatus("Signed. Waiting for the next request.", "ok");
        } catch (error) {
          await post("/api/error", {
            token: token,
            id: job.id,
            message: errorText(error)
          });
          setStatus("Request failed. " + errorText(error), "err");
        }
      } catch (error) {
        setStatus("The CLI closed the connection. If the command finished, close this tab.");
        running = false;
      }
    }
  }

  window.addEventListener("beforeunload", function () { running = false; });
})();
</script>
</body>
</html>`;
}
