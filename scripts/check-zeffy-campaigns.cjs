#!/usr/bin/env node
/*
  Read-only check of what Zeffy's Campaigns API returns for AAYSSA.

  Usage (from the repo root, with ZEFFY_API_KEY in .env.local or the shell):
    npm run check:zeffy-campaigns

  Prints each campaign's id, title and the field names Zeffy sends, so the
  team can confirm which field holds the public donation-form link and
  whether amounts are in cents. Prints no payment or donor data.
*/

const fs = require("node:fs");
const path = require("node:path");

loadEnvLocal();

const key = process.env.ZEFFY_API_KEY;

if (!key) {
  console.error("ZEFFY_API_KEY is not set. Add it to .env.local or your shell.");
  process.exit(1);
}

(async () => {
  const response = await fetch("https://api.zeffy.com/api/v1/campaigns?limit=100", {
    headers: { Authorization: `Bearer ${key}` }
  });

  if (!response.ok) {
    console.error(`Zeffy returned HTTP ${response.status}.`);
    process.exit(1);
  }

  const data = await response.json();
  const campaigns = Array.isArray(data.data) ? data.data : [];

  console.log(`Campaigns returned: ${campaigns.length}${data.has_more ? " (more pages exist)" : ""}\n`);

  for (const campaign of campaigns) {
    console.log(`- ${campaign.id}  ${campaign.title || campaign.name || "(no title)"}`);
  }

  if (campaigns[0]) {
    console.log("\nFields on the first campaign:");
    for (const [field, value] of Object.entries(campaigns[0])) {
      const preview = typeof value === "object" ? JSON.stringify(value) : String(value);
      console.log(`  ${field}: ${preview.slice(0, 120)}`);
    }
  }
})().catch(error => {
  console.error("Check failed:", error.message);
  process.exit(1);
});

function loadEnvLocal() {
  const file = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}
