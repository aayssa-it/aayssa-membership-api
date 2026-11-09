import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdminView,
  buildCampaignUpdate,
  buildPublicCampaigns,
  campaignRowsToCreate,
  isDonationType,
  FIELDS,
  isWithinWindow,
  mapCampaignRow,
  mapZeffyCampaign,
  parseAmounts,
  safeDonationUrl,
  todayInTimeZone
} from "../api/_lib/campaigns.js";

const zeffy = [
  mapZeffyCampaign({ id: "z1", title: "Sastha Preethi", goal: 500000, amount_raised: 125050, url: "https://www.zeffy.com/en-US/donation-form/sastha" }),
  mapZeffyCampaign({ id: "z2", title: "Annadhanam", url: "https://www.zeffy.com/en-US/donation-form/anna" }),
  mapZeffyCampaign({ id: "z3", title: "Old drive", status: "archived", url: "https://www.zeffy.com/x" }),
  mapZeffyCampaign({ id: "z4", title: "No link yet" })
];

function row(values) {
  return mapCampaignRow({ id: values.id, ...Object.fromEntries(
    Object.entries(values).filter(([key]) => key !== "id").map(([key, value]) => [FIELDS[key], value])
  ) });
}

test("maps Zeffy amounts from cents to dollars", () => {
  assert.equal(zeffy[0].goal, 5000);
  assert.equal(zeffy[0].raised, 1250.5);
  assert.equal(zeffy[1].goal, null);
  assert.equal(zeffy[2].archived, true);
});

test("public list: only shown, in-window, linked campaigns; featured first then sort order", () => {
  const rows = [
    row({ id: 1, zeffyId: "z2", showInApp: true, sortOrder: 1 }),
    row({ id: 2, zeffyId: "z1", showInApp: true, sortOrder: 5, featured: true, suggestedAmounts: "21, 51" }),
    row({ id: 3, zeffyId: "z2", showInApp: false, sortOrder: 0 }),
    row({ id: 4, zeffyId: "z3", showInApp: true }),
    row({ id: 5, zeffyId: "z4", showInApp: true }),
    row({ id: 6, zeffyId: "z1", showInApp: true, showUntil: "2026-10-31" }),
    row({ id: 7, zeffyId: "missing", showInApp: true })
  ];

  const result = buildPublicCampaigns(rows, zeffy, "2026-11-02");

  assert.deepEqual(result.map(c => c.id), [2, 1]);
  assert.deepEqual(result[0].suggestedAmounts, [21, 51]);
  assert.deepEqual(result[1].suggestedAmounts, [51, 101, 251, 501]);
  assert.equal(result[0].donateUrl, "https://www.zeffy.com/en-US/donation-form/sastha");
  assert.equal("sortOrder" in result[0], false);
});

test("donation link override in Baserow wins over Zeffy link", () => {
  const rows = [row({ id: 1, zeffyId: "z4", showInApp: true, donationUrl: "https://www.zeffy.com/en-US/donation-form/custom" })];
  const result = buildPublicCampaigns(rows, zeffy, "2026-11-02");
  assert.equal(result[0].donateUrl, "https://www.zeffy.com/en-US/donation-form/custom");
});

test("admin view lists Zeffy campaigns not yet in the app", () => {
  const rows = [row({ id: 1, zeffyId: "z1", showInApp: true })];
  const view = buildAdminView(rows, zeffy, "2026-11-02");
  assert.equal(view.campaigns[0].liveInApp, true);
  assert.deepEqual(view.availableInZeffy.map(c => c.zeffyId), ["z2", "z4"]);
});

test("date window is inclusive", () => {
  const r = { showFrom: "2026-11-01", showUntil: "2026-11-30" };
  assert.equal(isWithinWindow(r, "2026-11-01"), true);
  assert.equal(isWithinWindow(r, "2026-11-30"), true);
  assert.equal(isWithinWindow(r, "2026-12-01"), false);
  assert.equal(isWithinWindow(r, "2026-10-31"), false);
});

test("amount parsing", () => {
  assert.deepEqual(parseAmounts("$51, 101 251,abc,-5,0"), [51, 101, 251]);
  assert.deepEqual(parseAmounts([10, "20"]), [10, 20]);
  assert.deepEqual(parseAmounts(""), []);
});

test("donation links must be https Zeffy or AAYSSA", () => {
  assert.equal(safeDonationUrl("https://www.zeffy.com/a"), "https://www.zeffy.com/a");
  assert.equal(safeDonationUrl("http://www.zeffy.com/a"), "");
  assert.equal(safeDonationUrl("https://evil.example/zeffy.com"), "");
  assert.equal(safeDonationUrl("https://user:pw@zeffy.com/a"), "");
  assert.equal(safeDonationUrl("javascript:alert(1)"), "");
});

test("admin update validation", () => {
  assert.equal(buildCampaignUpdate({ appTitle: "  " }).error, "Enter an app title.");
  assert.equal(buildCampaignUpdate({ suggestedAmounts: "abc" }).error, "Enter at least one suggested amount.");
  assert.equal(buildCampaignUpdate({ showFrom: "11/01/2026" }).error, "Use dates in YYYY-MM-DD format.");
  assert.equal(buildCampaignUpdate({ showFrom: "2026-12-01", showUntil: "2026-11-01" }).error, "Show from must be on or before show until.");
  assert.equal(buildCampaignUpdate({ donationUrl: "https://paypal.com/x" }).error, "Donation link must be an https zeffy.com address.");

  const ok = buildCampaignUpdate({ showInApp: true, featured: false, suggestedAmounts: [51, 101], showUntil: "" });
  assert.deepEqual(ok.values, {
    [FIELDS.showInApp]: true,
    [FIELDS.featured]: false,
    [FIELDS.suggestedAmounts]: "51, 101",
    [FIELDS.showUntil]: null
  });
});

test("today is computed in Eastern time", () => {
  assert.equal(todayInTimeZone(new Date("2026-11-03T03:30:00Z")), "2026-11-02");
});


test("sync adds only new, active Zeffy campaigns, visible, after existing order", () => {
  const existing = [
    mapCampaignRow({ id: 1, [FIELDS.zeffyId]: "z1", [FIELDS.showInApp]: false, [FIELDS.sortOrder]: "4" })
  ];

  const items = campaignRowsToCreate(existing, zeffy);

  // z1 is already there, z3 is archived; z2 and z4 are new.
  assert.deepEqual(items.map(item => item[FIELDS.zeffyId]), ["z2", "z4"]);
  assert.equal(items[1][FIELDS.sortOrder], 6);
  assert.equal(items[0][FIELDS.showInApp], true);
  assert.equal(items[0][FIELDS.sortOrder], 5);
  assert.equal(items[0][FIELDS.appTitle], "Annadhanam");
  assert.equal(items[0][FIELDS.suggestedAmounts], "51, 101, 251, 501");
});

test("sync leaves the table alone when every campaign is already there", () => {
  const existing = ["z1", "z2", "z4"].map((id, i) =>
    mapCampaignRow({ id: i + 1, [FIELDS.zeffyId]: id, [FIELDS.sortOrder]: String(i + 1) })
  );

  assert.deepEqual(campaignRowsToCreate(existing, zeffy), []);
});


test("reads Zeffy's real field names: volume, banner, deleted, type", () => {
  const campaign = mapZeffyCampaign({
    id: "e62f", title: "AAYSSA Temple Fund", type: "donation_form", status: "active",
    url: "https://www.zeffy.com/donation-form/aayssa-temple-development",
    banner_url: "https://res.cloudinary.com/x/banner.png",
    goal_amount: null, currency: "usd", volume: 10000, is_archived: false, deleted_at: null
  });

  assert.equal(campaign.raised, 100);
  assert.equal(campaign.goal, null);
  assert.equal(campaign.currency, "USD");
  assert.equal(campaign.bannerUrl, "https://res.cloudinary.com/x/banner.png");
  assert.equal(campaign.archived, false);
  assert.equal(mapZeffyCampaign({ id: "d", deleted_at: 1791838181 }).archived, true);

  const [shown] = buildPublicCampaigns(
    [mapCampaignRow({ id: 1, [FIELDS.zeffyId]: "e62f", [FIELDS.showInApp]: true })],
    [campaign],
    "2026-11-04"
  );
  assert.equal(shown.imageUrl, "https://res.cloudinary.com/x/banner.png");
});

test("only donation forms are added automatically", () => {
  assert.equal(isDonationType("donation_form"), true);
  assert.equal(isDonationType("peer_to_peer"), true);
  assert.equal(isDonationType(""), true);
  assert.equal(isDonationType("ticketing"), false);
  assert.equal(isDonationType("membership"), false);
});
