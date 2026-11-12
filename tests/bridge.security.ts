import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { connectBrowserWallet } from "../src/lib/browser-bridge";

/**
 * Security checks for the local wallet bridge. These do not need a cluster or
 * a real wallet: they only assert that the loopback server refuses foreign
 * hosts, unknown tokens, and that the page it serves is locked down.
 */

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const dir = mkdtempSync(path.join(tmpdir(), "nft-bridge-"));
const urlFile = path.join(dir, "url.txt");
process.env.NFT_BRIDGE_URL_FILE = urlFile;

const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`   ✓ ${name}`);
  } else {
    console.log(`   ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

function inlineScriptParses(html: string): boolean {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) return false;
  try {
    // Compile only: catches syntax errors in the page without running it.
    new Function(match[1]);
    return true;
  } catch {
    return false;
  }
}

function send(
  target: string,
  options: {
    method?: string;
    body?: unknown;
    host?: string;
  } = {},
): Promise<Response> {
  const url = new URL(target);
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        headers: {
          Host: options.host ?? url.host,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
        timeout: 5000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForUrl(): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return readFileSync(urlFile, "utf8").trim();
    } catch {
      if (Date.now() > deadline) throw new Error("bridge never published a URL");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const connecting = connectBrowserWallet();

try {
  const bridgeUrl = await waitForUrl();
  const parsed = new URL(bridgeUrl);
  const token = parsed.searchParams.get("token") ?? "";
  const origin = parsed.origin;

  console.log("\n🔒  Bridge security\n");

  check("URL is loopback only", parsed.hostname === "127.0.0.1", parsed.hostname);
  check("token is 32 random bytes", /^[0-9a-f]{64}$/.test(token), token.slice(0, 8));

  const noToken = await send(`${origin}/`);
  check("page without token is rejected", noToken.status === 403, String(noToken.status));

  const wrongHost = await send(`${origin}/?token=${token}`, {
    host: "evil.example",
  });
  check("foreign Host header is rejected", wrongHost.status === 403, String(wrongHost.status));

  const page = await send(`${origin}/?token=${token}`);
  const csp = String(page.headers["content-security-policy"] ?? "");
  check("page with token is served", page.status === 200, String(page.status));
  check("page sets a Content-Security-Policy", csp.includes("default-src 'none'"), csp);
  check("page sets X-Frame-Options", page.headers["x-frame-options"] === "DENY");
  check("page is not cacheable", page.headers["cache-control"] === "no-store");
  check(
    "page uses Wallet Standard discovery",
    page.body.includes("wallet-standard:app-ready") &&
      page.body.includes("wallet-standard:register-wallet"),
  );
  check(
    "page names Phantom, Solflare and Backpack",
    page.body.includes("Phantom, Solflare or Backpack"),
  );
  check("page scripts parse", inlineScriptParses(page.body));
  check("page has an empty state with rescan", page.body.includes("Scan again"));
  check(
    "page ships light and dark palettes",
    page.body.includes("prefers-color-scheme: dark"),
  );
  check("page has a network badge", page.body.includes('class="network network-'));
  check("page has a request panel", page.body.includes("request-title"));
  check("page never embeds the keypair path", !page.body.includes("keypair.json"));

  const wrongTokenConnect = await send(`${origin}/api/connect`, {
    method: "POST",
    body: { token: "0".repeat(64), publicKey: "11111111111111111111111111111111" },
  });
  check("connect with wrong token is rejected", wrongTokenConnect.status === 403, String(wrongTokenConnect.status));

  const wrongTokenPending = await send(`${origin}/api/pending?token=${"0".repeat(64)}`);
  check("pending poll with wrong token is rejected", wrongTokenPending.status === 403, String(wrongTokenPending.status));

  const emptyPending = await send(`${origin}/api/pending?token=${token}`);
  check("pending poll with token is empty", emptyPending.status === 204, String(emptyPending.status));

  const unknownRoute = await send(`${origin}/api/unknown`, {
    method: "POST",
    body: { token },
  });
  check("unknown POST route returns 404", unknownRoute.status === 404, String(unknownRoute.status));

  const missingKey = await send(`${origin}/api/connect`, {
    method: "POST",
    body: { token },
  });
  check("connect without publicKey returns 400", missingKey.status === 400, String(missingKey.status));

  const publicKey = "FHL1oz55LDXcaovK4f2XYBLcHWFiqvwgB9gAEYzjFYG7";
  const connect = await send(`${origin}/api/connect`, {
    method: "POST",
    body: { token, publicKey },
  });
  check("connect with token succeeds", connect.status === 200, String(connect.status));

  const wallet = await connecting;
  check("bridge reports the connected wallet", wallet.publicKey === publicKey, wallet.publicKey);

  const pendingSign = wallet.signMessage(new Uint8Array([1]), {
    label: "Approve upload signature",
    detail: "Signs the Arweave upload so this file can be stored.",
  });
  pendingSign.catch(() => undefined);
  const pendingJob = await send(`${origin}/api/pending?token=${token}`);
  const pendingBody = JSON.parse(pendingJob.body) as { label?: string; detail?: string };
  check(
    "pending request carries a label",
    pendingJob.status === 200 &&
      pendingBody.label === "Approve upload signature" &&
      Boolean(pendingBody.detail),
    pendingJob.body,
  );

  const closing = wallet.close();
  const finished = await send(`${origin}/api/pending?token=${token}`);
  check(
    "close() reports a finished bridge",
    finished.status === 200 && finished.body.includes('"finished":true'),
    `${finished.status} ${finished.body}`,
  );
  await closing;

  let closed = false;
  try {
    await send(`${origin}/?token=${token}`);
  } catch {
    closed = true;
  }
  check("server shuts down after close()", closed);
} catch (error) {
  console.log(`   ✗ unexpected error — ${String((error as Error).message ?? error)}`);
  failures.push("unexpected error");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n❌ Bridge security failed (${failures.length}): ${failures.join(", ")}`);
  process.exit(1);
}

console.log("\n✅ Bridge security passed");
