#!/usr/bin/env node
/*
  Fill the AAYSSA_Donation_Campaigns table from Zeffy (first-time setup).

  Usage (from the repo root, with .env.local pulled from Vercel):
    npm run sync:zeffy-campaigns

  Adds one row for every active Zeffy campaign that is not in the table yet,
  with Show in App ticked and default amounts. Rows already in the table are
  left exactly as they are. Safe to run more than once.
*/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

loadEnvLocal();

// Imported after .env.local is loaded, because the module reads the table ID
// when it loads.
const { syncCampaignsFromZeffy } =
  await import("../api/_lib/campaigns.js");

try {
  const result =
    await syncCampaignsFromZeffy({ fresh: true });

  console.log(`Zeffy campaigns found: ${result.zeffyCampaigns.length}`);
  console.log(`Rows added to the table: ${result.added}`);
  console.log(`Rows in the table now: ${result.rows.length}`);
} catch (error) {
  console.error(`Sync failed: ${error.message}`);
  process.exit(1);
}

function loadEnvLocal() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, "..", ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}