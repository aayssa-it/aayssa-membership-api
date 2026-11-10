#!/usr/bin/env node
/*
  Local API server for testing, without `vercel dev`.

  Usage (from the repo root, with real values in .env.local):
    node scripts/dev-local.mjs            (listens on 0.0.0.0:3000)
    node scripts/dev-local.mjs 3001       (another port)

  Serves every file in api/ the same way Vercel does:
    /api/register?resource=campaigns  ->  api/register.js (default export)

  Adds the small helpers the handlers use (req.query, req.body,
  res.status().json()). Local testing only; not deployed (Vercel ignores
  scripts/), and it never changes any data by itself.
*/

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2]) || 3000;

loadEnvLocal();

const handlers = new Map();

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, "http://localhost");

  addResponseHelpers(res);

  // Lets the Expo web preview (a different port) call this local API.
  // Local testing only; the real API on Vercel is unchanged.
  if (req.headers.origin) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Client");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  }

  res.on("finish", () => {
    console.log(`${req.method} ${url.pathname}${url.search} -> ${res.statusCode} (${Date.now() - started} ms)`);
  });


  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  const match = url.pathname.match(/^\/api\/([a-z0-9-]+)\/?$/i);
  const file = match && path.join(root, "api", `${match[1]}.js`);

  if (!file || !fs.existsSync(file)) {
    return res.status(404).json({ success: false, message: "No such API route." });
  }

  try {
    req.query = Object.fromEntries(url.searchParams);
    req.body = await readBody(req);

    if (!handlers.has(file)) {
      handlers.set(file, (await import(pathToFileURL(file).href)).default);
    }

    await handlers.get(file)(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "Local server error (see terminal)." });
    }
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`AAYSSA API running locally on port ${port}`);
  console.log(`  Laptop:  http://localhost:${port}/api/register?resource=campaigns`);
  console.log(`  Phone:   http://<your laptop IPv4>:${port}/...  (same Wi-Fi)`);
  console.log("Press Ctrl+C to stop.\n");
});

function addResponseHelpers(res) {
  res.status = code => {
    res.statusCode = code;
    return res;
  };

  res.json = body => {
    if (!res.getHeader("Content-Type")) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify(body));
    return res;
  };

  res.send = body => {
    if (body !== null && typeof body === "object" && !Buffer.isBuffer(body)) {
      return res.json(body);
    }
    res.end(body);
    return res;
  };
}

async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }

  const type = String(req.headers["content-type"] || "");

  if (type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function loadEnvLocal() {
  const file = path.join(root, ".env.local");
  if (!fs.existsSync(file)) {
    console.warn("No .env.local found in the repo root; API calls will fail.");
    return;
  }
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}