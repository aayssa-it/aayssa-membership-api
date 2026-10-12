export const MEMBERS_TABLE_ID =
  process.env.BASEROW_TABLE_ID;

export const PRIMARY_EMAIL_FIELD =
  "field_10464593";

let spouseEmailFieldKeyPromise;

export const VOLUNTEERS_TABLE_ID =
  process.env.BASEROW_VOLUNTEERS_TABLE_ID || "1179938";

export const VOLUNTEER_FIELDS = {
  name: "field_10642219",
  memberType: "field_10642220",
  active: "field_10642221",
  family: "field_10642228",
  relationship: "field_10642229",
  interested: "field_10642230",
  areas: "field_10642231",
  createdOn: "field_10642232",
  updatedOn: "field_10642234"
};

export const VOLUNTEER_MEMBER_TYPE_OPTIONS = {
  primary: 7582778,
  spouse: 7582779,
  additional: 7582780
};

export const VOLUNTEER_AREA_OPTIONS = {
  Bhajan: 7582773,
  Pooja: 7582774,
  Annadhanam: 7582775,
  Media: 7582776,
  Decorations: 7582777
};

export const VOLUNTEER_AREAS = [
  "Pooja",
  "Annadhanam",
  "Bhajan",
  "Media",
  "Decorations"
];

export function getBaserowBaseUrl() {
  return (process.env.BASEROW_URL || "https://api.baserow.io")
    .replace(/\/$/, "");
}

export function getBaserowHeaders() {
  const token =
    process.env.BASEROW_TOKEN;

  if (!token) {
    throw new Error("Missing BASEROW_TOKEN.");
  }

  return {
    Authorization: `Token ${token}`,
    "Content-Type": "application/json"
  };
}

export function assertServerConfig() {
  const missing = [];

  if (!process.env.SUPABASE_URL) {
    missing.push("SUPABASE_URL");
  }

  if (!process.env.SUPABASE_PUBLISHABLE_KEY) {
    missing.push("SUPABASE_PUBLISHABLE_KEY");
  }

  if (!process.env.BASEROW_TOKEN) {
    missing.push("BASEROW_TOKEN");
  }

  if (!MEMBERS_TABLE_ID) {
    missing.push("BASEROW_TABLE_ID");
  }

  if (!VOLUNTEERS_TABLE_ID) {
    missing.push("BASEROW_VOLUNTEERS_TABLE_ID");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}

export async function findMemberByEmail(email) {
  assertServerConfig();

  const normalizedEmail =
    String(email || "")
      .trim()
      .toLowerCase();

  if (!normalizedEmail) {
    return null;
  }

  const primaryMatch =
    await findMemberByField(
      PRIMARY_EMAIL_FIELD,
      normalizedEmail
    );

  if (primaryMatch) {
    return primaryMatch;
  }

  const spouseEmailFieldKey =
    await getSpouseEmailFieldKey();

  if (!spouseEmailFieldKey) {
    return null;
  }

  return findMemberByField(
    spouseEmailFieldKey,
    normalizedEmail
  );
}

export async function getSpouseEmailFieldKey() {
  const configuredField =
    String(
      process.env.BASEROW_SPOUSE_EMAIL_FIELD_ID || ""
    ).trim();

  if (configuredField) {
    return configuredField.startsWith("field_")
      ? configuredField
      : `field_${configuredField}`;
  }

  if (!spouseEmailFieldKeyPromise) {
    spouseEmailFieldKeyPromise =
      discoverSpouseEmailFieldKey();
  }

  return spouseEmailFieldKeyPromise;
}

export async function getSpouseEmail(memberRow) {
  const fieldKey =
    await getSpouseEmailFieldKey();

  return fieldKey
    ? cleanString(memberRow?.[fieldKey]).toLowerCase()
    : "";
}

async function findMemberByField(fieldKey, normalizedEmail) {
  const lookupUrl =
    `${getBaserowBaseUrl()}/api/database/rows/table/${MEMBERS_TABLE_ID}/` +
    `?user_field_names=false` +
    `&filter__${fieldKey}__equal=${encodeURIComponent(normalizedEmail)}`;

  const lookupResponse =
    await fetch(
      lookupUrl,
      {
        headers:
          getBaserowHeaders()
      }
    );

  if (!lookupResponse.ok) {
    console.error(
      "Member email lookup failed:",
      lookupResponse.status
    );

    throw new Error(
      "Unable to look up membership."
    );
  }

  const lookupData =
    await lookupResponse.json();

  return Array.isArray(lookupData.results) &&
    lookupData.results.length > 0
      ? lookupData.results[0]
      : null;
}

async function discoverSpouseEmailFieldKey() {
  assertServerConfig();

  const response = await fetch(
    `${getBaserowBaseUrl()}/api/database/fields/table/${MEMBERS_TABLE_ID}/`,
    { headers: getBaserowHeaders() }
  );

  if (!response.ok) {
    console.error(
      "Member field lookup failed:",
      response.status
    );
    throw new Error("Unable to load member fields.");
  }

  const fields = await response.json();
  const acceptedNames = new Set([
    "spouse email",
    "spouse email address",
    "secondary email",
    "secondary email address"
  ]);
  const spouseEmailField =
    Array.isArray(fields)
      ? fields.find(field =>
          acceptedNames.has(
            cleanString(field?.name).toLowerCase()
          )
        )
      : null;

  return spouseEmailField?.id
    ? `field_${spouseEmailField.id}`
    : null;
}

export async function getAuthenticatedMember(req) {
  assertServerConfig();

  const cookies =
    parseCookies(req.headers.cookie || "");

  const accessToken =
    cookies.aayssa_access;

  if (!accessToken) {
    return {
      status: 401,
      error: "Not authenticated."
    };
  }

  const userResponse =
    await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          apikey:
            process.env.SUPABASE_PUBLISHABLE_KEY,
          Authorization:
            `Bearer ${accessToken}`
        }
      }
    );

  if (!userResponse.ok) {
    return {
      status: 401,
      error: "Session expired."
    };
  }

  const user =
    await userResponse.json();

  if (!user?.email) {
    return {
      status: 401,
      error: "Authenticated email unavailable."
    };
  }

  const normalizedEmail =
    String(user.email)
      .trim()
      .toLowerCase();

  let memberRow;

  try {
    memberRow =
      await findMemberByEmail(normalizedEmail);
  } catch (error) {
    console.error("Authenticated member lookup failed:", error);
    return {
      status: 500,
      error: "Unable to load membership."
    };
  }

  if (!memberRow) {
    return {
      status: 403,
      error: "AAYSSA membership not found."
    };
  }

  return {
    status: 200,
    user,
    normalizedEmail,
    primaryEmail:
      cleanString(
        memberRow[PRIMARY_EMAIL_FIELD] ||
        memberRow.field_10281594
      ).toLowerCase(),
    memberRow
  };
}

export async function fetchFamilyVolunteerRows(memberRowId) {
  const url =
    `${getBaserowBaseUrl()}/api/database/rows/table/${VOLUNTEERS_TABLE_ID}/` +
    `?user_field_names=false` +
    `&filter__${VOLUNTEER_FIELDS.family}__link_row_has=${encodeURIComponent(memberRowId)}`;

  const response =
    await fetch(
      url,
      {
        headers:
          getBaserowHeaders()
      }
    );

  if (!response.ok) {
    console.error(
      "Baserow volunteer lookup failed:",
      response.status,
      await response.text()
    );

    throw new Error(
      "Unable to load volunteer records."
    );
  }

  const data =
    await response.json();

  return Array.isArray(data.results)
    ? data.results
    : [];
}

export async function createVolunteerRow(values) {
  const response =
    await fetch(
      `${getBaserowBaseUrl()}/api/database/rows/table/${VOLUNTEERS_TABLE_ID}/?user_field_names=false`,
      {
        method: "POST",
        headers:
          getBaserowHeaders(),
        body:
          JSON.stringify(values)
      }
    );

  if (!response.ok) {
    console.error(
      "Baserow volunteer creation failed:",
      response.status,
      await response.text()
    );

    throw new Error(
      "Unable to create volunteer record."
    );
  }

  return response.json();
}

export async function updateVolunteerRow(rowId, values) {
  const response =
    await fetch(
      `${getBaserowBaseUrl()}/api/database/rows/table/${VOLUNTEERS_TABLE_ID}/${rowId}/?user_field_names=false`,
      {
        method: "PATCH",
        headers:
          getBaserowHeaders(),
        body:
          JSON.stringify(values)
      }
    );

  if (!response.ok) {
    console.error(
      "Baserow volunteer update failed:",
      response.status,
      await response.text()
    );

    throw new Error(
      "Unable to update volunteer record."
    );
  }

  return response.json();
}

export async function updateMemberRow(rowId, values) {
  const response =
    await fetch(
      `${getBaserowBaseUrl()}/api/database/rows/table/${MEMBERS_TABLE_ID}/${rowId}/?user_field_names=false`,
      {
        method: "PATCH",
        headers:
          getBaserowHeaders(),
        body:
          JSON.stringify(values)
      }
    );

  if (!response.ok) {
    console.error(
      "Baserow member update failed:",
      response.status,
      await response.text()
    );

    throw new Error(
      "Unable to update member record."
    );
  }

  return response.json();
}

export function buildVolunteerPayload({
  familyRowId,
  name,
  memberType,
  relationship = "",
  interested = false,
  areas = [],
  active = true
}) {
  return {
    [VOLUNTEER_FIELDS.family]:
      [Number(familyRowId)],

    [VOLUNTEER_FIELDS.name]:
      cleanString(name),

    [VOLUNTEER_FIELDS.memberType]:
      getMemberTypeOption(memberType),

    [VOLUNTEER_FIELDS.relationship]:
      cleanString(relationship),

    [VOLUNTEER_FIELDS.interested]:
      Boolean(interested),

    [VOLUNTEER_FIELDS.areas]:
      sanitizeAreaOptions(areas),

    [VOLUNTEER_FIELDS.active]:
      Boolean(active)
  };
}

export function mapVolunteerRow(row) {
  const memberTypeValue =
    getSingleSelectValue(row[VOLUNTEER_FIELDS.memberType]);

  return {
    id:
      row.id,
    name:
      cleanString(row[VOLUNTEER_FIELDS.name]),
    memberType:
      normalizeMemberType(memberTypeValue),
    memberTypeLabel:
      displayMemberType(memberTypeValue),
    relationship:
      cleanString(row[VOLUNTEER_FIELDS.relationship]),
    interested:
      Boolean(row[VOLUNTEER_FIELDS.interested]),
    areas:
      getMultiSelectValues(row[VOLUNTEER_FIELDS.areas]),
    active:
      Boolean(row[VOLUNTEER_FIELDS.active])
  };
}

export function getPrimaryName(memberRow) {
  return `${memberRow.field_10227506 || ""} ${memberRow.field_10473214 || ""}`
    .trim();
}

export function getSpouseName(memberRow) {
  return `${memberRow.field_10227562 || ""} ${memberRow.field_10473216 || ""}`
    .trim();
}

export function cleanString(value) {
  return String(value ?? "")
    .trim();
}

export function getMultiSelectValues(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map(item => {
      if (typeof item === "string") {
        return item;
      }

      return (
        item?.value ||
        item?.name ||
        ""
      );
    })
    .filter(Boolean);
}

export function normalizeMemberType(value) {
  const normalized =
    cleanString(value)
      .toLowerCase();

  if (normalized === "primary") {
    return "primary";
  }

  if (normalized === "spouse") {
    return "spouse";
  }

  return "additional";
}

export function displayMemberType(value) {
  const memberType =
    normalizeMemberType(value);

  if (memberType === "primary") {
    return "Primary Member";
  }

  if (memberType === "spouse") {
    return "Spouse";
  }

  return "Additional Family Member";
}

export function sanitizeAreaOptions(areas) {
  const values =
    Array.isArray(areas)
      ? areas
      : [];

  return values
    .map(area =>
      cleanString(area)
    )
    .filter(area =>
      VOLUNTEER_AREAS.includes(area)
    )
    .map(area =>
      VOLUNTEER_AREA_OPTIONS[area]
    );
}

function getMemberTypeOption(memberType) {
  const normalized =
    normalizeMemberType(memberType);

  return VOLUNTEER_MEMBER_TYPE_OPTIONS[normalized];
}

function getSingleSelectValue(item) {
  if (
    item &&
    typeof item === "object"
  ) {
    return (
      item.value ||
      item.name ||
      ""
    );
  }

  return item || "";
}

function parseCookies(cookieHeader) {
  const cookies = {};

  cookieHeader.split(";").forEach(cookie => {
    const index = cookie.indexOf("=");

    if (index === -1) return;

    const key = cookie.slice(0, index).trim();
    const value = cookie.slice(index + 1).trim();

    if (key) {
      cookies[key] = decodeURIComponent(value);
    }
  });

  return cookies;
}
