import {
  cleanString,
  getAuthenticatedMember,
  getBaserowBaseUrl,
  getBaserowHeaders
} from "./aayssa.js";
import {
  fetchAllMaaladharanRegistrations,
  fetchFamilyMaaladharanRegistrations
} from "./maaladharan.js";

const TABLE_ID = process.env.BASEROW_IRUMUDI_TABLE_ID || "1342788";
const SEASON = "2026-27 Mandalam";

const FIELDS = {
  name: 12589405,
  familyId: 12589406,
  maaladharanId: 12589407,
  season: 12589409,
  participantName: 12589410,
  category: 12589411,
  gender: 12589412,
  phone: 12589413,
  email: 12589414,
  priorPadi: 12589415,
  currentPadi: 12589416,
  participation: 12589433,
  agreement: 12589435,
  source: 12589437,
  status: 12589439,
  notes: 12589440,
  age: 12589441
};

const PARTICIPATION = [
  "Tampa with Irumudi",
  "Tampa without Irumudi",
  "AAYSSA Irumudi"
];
const CATEGORIES = ["Swamy", "Non-Swamy"];
const GENDERS = ["Male", "Female", "Other", "Prefer not to say"];

export async function handleMemberIrumudi(req, res) {
  if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method)) {
    return res.status(405).json({ success: false, message: "Method not allowed." });
  }

  try {
    const auth = await getAuthenticatedMember(req);
    if (auth.status !== 200) {
      return res.status(auth.status).json({ success: false, message: auth.error });
    }

    const familyId = Number(auth.memberRow.id);
    const registrations = (await fetchFamilyMaaladharanRegistrations(auth))
      .filter(item => item.status !== "Cancelled");

    if (req.method === "GET") {
      const records = await fetchRowsByFamily(familyId);
      return res.status(200).json(buildMemberResponse(registrations, records, familyId));
    }

    if (req.method === "DELETE") {
      const id = positiveInteger(req.body?.id);
      const existing = (await fetchRowsByFamily(familyId))
        .find(item => item.id === id);
      if (!existing) return res.status(404).json({ success: false, message: "Irumudi response not found." });
      if (existing.maaladharanId) {
        return res.status(400).json({ success: false, message: "Maaladharan Swamies can be updated but not removed here." });
      }
      await patchRow(id, { [key("status")]: "Cancelled" });
    } else {
      const input = normalizeInput(req.body);
      const registration = input.maaladharanId
        ? registrations.find(item => Number(item.id) === input.maaladharanId)
        : null;
      if (input.maaladharanId && !registration) {
        return res.status(404).json({ success: false, message: "Maaladharan registration not found." });
      }
      const normalized = registration
        ? mergeRegistration(input, registration, auth.normalizedEmail)
        : input;
      const validationError = validateInput(normalized);
      if (validationError) return res.status(400).json({ success: false, message: validationError });

      const existingRows = await fetchRowsByFamily(familyId);
      const existing = input.id
        ? existingRows.find(item => item.id === input.id)
        : input.maaladharanId
          ? existingRows.find(item => item.maaladharanId === input.maaladharanId)
          : null;
      const values = buildPayload(normalized, familyId);
      if (existing) await patchRow(existing.id, values);
      else await createRow(values);
    }

    const records = await fetchRowsByFamily(familyId);
    return res.status(200).json(buildMemberResponse(registrations, records, familyId));
  } catch (error) {
    console.error("Irumudi Kettu API error:", error);
    return res.status(500).json({ success: false, message: "Unable to process the Irumudi Kettu response." });
  }
}

export async function handleAdminIrumudi(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, message: "Method not allowed." });
  }
  try {
    const auth = await getAuthenticatedMember(req);
    if (auth.status !== 200) return res.status(auth.status).json({ success: false, message: auth.error });
    const role = auth.memberRow.field_10493689;
    const roleId = Number(role?.id ?? role?.value ?? role);
    const roleName = cleanString(role?.value);
    if (![7473605, 7473606].includes(roleId) && !["Board", "Admin"].includes(roleName)) {
      return res.status(403).json({ success: false, message: "Board or administrator access required." });
    }

    const [records, registrations] = await Promise.all([
      fetchAllRows(),
      fetchAllMaaladharanRegistrations()
    ]);
    const activeRecords = records.filter(item => item.status !== "Cancelled");
    const overridden = new Set(activeRecords.map(item => item.maaladharanId).filter(Boolean));
    const derived = registrations
      .filter(item => item.status !== "Cancelled" && !overridden.has(Number(item.id)))
      .map(registrationToResponse)
      .filter(item => item.participation);
    const participants = [...activeRecords, ...derived]
      .filter(item => item.participation)
      .sort((a, b) => a.participantName.localeCompare(b.participantName));
    const tampa = participants.filter(item => item.participation.startsWith("Tampa"));
    return res.status(200).json({
      success: true,
      summary: {
        tampaTotal: tampa.length,
        tampaWithIrumudi: tampa.filter(item => item.participation === "Tampa with Irumudi").length,
        tampaWithoutIrumudi: tampa.filter(item => item.participation === "Tampa without Irumudi").length,
        tampaSwamies: tampa.filter(item => item.category === "Swamy").length,
        tampaNonSwamies: tampa.filter(item => item.category === "Non-Swamy").length,
        aayssaIrumudi: participants.filter(item => item.participation === "AAYSSA Irumudi").length
      },
      participants
    });
  } catch (error) {
    console.error("Irumudi Kettu admin API error:", error);
    return res.status(500).json({ success: false, message: "Unable to load Irumudi Kettu summary." });
  }
}

function buildMemberResponse(registrations, records) {
  const activeRecords = records.filter(item => item.status !== "Cancelled");
  const byRegistration = new Map(activeRecords.filter(item => item.maaladharanId).map(item => [item.maaladharanId, item]));
  const imported = registrations.map(registration =>
    byRegistration.get(Number(registration.id)) || registrationToResponse(registration)
  );
  const additional = activeRecords.filter(item => !item.maaladharanId);
  return { success: true, season: SEASON, participants: [...imported, ...additional] };
}

function registrationToResponse(registration) {
  const prior = padiNumber(registration.padiStatus);
  return {
    id: null,
    maaladharanId: Number(registration.id),
    participantName: registration.participantName,
    category: "Swamy",
    gender: "",
    age: Number(registration.age) || 0,
    phone: registration.phoneNumber || "",
    email: registration.email || "",
    priorPadi: prior,
    currentPadi: prior + 1,
    participation: registration.irumudiOffering === "Tampa Temple"
      ? "Tampa with Irumudi"
      : registration.irumudiOffering === "AAYSSA Temple"
        ? "AAYSSA Irumudi"
        : "",
    agreement: false,
    source: "Maaladharan",
    status: "Active",
    notes: ""
  };
}

function normalizeInput(body) {
  return {
    id: positiveInteger(body?.id),
    maaladharanId: positiveInteger(body?.maaladharanId),
    participantName: cleanString(body?.participantName),
    category: cleanString(body?.category),
    gender: cleanString(body?.gender),
    age: Number(body?.age),
    phone: cleanString(body?.phone),
    email: cleanString(body?.email).toLowerCase(),
    priorPadi: nonNegativeInteger(body?.priorPadi),
    currentPadi: nonNegativeInteger(body?.currentPadi),
    participation: cleanString(body?.participation),
    agreement: body?.agreement === true || body?.agreement === "true" || body?.agreement === "on",
    source: cleanString(body?.source) === "Maaladharan" ? "Maaladharan" : "Additional Devotees",
    status: "Active",
    notes: cleanString(body?.notes).slice(0, 1000)
  };
}

function mergeRegistration(input, registration, fallbackEmail) {
  const defaults = registrationToResponse(registration);
  return {
    ...defaults,
    ...input,
    participantName: input.participantName || defaults.participantName,
    category: "Swamy",
    age: input.age || defaults.age,
    phone: input.phone || defaults.phone,
    email: input.email || defaults.email || fallbackEmail,
    priorPadi: input.priorPadi ?? defaults.priorPadi,
    currentPadi: input.currentPadi ?? defaults.currentPadi,
    source: "Maaladharan"
  };
}

function validateInput(input) {
  if (!input.participantName) return "Participant name is required.";
  if (!PARTICIPATION.includes(input.participation)) return "Select an Irumudi or Tampa participation option.";
  if (input.participation === "AAYSSA Irumudi") return "";
  if (!CATEGORIES.includes(input.category)) return "Select Swamy or Non-Swamy.";
  if (!GENDERS.includes(input.gender)) return "Select the participant gender.";
  if (!Number.isInteger(input.age) || input.age < 1 || input.age > 120) return "Enter a valid age.";
  if (!input.phone) return "Phone number is required for Tampa participants.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) return "Enter a valid email address.";
  if (input.category === "Swamy" && (!Number.isInteger(input.currentPadi) || input.currentPadi < 1)) return "Enter the current Padi count.";
  if (input.category === "Non-Swamy" && input.gender === "Female" && input.participation === "Tampa with Irumudi" && !input.agreement) {
    return "Confirm that Irumudi will be completed in Tampa and accommodation will be self-managed.";
  }
  return "";
}

function buildPayload(input, familyId) {
  return {
    [key("name")]: `${input.participantName} - ${SEASON}`,
    [key("familyId")]: familyId,
    [key("maaladharanId")]: input.maaladharanId || null,
    [key("season")]: SEASON,
    [key("participantName")]: input.participantName,
    [key("category")]: input.category,
    [key("gender")]: input.gender || null,
    [key("age")]: input.age || null,
    [key("phone")]: input.phone,
    [key("email")]: input.email,
    [key("priorPadi")]: input.category === "Swamy" ? input.priorPadi : null,
    [key("currentPadi")]: input.category === "Swamy" ? input.currentPadi : null,
    [key("participation")]: input.participation,
    [key("agreement")]: Boolean(input.agreement),
    [key("source")]: input.source,
    [key("status")]: "Active",
    [key("notes")]: input.notes
  };
}

async function fetchRowsByFamily(familyId) {
  const url = `${getBaserowBaseUrl()}/api/database/rows/table/${TABLE_ID}/?user_field_names=false&size=200&filter__field_${FIELDS.familyId}__equal=${familyId}`;
  const response = await fetch(url, { headers: getBaserowHeaders() });
  if (!response.ok) throw new Error("Unable to load Irumudi responses.");
  const data = await response.json();
  return (data.results || []).map(mapRow);
}

async function fetchAllRows() {
  const rows = [];
  let page = 1;
  while (true) {
    const response = await fetch(`${getBaserowBaseUrl()}/api/database/rows/table/${TABLE_ID}/?user_field_names=false&size=200&page=${page}`, { headers: getBaserowHeaders() });
    if (!response.ok) throw new Error("Unable to load Irumudi responses.");
    const data = await response.json();
    rows.push(...(data.results || []));
    if (!data.next) break;
    page += 1;
  }
  return rows.map(mapRow);
}

async function createRow(values) {
  const response = await fetch(`${getBaserowBaseUrl()}/api/database/rows/table/${TABLE_ID}/?user_field_names=false`, { method: "POST", headers: getBaserowHeaders(), body: JSON.stringify(values) });
  if (!response.ok) throw new Error("Unable to save Irumudi response.");
}

async function patchRow(id, values) {
  const response = await fetch(`${getBaserowBaseUrl()}/api/database/rows/table/${TABLE_ID}/${id}/?user_field_names=false`, { method: "PATCH", headers: getBaserowHeaders(), body: JSON.stringify(values) });
  if (!response.ok) throw new Error("Unable to update Irumudi response.");
}

function mapRow(row) {
  return {
    id: Number(row.id),
    familyId: Number(row[key("familyId")]) || 0,
    maaladharanId: Number(row[key("maaladharanId")]) || null,
    participantName: cleanString(row[key("participantName")]),
    category: selectValue(row[key("category")]),
    gender: selectValue(row[key("gender")]),
    age: Number(row[key("age")]) || 0,
    phone: cleanString(row[key("phone")]),
    email: cleanString(row[key("email")]).toLowerCase(),
    priorPadi: nonNegativeInteger(row[key("priorPadi")]),
    currentPadi: nonNegativeInteger(row[key("currentPadi")]),
    participation: selectValue(row[key("participation")]),
    agreement: Boolean(row[key("agreement")]),
    source: selectValue(row[key("source")]),
    status: selectValue(row[key("status")]),
    notes: cleanString(row[key("notes")])
  };
}

function key(name) { return `field_${FIELDS[name]}`; }
function selectValue(value) { return cleanString(value?.value ?? value); }
function positiveInteger(value) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : null; }
function nonNegativeInteger(value) { const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : null; }
function padiNumber(value) { const match = cleanString(value).match(/^\d+/); return match ? Number(match[0]) : 0; }
