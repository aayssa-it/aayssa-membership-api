import {
  cleanString,
  getAuthenticatedMember,
  getBaserowBaseUrl,
  getBaserowHeaders
} from "./aayssa.js";

/*
  App donation campaigns.

  Zeffy is the source of truth for campaigns, goals, amounts raised and
  the payment form. The Baserow "AAYSSA_Donation_Campaigns" table controls
  what the mobile app shows: visibility, featured, order, dates, copy,
  suggested amounts and an optional donation link override.

  Public:  GET  /api/register?resource=campaigns
  Admin:   GET | POST | PATCH  /api/admin-members?resource=app-campaigns
*/

const ZEFFY_API_BASE_URL =
  "https://api.zeffy.com/api/v1";

const TABLE_ID =
  process.env.BASEROW_APP_AAYSSA_Donation_Campaigns_TABLE_ID;

const TIME_ZONE =
  "America/New_York";

const ZEFFY_CACHE_MS =
  5 * 60 * 1000;

const DEFAULT_AMOUNTS =
  [51, 101, 251, 501];

export const FIELDS = {
  zeffyId: "Campaign ID",
  showInApp: "Show in App",
  featured: "Featured",
  sortOrder: "Sort Order",
  showFrom: "Show From",
  showUntil: "Show Until",
  appTitle: "App Title",
  shortDescription: "Short Description",
  suggestedAmounts: "Suggested Amounts",
  allowMonthly: "Allow Monthly",
  bannerImage: "Banner Image",
  donationUrl: "Donation"
};

let zeffyCache = {
  at: 0,
  campaigns: null
};

// ==========================================================
// Public endpoint (mobile Donate tab)
// ==========================================================

export async function handlePublicCampaigns(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    assertCampaignConfig();

    // Adds any new Zeffy campaign to the table first, so it shows
    // without anyone having to open the Admin screen.
    const { rows, zeffyCampaigns } =
      await syncCampaignsFromZeffy();

    const campaigns =
      buildPublicCampaigns(
        rows.map(mapCampaignRow),
        zeffyCampaigns,
        todayInTimeZone()
      );

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=120, stale-while-revalidate=600"
    );

    return res.status(200).json({
      success: true,
      campaigns
    });
  } catch (error) {
    console.error("Public campaigns error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load campaigns right now."
    });
  }
}

// ==========================================================
// Board / Admin endpoint (mobile admin screens)
// ==========================================================

export async function handleAdminCampaigns(req, res) {
  if (!["GET", "POST", "PATCH"].includes(req.method)) {
    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    const auth =
      await getAuthenticatedMember(req);

    if (auth.status !== 200) {
      return res.status(auth.status).json({
        success: false,
        message: auth.error
      });
    }

    if (!hasBoardAccess(auth.memberRow)) {
      return res.status(403).json({
        success: false,
        message: "Board or administrator access required."
      });
    }

    assertCampaignConfig();

    if (req.method === "GET") {
      const sync =
        await syncCampaignsFromZeffy({ fresh: true });

      return res.status(200).json({
        success: true,
        ...buildAdminView(
          sync.rows.map(mapCampaignRow),
          sync.zeffyCampaigns,
          todayInTimeZone()
        ),
        addedFromZeffy: sync.added,
        syncedAt: new Date().toISOString()
      });
    }

    if (req.method === "POST") {
      return addCampaignToApp(req, res);
    }

    if (req.body?.action === "reorder") {
      return reorderCampaigns(req, res);
    }

    return updateCampaign(req, res);
  } catch (error) {
    console.error("Admin campaigns error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to update app campaigns right now."
    });
  }
}

async function addCampaignToApp(req, res) {
  const zeffyId =
    cleanString(req.body?.zeffyCampaignId);

  if (!zeffyId) {
    return badRequest(res, "Select a Zeffy campaign.");
  }

  const [zeffyCampaigns, rows] =
    await Promise.all([
      getZeffyCampaigns({ fresh: true }),
      fetchAllCampaignRows()
    ]);

  const zeffy =
    zeffyCampaigns.find(campaign => campaign.id === zeffyId);

  if (!zeffy) {
    return badRequest(res, "That campaign was not found in Zeffy.");
  }

  const mapped =
    rows.map(mapCampaignRow);

  if (mapped.some(row => row.zeffyId === zeffyId)) {
    return badRequest(res, "That campaign is already in the app.");
  }

  const created =
    await baserowRequest(
      `/api/database/rows/table/${TABLE_ID}/?user_field_names=true`,
      {
        method: "POST",
        body: JSON.stringify(
          newCampaignRow(zeffy, nextSortOrder(mapped))
        )
      }
    );

  return res.status(201).json({
    success: true,
    campaign: mergeAdminCampaign(
      mapCampaignRow(created),
      zeffy,
      todayInTimeZone()
    )
  });
}

async function updateCampaign(req, res) {
  const id =
    Number(req.body?.id);

  if (!Number.isInteger(id) || id <= 0) {
    return badRequest(res, "Select a valid campaign.");
  }

  const result =
    buildCampaignUpdate(req.body || {});

  if (result.error) {
    return badRequest(res, result.error);
  }

  if (Object.keys(result.values).length === 0) {
    return badRequest(res, "Nothing to update.");
  }

  // Only one campaign can be featured at a time.
  if (result.values[FIELDS.featured] === true) {
    const rows =
      (await fetchAllCampaignRows()).map(mapCampaignRow);

    await Promise.all(
      rows
        .filter(row => row.featured && row.id !== id)
        .map(row =>
          patchCampaignRow(row.id, { [FIELDS.featured]: false })
        )
    );
  }

  const updated =
    await patchCampaignRow(id, result.values);

  return res.status(200).json({
    success: true,
    campaign: mapCampaignRow(updated)
  });
}

async function reorderCampaigns(req, res) {
  const ids =
    Array.isArray(req.body?.ids)
      ? req.body.ids.map(Number)
      : [];

  if (
    ids.length === 0 ||
    ids.length > 200 ||
    ids.some(id => !Number.isInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length
  ) {
    return badRequest(res, "Send the campaigns in their new order.");
  }

  const existing =
    new Set(
      (await fetchAllCampaignRows()).map(row => Number(row.id))
    );

  if (ids.some(id => !existing.has(id))) {
    return badRequest(res, "One or more campaigns no longer exist.");
  }

  await baserowRequest(
    `/api/database/rows/table/${TABLE_ID}/batch/?user_field_names=true`,
    {
      method: "PATCH",
      body: JSON.stringify({
        items: ids.map((id, index) => ({
          id,
          [FIELDS.sortOrder]: index + 1
        }))
      })
    }
  );

  return res.status(200).json({
    success: true
  });
}

// ==========================================================
// Pure helpers (unit tested in tests/campaigns.test.mjs)
// ==========================================================

export function mapCampaignRow(row) {
  const image =
    Array.isArray(row?.[FIELDS.bannerImage])
      ? row[FIELDS.bannerImage][0]
      : null;

  const sortOrder =
    Number(row?.[FIELDS.sortOrder]);

  return {
    id: Number(row?.id),
    zeffyId: cleanString(row?.[FIELDS.zeffyId]),
    showInApp: Boolean(row?.[FIELDS.showInApp]),
    featured: Boolean(row?.[FIELDS.featured]),
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : null,
    showFrom: toDateOnly(row?.[FIELDS.showFrom]),
    showUntil: toDateOnly(row?.[FIELDS.showUntil]),
    appTitle: cleanString(row?.[FIELDS.appTitle]),
    shortDescription: cleanString(row?.[FIELDS.shortDescription]),
    suggestedAmounts: parseAmounts(row?.[FIELDS.suggestedAmounts]),
    allowMonthly: row?.[FIELDS.allowMonthly] === undefined
      ? true
      : Boolean(row?.[FIELDS.allowMonthly]),
    imageUrl: cleanString(
      image?.thumbnails?.card_cover?.url ||
      image?.url
    ),
    donationUrl: safeDonationUrl(row?.[FIELDS.donationUrl])
  };
}

export function mapZeffyCampaign(campaign) {
  const id =
    cleanString(campaign?.id);

  const title =
    cleanString(
      campaign?.title ??
      campaign?.name
    );

  const goal =
    firstNumber(
      campaign?.goal,
      campaign?.goal_amount,
      campaign?.target_amount
    );

  const raised =
    firstNumber(
      campaign?.amount_raised,
      campaign?.total_raised,
      campaign?.raised_amount,
      campaign?.total_amount,
      campaign?.volume
    );

  return {
    id,
    title,
    description: plainText(
      campaign?.description ??
      campaign?.short_description
    ).slice(0, 600),
    goal: goal === null ? null : centsToDollars(goal),
    raised: raised === null ? null : centsToDollars(raised),
    currency: cleanString(campaign?.currency || "USD").toUpperCase(),
    type: cleanString(campaign?.type).toLowerCase(),
    bannerUrl: safeImageUrl(campaign?.banner_url),
    url: safeDonationUrl(
      campaign?.url ??
      campaign?.form_url ??
      campaign?.public_url ??
      campaign?.link
    ),
    archived: Boolean(
      campaign?.archived ||
      campaign?.is_archived ||
      campaign?.deleted_at ||
      ["archived", "closed", "deleted"].includes(
        cleanString(campaign?.status).toLowerCase()
      )
    )
  };
}

export function buildPublicCampaigns(rows, zeffyCampaigns, today) {
  const zeffyById =
    new Map(zeffyCampaigns.map(campaign => [campaign.id, campaign]));

  return sortCampaigns(
    rows
      .filter(row => row.showInApp)
      .filter(row => isWithinWindow(row, today))
      .map(row => {
        const zeffy =
          zeffyById.get(row.zeffyId);

        if (!zeffy || zeffy.archived) {
          return null;
        }

        const donateUrl =
          row.donationUrl || zeffy.url;

        if (!donateUrl) {
          return null;
        }

        return {
          id: row.id,
          title: row.appTitle || zeffy.title,
          description: row.shortDescription || zeffy.description,
          goal: zeffy.goal,
          raised: zeffy.raised,
          currency: zeffy.currency,
          featured: row.featured,
          sortOrder: row.sortOrder,
          showUntil: row.showUntil,
          suggestedAmounts: row.suggestedAmounts.length
            ? row.suggestedAmounts
            : DEFAULT_AMOUNTS,
          allowMonthly: row.allowMonthly,
          imageUrl: row.imageUrl || zeffy.bannerUrl || null,
          donateUrl
        };
      })
      .filter(Boolean)
  ).map(({ sortOrder, ...campaign }) => campaign);
}

export function buildAdminView(rows, zeffyCampaigns, today) {
  const zeffyById =
    new Map(zeffyCampaigns.map(campaign => [campaign.id, campaign]));

  const inApp =
    new Set(rows.map(row => row.zeffyId));

  return {
    campaigns: sortCampaigns(
      rows.map(row =>
        mergeAdminCampaign(row, zeffyById.get(row.zeffyId), today)
      )
    ),
    availableInZeffy: zeffyCampaigns
      .filter(campaign => !campaign.archived && !inApp.has(campaign.id))
      .map(campaign => ({
        zeffyId: campaign.id,
        title: campaign.title,
        goal: campaign.goal,
        raised: campaign.raised,
        hasDonationUrl: Boolean(campaign.url)
      }))
  };
}

export function mergeAdminCampaign(row, zeffy, today) {
  const live =
    row.showInApp &&
    isWithinWindow(row, today) &&
    Boolean(zeffy) &&
    !zeffy.archived &&
    Boolean(row.donationUrl || zeffy?.url);

  return {
    ...row,
    zeffyTitle: zeffy?.title || "",
    goal: zeffy?.goal ?? null,
    raised: zeffy?.raised ?? null,
    zeffyFound: Boolean(zeffy),
    zeffyDonationUrl: zeffy?.url || null,
    liveInApp: live
  };
}

export function sortCampaigns(campaigns) {
  return campaigns.slice().sort((left, right) => {
    if (left.featured !== right.featured) {
      return left.featured ? -1 : 1;
    }

    const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return String(left.title || left.appTitle || "")
      .localeCompare(String(right.title || right.appTitle || ""));
  });
}

export function isWithinWindow(row, today) {
  if (row.showFrom && today < row.showFrom) {
    return false;
  }

  if (row.showUntil && today > row.showUntil) {
    return false;
  }

  return true;
}

export function parseAmounts(value) {
  const parts =
    Array.isArray(value)
      ? value
      : cleanString(value).split(/[,\s]+/);

  const amounts =
    parts
      .map(part => Number(String(part).replace(/[$\s]/g, "")))
      .filter(amount => Number.isFinite(amount) && amount > 0 && amount <= 100000)
      .map(amount => Math.round(amount * 100) / 100);

  return Array.from(new Set(amounts)).slice(0, 6);
}

export function safeDonationUrl(value) {
  const text =
    cleanString(value);

  if (!text) {
    return "";
  }

  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    const allowed =
      host === "zeffy.com" ||
      host.endsWith(".zeffy.com") ||
      host === "atlantaayyappasevasangam.org" ||
      host.endsWith(".atlantaayyappasevasangam.org");

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !allowed
    ) {
      return "";
    }

    return url.href;
  } catch {
    return "";
  }
}

export function buildCampaignUpdate(body) {
  const values = {};

  if ("showInApp" in body) {
    values[FIELDS.showInApp] = Boolean(body.showInApp);
  }

  if ("featured" in body) {
    values[FIELDS.featured] = Boolean(body.featured);
  }

  if ("allowMonthly" in body) {
    values[FIELDS.allowMonthly] = Boolean(body.allowMonthly);
  }

  if ("appTitle" in body) {
    const title = cleanString(body.appTitle).slice(0, 80);
    if (!title) {
      return { error: "Enter an app title." };
    }
    values[FIELDS.appTitle] = title;
  }

  if ("shortDescription" in body) {
    values[FIELDS.shortDescription] =
      cleanString(body.shortDescription).slice(0, 400);
  }

  if ("suggestedAmounts" in body) {
    const amounts = parseAmounts(body.suggestedAmounts);
    if (amounts.length === 0) {
      return { error: "Enter at least one suggested amount." };
    }
    values[FIELDS.suggestedAmounts] = amounts.join(", ");
  }

  for (const key of ["showFrom", "showUntil"]) {
    if (key in body) {
      const text = cleanString(body[key]);
      if (text && !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return { error: "Use dates in YYYY-MM-DD format." };
      }
      values[FIELDS[key]] = text || null;
    }
  }

  const from = values[FIELDS.showFrom];
  const until = values[FIELDS.showUntil];
  if (from && until && from > until) {
    return { error: "Show from must be on or before show until." };
  }

  if ("donationUrl" in body) {
    const text = cleanString(body.donationUrl);
    const url = safeDonationUrl(text);
    if (text && !url) {
      return { error: "Donation link must be an https zeffy.com address." };
    }
    values[FIELDS.donationUrl] = url;
  }

  return { values };
}

export function todayInTimeZone(date = new Date()) {
  const parts =
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);

  const get = type => parts.find(part => part.type === type)?.value;

  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ==========================================================
// Automatic sync: Zeffy campaigns -> Baserow table
// ==========================================================
//
// Every active (not archived) Zeffy campaign that has no row in the table
// gets one, created VISIBLE (Show in App = true) with default amounts.
// The Board can then edit it or switch it off. Existing rows are never
// changed or deleted, so Board edits (including "hidden") stay as set.
// To keep a campaign out of the app, untick Show in App; do not delete the
// row, or the next sync adds it back. Runs when the Donate tab or Admin
// screen loads, and from `npm run sync:zeffy-campaigns` for the first fill.

let syncInFlight = null;

export function syncCampaignsFromZeffy({ fresh = false } = {}) {
  if (fresh && !syncInFlight) {
    zeffyCache = { at: 0, campaigns: null };
  }

  // One sync at a time per server instance, so two quick refreshes
  // do not create the same row twice.
  if (!syncInFlight) {
    syncInFlight =
      runCampaignSync().finally(() => {
        syncInFlight = null;
      });
  }

  return syncInFlight;
}

async function runCampaignSync() {
  assertCampaignConfig();

  const [zeffyCampaigns, rows] =
    await Promise.all([
      getZeffyCampaigns(),
      fetchAllCampaignRows()
    ]);

  const toCreate =
    campaignRowsToCreate(rows.map(mapCampaignRow), zeffyCampaigns);

  if (!toCreate.length) {
    return { added: 0, rows, zeffyCampaigns };
  }

  const created = [];

  try {
    for (let i = 0; i < toCreate.length; i += 200) {
      const data =
        await baserowRequest(
          `/api/database/rows/table/${TABLE_ID}/batch/?user_field_names=true`,
          {
            method: "POST",
            body: JSON.stringify({ items: toCreate.slice(i, i + 200) })
          }
        );

      created.push(...(data.items || []));
    }
  } catch (error) {
    // The Admin screen still opens with what is already in the table.
    console.error("Campaign sync could not add rows:", error.message);
  }

  return {
    added: created.length,
    rows: [...rows, ...created],
    zeffyCampaigns
  };
}

export function campaignRowsToCreate(existingRows, zeffyCampaigns) {
  const known =
    new Set(existingRows.map(row => row.zeffyId));

  let order =
    nextSortOrder(existingRows);

  const items = [];

  for (const campaign of zeffyCampaigns) {
    if (
      !campaign.id ||
      campaign.archived ||
      known.has(campaign.id) ||
      !isDonationType(campaign.type)
    ) {
      continue;
    }

    known.add(campaign.id);
    items.push(newCampaignRow(campaign, order));
    order += 1;
  }

  return items;
}

function newCampaignRow(zeffy, sortOrder) {
  return {
    [FIELDS.zeffyId]: zeffy.id,
    [FIELDS.showInApp]: true,
    [FIELDS.featured]: false,
    [FIELDS.sortOrder]: sortOrder,
    [FIELDS.appTitle]: zeffy.title || "",
    [FIELDS.suggestedAmounts]: DEFAULT_AMOUNTS.join(", "),
    [FIELDS.allowMonthly]: true
  };
}

// Only donation forms are added automatically. Event tickets, memberships
// and other Zeffy form types stay out unless an admin adds them with
// "Add to app". An empty type is treated as a donation form.
export function isDonationType(type) {
  return !type || type.includes("donation") || type.includes("peer");
}

function nextSortOrder(rows) {
  return rows.reduce(
    (max, row) => Math.max(max, row.sortOrder ?? 0),
    0
  ) + 1;
}

// ==========================================================
// Zeffy and Baserow access
// ==========================================================

async function getZeffyCampaigns({ fresh = false } = {}) {
  if (
    !fresh &&
    zeffyCache.campaigns &&
    Date.now() - zeffyCache.at < ZEFFY_CACHE_MS
  ) {
    return zeffyCache.campaigns;
  }

  const campaigns =
    (await fetchZeffyPages("/campaigns"))
      .map(mapZeffyCampaign)
      .filter(campaign => campaign.id);

  zeffyCache = {
    at: Date.now(),
    campaigns
  };

  return campaigns;
}

async function fetchZeffyPages(path) {
  const rows = [];
  let cursor = "";
  let pages = 0;

  do {
    const url =
      new URL(`${ZEFFY_API_BASE_URL}${path}`);

    url.searchParams.set("limit", "100");

    if (cursor) {
      url.searchParams.set("starting_after", cursor);
    }

    const response =
      await fetch(url, {
        headers: {
          Authorization: `Bearer ${process.env.ZEFFY_API_KEY}`
        }
      });

    if (!response.ok) {
      console.error("Zeffy API request failed:", response.status, path);
      throw new Error("Unable to load Zeffy campaigns.");
    }

    const data =
      await response.json();

    if (Array.isArray(data.data)) {
      rows.push(...data.data);
    }

    cursor =
      data.has_more && data.next_cursor
        ? data.next_cursor
        : "";

    pages += 1;
  } while (cursor && pages < 20);

  return rows;
}

async function fetchAllCampaignRows() {
  const rows = [];
  let page = 1;

  while (page <= 20) {
    const data =
      await baserowRequest(
        `/api/database/rows/table/${TABLE_ID}/?user_field_names=true&size=200&page=${page}`
      );

    rows.push(...(data.results || []));

    if (!data.next) {
      break;
    }

    page += 1;
  }

  return rows.filter(row => cleanString(row[FIELDS.zeffyId]));
}

async function patchCampaignRow(id, values) {
  return baserowRequest(
    `/api/database/rows/table/${TABLE_ID}/${id}/?user_field_names=true`,
    {
      method: "PATCH",
      body: JSON.stringify(values)
    }
  );
}

async function baserowRequest(path, options = {}) {
  const response =
    await fetch(`${getBaserowBaseUrl()}${path}`, {
      ...options,
      headers: getBaserowHeaders()
    });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("Baserow campaigns request failed:", response.status, detail.slice(0, 300));
    throw new Error("Baserow campaigns request failed.");
  }

  return response.json();
}

function assertCampaignConfig() {
  const missing = [];

  if (!TABLE_ID) {
    missing.push("BASEROW_APP_AAYSSA_Donation_Campaigns_TABLE_ID");
  }

  if (!process.env.ZEFFY_API_KEY) {
    missing.push("ZEFFY_API_KEY");
  }

  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

function hasBoardAccess(memberRow) {
  const role = memberRow?.field_10493689;
  const id = Number(role?.id ?? role);
  const name = cleanString(role?.value).toLowerCase();
  return id === 7473605 || id === 7473606 || name === "board" || name === "admin";
}

function safeImageUrl(value) {
  const text = cleanString(value);

  try {
    return new URL(text).protocol === "https:" ? text : "";
  } catch {
    return "";
  }
}

function toDateOnly(value) {
  const text = cleanString(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const amount =
      typeof value === "object" && value !== null
        ? Number(value.amount ?? value.value)
        : Number(value);

    if (value !== undefined && value !== null && value !== "" && Number.isFinite(amount)) {
      return amount;
    }
  }

  return null;
}

function centsToDollars(value) {
  return Math.round(Number(value || 0)) / 100;
}

function plainText(value) {
  return cleanString(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function badRequest(res, message) {
  return res.status(400).json({ success: false, message });
}