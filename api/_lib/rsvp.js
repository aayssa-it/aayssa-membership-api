import {
  cleanString,
  getAuthenticatedMember,
  getBaserowBaseUrl,
  getBaserowHeaders
} from "./aayssa.js";

const RSVP_TABLE_ID =
  process.env.BASEROW_RSVP_TABLE_ID || "1264849";
const HOME_POOJA_TABLE_ID =
  process.env.BASEROW_HOME_POOJA_TABLE_ID || "1240702";
const AAYSSA_EVENT_SUMMARY_EMAIL =
  "aayssa.official@gmail.com";

const FIELDS = {
  attendeeName: 11608192,
  email: 11608193,
  phone: 11608194,
  adults: 11608204,
  kids: 11608205,
  notes: 11608207,
  status: 11608208,
  bookingLink: 11608209
};

const HOME_POOJA_FIELDS = {
  entryType: 11317808,
  family: 11317809,
  requesterName: 11317824,
  email: 11317825,
  poojaDate: 11317827,
  poojaAddress: 11317828,
  preferredTime: 11317829,
  requestStatus: 11317830,
  blockReason: 11317833
};

const STATUS_OPTIONS = {
  Attending: 8379707,
  "Not Attending": 8379708,
  Maybe: 8379709
};

const DEFAULT_EVENTS = new Map([
  ["2026-11-14", "Pushpabhishekam preparation"],
  ["2026-11-15", "Pushpabhishekam"],
  ["2026-11-21", "Sastha Preethi preparation"],
  ["2026-11-22", "Sastha Preethi"],
  ["2026-12-04", "Mandalam Closing"]
]);

export async function handlePublicRsvp(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    const action = cleanString(req.body?.action) || "submit";
    const bookingReference = normalizeReference(
      req.body?.bookingReference ?? req.body?.bookingId
    );
    const email = cleanString(req.body?.email).toLowerCase();

    if (!bookingReference || !isValidEmail(email)) {
      return badRequest(res, "A valid email and Home Pooja booking are required.");
    }

    if (action === "request-edit-code") {
      await assertActiveTarget(bookingReference);
      const existing = await findRsvp(bookingReference, email);
      if (!existing) {
        return res.status(404).json({
          success: false,
          message: "No RSVP was found for this email and Home Pooja."
        });
      }
      await sendVerificationCode(email);
      return res.status(200).json({
        success: true,
        message: "A verification code has been sent to your email."
      });
    }

    if (action === "verify-edit-code") {
      await assertActiveTarget(bookingReference);
      const editToken = await verifyEmailCode(email, req.body?.code);
      if (!editToken) {
        return res.status(401).json({
          success: false,
          message: "The verification code is invalid or expired."
        });
      }
      const existing = await findRsvp(bookingReference, email);
      if (!existing) {
        return res.status(404).json({ success: false, message: "RSVP not found." });
      }
      return res.status(200).json({
        success: true,
        editToken,
        rsvp: publicRsvp(existing)
      });
    }

    if (!["submit", "update"].includes(action)) {
      return badRequest(res, "Select a valid RSVP action.");
    }

    const attendeeName = cleanString(req.body?.attendeeName);
    const phone = cleanString(req.body?.phone);
    const adults = nonNegativeInteger(req.body?.adults);
    const kids = nonNegativeInteger(req.body?.kids);
    const notes = cleanString(req.body?.notes);
    const status = cleanString(req.body?.status);

    if (cleanString(req.body?.website)) {
      return res.status(201).json({
        success: true,
        message: "Your RSVP has been received."
      });
    }

    if (!attendeeName) {
      return badRequest(
        res,
        "Attendee name is required."
      );
    }

    if (!Object.hasOwn(STATUS_OPTIONS, status)) {
      return badRequest(res, "Select a valid RSVP status.");
    }

    if (adults === null || kids === null) {
      return badRequest(res, "Adult and kid counts must be whole numbers.");
    }

    if (status !== "Not Attending" && adults + kids < 1) {
      return badRequest(
        res,
        "Enter at least one adult or child for this RSVP."
      );
    }

    const booking = await assertActiveTarget(bookingReference);
    const existing = await findRsvp(bookingReference, email);

    if (action === "submit" && existing) {
      return res.status(409).json({
        success: false,
        code: "RSVP_EXISTS",
        message: "An RSVP already exists for this email. Select Edit RSVP to update it."
      });
    }

    if (action === "update") {
      if (!existing) {
        return res.status(404).json({ success: false, message: "RSVP not found." });
      }
      const verifiedEmail = await authenticatedEmail(req.body?.editToken);
      if (verifiedEmail !== email) {
        return res.status(401).json({
          success: false,
          message: "Your edit session is invalid or expired. Request a new code."
        });
      }
    }

    const payload = {
      [fieldKey(FIELDS.attendeeName)]: attendeeName,
      [fieldKey(FIELDS.email)]: email,
      [fieldKey(FIELDS.phone)]: phone,
      [fieldKey(FIELDS.adults)]: adults,
      [fieldKey(FIELDS.kids)]: kids,
      [fieldKey(FIELDS.notes)]: notes,
      [fieldKey(FIELDS.status)]: STATUS_OPTIONS[status],
      [fieldKey(FIELDS.bookingLink)]: bookingReference
    };
    const rowUrl = action === "update"
      ? `${getBaserowBaseUrl()}/api/database/rows/table/${RSVP_TABLE_ID}/${existing.id}/?user_field_names=false`
      : `${getBaserowBaseUrl()}/api/database/rows/table/${RSVP_TABLE_ID}/?user_field_names=false`;

    const response = await fetch(
      rowUrl,
      {
        method: action === "update" ? "PATCH" : "POST",
        headers: getBaserowHeaders(),
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      console.error("RSVP save failed:", response.status, await response.text());
      throw new Error("Unable to save your RSVP.");
    }

    const savedRsvp = await response.json();
    const confirmationEmailSent = await sendRsvpEmailSafely({
      kind: action === "update" ? "update" : "confirmation",
      rsvp: {
        id: savedRsvp.id,
        attendeeName,
        email,
        adults,
        kids,
        notes,
        status
      },
      booking
    });

    return res.status(action === "update" ? 200 : 201).json({
      success: true,
      message: confirmationEmailSent
        ? `Your RSVP has been ${action === "update" ? "updated" : "received"}. A confirmation email has been sent.`
        : `Your RSVP has been ${action === "update" ? "updated" : "received"}.`,
      confirmationEmailSent
    });
  } catch (error) {
    console.error("RSVP API error:", error);
    return res.status(Number(error?.status) || 500).json({
      success: false,
      message: error instanceof Error
        ? error.message
        : "The RSVP service is unavailable."
    });
  }
}

export async function handleMemberRsvps(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res);
  try {
    const auth = await getAuthenticatedMember(req);
    if (auth.status !== 200) {
      return res.status(auth.status).json({ success: false, message: auth.error });
    }
    const groups = await buildRsvpGroups({ familyId: Number(auth.memberRow.id) });
    return res.status(200).json({ success: true, groups });
  } catch (error) {
    console.error("Member RSVP view error:", error);
    return res.status(500).json({ success: false, message: "Unable to load RSVPs." });
  }
}

export async function handleAdminRsvps(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res);
  try {
    const auth = await getAuthenticatedMember(req);
    if (auth.status !== 200) {
      return res.status(auth.status).json({ success: false, message: auth.error });
    }
    if (!hasBoardAccess(auth.memberRow)) {
      return res.status(403).json({
        success: false,
        message: "Board or administrator access required."
      });
    }
    const groups = await buildRsvpGroups({ includeEvents: true });
    return res.status(200).json({ success: true, groups });
  } catch (error) {
    console.error("Admin RSVP view error:", error);
    return res.status(500).json({ success: false, message: "Unable to load RSVPs." });
  }
}

export async function handleRsvpReminders(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false });
  }

  const secret = process.env.CRON_SECRET;
  const authorization = cleanString(req.headers.authorization);

  if (!secret || authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }

  try {
    const today = easternDateWithOffset(0);
    const tomorrow = easternDateWithOffset(1);
    const preliminaryDate = easternDateWithOffset(2);
    const allRsvps = dedupeRsvps(
      (await fetchAllRows(RSVP_TABLE_ID)).map(mapRsvpRow)
    );
    const rsvps = allRsvps.filter(rsvp =>
        ["Attending", "Maybe"].includes(rsvp.status) &&
        isValidEmail(rsvp.email) &&
        rsvp.bookingReference
      );
    const activeBookings = (await fetchAllRows(HOME_POOJA_TABLE_ID))
      .map(mapBookingRow)
      .filter(booking =>
        booking.entryType === "Booking" &&
        ["Approved", "Submitted"].includes(booking.status)
      );
    const bookings = new Map(
      activeBookings
        .filter(booking => booking.poojaDate === tomorrow)
        .map(booking => [String(booking.id), booking])
    );
    const events = await fetchActiveAayssaEvents();
    for (const event of events.filter(item => item.poojaDate === tomorrow)) {
      bookings.set(event.reference, event);
    }

    const due = rsvps.filter(rsvp => bookings.has(rsvp.bookingReference));
    const results = await Promise.all(due.map(rsvp =>
      sendRsvpEmailSafely({
        kind: "reminder",
        rsvp,
        booking: bookings.get(rsvp.bookingReference)
      })
    ));
    const summaryBookings = activeBookings.filter(booking =>
      booking.poojaDate === preliminaryDate || booking.poojaDate === today
    );
    const summaryResults = await Promise.all(summaryBookings.map(booking => {
      const kind = booking.poojaDate === today ? "final" : "preliminary";
      const bookingRsvps = allRsvps.filter(rsvp =>
        rsvp.bookingReference === String(booking.id) &&
        ["Attending", "Maybe"].includes(rsvp.status)
      );
      return sendHostSummarySafely({ kind, booking, rsvps: bookingRsvps });
    }));
    const summaryEvents = events.filter(event =>
      event.poojaDate === preliminaryDate || event.poojaDate === today
    );
    const eventSummaryResults = await Promise.all(summaryEvents.map(event => {
      const kind = event.poojaDate === today ? "final" : "preliminary";
      const eventRsvps = allRsvps.filter(rsvp =>
        rsvp.bookingReference === event.reference &&
        ["Attending", "Maybe"].includes(rsvp.status)
      );
      return sendHostSummarySafely({
        kind,
        booking: { ...event, email: AAYSSA_EVENT_SUMMARY_EMAIL },
        rsvps: eventRsvps
      });
    }));

    return res.status(200).json({
      success: true,
      date: tomorrow,
      due: due.length,
      sent: results.filter(Boolean).length,
      hostSummariesDue: summaryBookings.length,
      hostSummariesSent: summaryResults.filter(Boolean).length,
      eventSummariesDue: summaryEvents.length,
      eventSummariesSent: eventSummaryResults.filter(Boolean).length
    });
  } catch (error) {
    console.error("RSVP reminder error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to send RSVP reminders."
    });
  }
}

export async function fetchPublicRsvpSummaries(bookingReferences) {
  const wanted = new Set(
    bookingReferences.map(normalizeReference).filter(Boolean)
  );
  const summaries = new Map();

  if (!wanted.size) return summaries;

  const rsvps = dedupeRsvps(
    (await fetchAllRows(RSVP_TABLE_ID)).map(mapRsvpRow)
  )
    .filter(rsvp => wanted.has(rsvp.bookingReference));

  for (const rsvp of rsvps) {
    if (!["Attending", "Maybe"].includes(rsvp.status)) continue;
    const summary = summaries.get(rsvp.bookingReference) || {
      attendingResponses: 0,
      attendingGuests: 0,
      attendingAdults: 0,
      attendingKids: 0,
      maybeResponses: 0,
      maybeGuests: 0
    };
    const guests = rsvp.adults + rsvp.kids;

    if (rsvp.status === "Attending") {
      summary.attendingResponses += 1;
      summary.attendingGuests += guests;
      summary.attendingAdults += rsvp.adults;
      summary.attendingKids += rsvp.kids;
    } else {
      summary.maybeResponses += 1;
      summary.maybeGuests += guests;
    }
    summaries.set(rsvp.bookingReference, summary);
  }

  return summaries;
}

async function assertActiveBooking(bookingId) {
  const response = await fetch(
    `${getBaserowBaseUrl()}/api/database/rows/table/${HOME_POOJA_TABLE_ID}/${bookingId}/?user_field_names=false`,
    { headers: getBaserowHeaders() }
  );

  if (!response.ok) {
    const error = new Error("This Home Pooja booking is no longer available for RSVP.");
    error.status = response.status === 404 ? 404 : 500;
    throw error;
  }

  const row = await response.json();
  const booking = mapBookingRow(row);
  const type = booking.entryType;
  const status = booking.status;

  if (type !== "Booking" || !["Approved", "Submitted"].includes(status)) {
    const error = new Error("This Home Pooja booking is no longer available for RSVP.");
    error.status = 409;
    throw error;
  }

  return booking;
}

async function assertActiveTarget(reference) {
  if (reference.startsWith("event:")) {
    const events = await fetchActiveAayssaEvents();
    const event = events.find(item => item.reference === reference);
    if (event) return event;
    const error = new Error("This AAYSSA event is no longer available for RSVP.");
    error.status = 409;
    throw error;
  }
  return assertActiveBooking(Number(reference));
}

async function fetchActiveAayssaEvents() {
  const rows = (await fetchAllRows(HOME_POOJA_TABLE_ID)).map(mapBookingRow);
  const cancelledDates = new Set(
    rows.filter(row => row.entryType === "Blocked" && row.status === "Cancelled")
      .map(row => row.poojaDate)
  );
  const events = new Map();

  for (const [date, name] of DEFAULT_EVENTS) {
    if (!cancelledDates.has(date) && !/preparation/i.test(name)) {
      events.set(date, makeEvent(date, name));
    }
  }
  for (const row of rows) {
    if (row.entryType === "Blocked" && row.status === "Blocked") {
      const name = row.blockReason || "AAYSSA Event";
      if (!/preparation/i.test(name)) {
        events.set(row.poojaDate, makeEvent(row.poojaDate, name));
      }
    }
  }
  return [...events.values()];
}

function makeEvent(date, name) {
  return {
    id: `event:${date}`,
    reference: `event:${date}`,
    isAayssaEvent: true,
    requesterName: name,
    eventName: name,
    email: "",
    poojaDate: date,
    poojaAddress: "",
    preferredTime: "",
    status: "Blocked"
  };
}

async function fetchBooking(bookingId) {
  const response = await fetch(
    `${getBaserowBaseUrl()}/api/database/rows/table/${HOME_POOJA_TABLE_ID}/${bookingId}/?user_field_names=false`,
    { headers: getBaserowHeaders() }
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Unable to load a Home Pooja booking.");
  return mapBookingRow(await response.json());
}

async function fetchAllRows(tableId) {
  const rows = [];
  let page = 1;
  while (true) {
    const response = await fetch(
      `${getBaserowBaseUrl()}/api/database/rows/table/${tableId}/?user_field_names=false&size=200&page=${page}`,
      { headers: getBaserowHeaders() }
    );
    if (!response.ok) throw new Error("Unable to load RSVP submissions.");
    const data = await response.json();
    rows.push(...(Array.isArray(data.results) ? data.results : []));
    if (!data.next) break;
    page += 1;
  }
  return rows;
}

async function buildRsvpGroups({ familyId = null, includeEvents = false } = {}) {
  const rsvps = dedupeRsvps(
    (await fetchAllRows(RSVP_TABLE_ID)).map(mapRsvpRow)
  );
  const bookings = (await fetchAllRows(HOME_POOJA_TABLE_ID))
    .map(mapBookingRow)
    .filter(booking =>
      booking.entryType === "Booking" &&
      (!familyId || booking.familyIds.includes(familyId))
    );
  const targets = new Map(
    bookings.map(booking => [String(booking.id), booking])
  );

  if (includeEvents) {
    for (const event of await fetchActiveAayssaEvents()) {
      targets.set(event.reference, event);
    }
  }

  return [...targets.entries()]
    .map(([reference, target]) => {
      const responses = rsvps
        .filter(rsvp => rsvp.bookingReference === reference)
        .sort((a, b) => a.attendeeName.localeCompare(b.attendeeName));
      return {
        reference,
        type: target.isAayssaEvent ? "AAYSSA Event" : "Home Pooja",
        name: target.isAayssaEvent ? target.eventName : target.requesterName,
        date: target.poojaDate,
        time: target.preferredTime,
        address: target.poojaAddress,
        summary: summarizeAllRsvps(responses),
        responses: responses.map(publicRsvp)
      };
    })
    .filter(group => group.responses.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function summarizeAllRsvps(rsvps) {
  const attending = summarizeRsvps(rsvps, "Attending");
  const maybe = summarizeRsvps(rsvps, "Maybe");
  return { attending, maybe, totalResponses: rsvps.length };
}

async function findRsvp(bookingReference, email) {
  const matches = (await fetchAllRows(RSVP_TABLE_ID))
    .map(mapRsvpRow)
    .filter(rsvp =>
      rsvp.bookingReference === bookingReference &&
      rsvp.email === email
    )
    .sort((a, b) => b.id - a.id);
  return matches[0] || null;
}

function dedupeRsvps(rsvps) {
  const newest = new Map();
  for (const rsvp of [...rsvps].sort((a, b) => b.id - a.id)) {
    const key = `${rsvp.bookingReference}:${rsvp.email}`;
    if (rsvp.bookingReference && rsvp.email && !newest.has(key)) {
      newest.set(key, rsvp);
    }
  }
  return [...newest.values()];
}

function publicRsvp(rsvp) {
  return {
    attendeeName: rsvp.attendeeName,
    email: rsvp.email,
    phone: rsvp.phone,
    adults: rsvp.adults,
    kids: rsvp.kids,
    notes: rsvp.notes,
    status: rsvp.status
  };
}

function mapBookingRow(row) {
  return {
    id: Number(row.id),
    entryType: selectValue(row[fieldKey(HOME_POOJA_FIELDS.entryType)]),
    familyIds: linkRowIds(row[fieldKey(HOME_POOJA_FIELDS.family)]),
    requesterName: cleanString(row[fieldKey(HOME_POOJA_FIELDS.requesterName)]),
    email: cleanString(row[fieldKey(HOME_POOJA_FIELDS.email)]).toLowerCase(),
    poojaDate: cleanString(row[fieldKey(HOME_POOJA_FIELDS.poojaDate)]),
    poojaAddress: cleanString(row[fieldKey(HOME_POOJA_FIELDS.poojaAddress)]),
    preferredTime: cleanString(row[fieldKey(HOME_POOJA_FIELDS.preferredTime)]),
    status: selectValue(row[fieldKey(HOME_POOJA_FIELDS.requestStatus)]),
    blockReason: cleanString(row[fieldKey(HOME_POOJA_FIELDS.blockReason)])
  };
}

function linkRowIds(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => Number(item?.id ?? item)).filter(Number.isInteger);
}

function mapRsvpRow(row) {
  return {
    id: Number(row.id),
    attendeeName: cleanString(row[fieldKey(FIELDS.attendeeName)]),
    email: cleanString(row[fieldKey(FIELDS.email)]).toLowerCase(),
    phone: cleanString(row[fieldKey(FIELDS.phone)]),
    adults: Number(row[fieldKey(FIELDS.adults)]) || 0,
    kids: Number(row[fieldKey(FIELDS.kids)]) || 0,
    notes: cleanString(row[fieldKey(FIELDS.notes)]),
    status: selectValue(row[fieldKey(FIELDS.status)]),
    bookingReference: normalizeReference(row[fieldKey(FIELDS.bookingLink)])
  };
}

async function sendRsvpEmailSafely(details) {
  try {
    await sendRsvpEmail(details);
    return true;
  } catch (error) {
    console.error(`RSVP ${details.kind} email error:`, error);
    return false;
  }
}

async function sendRsvpEmail({ kind, rsvp, booking }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || process.env.RESEND_FROM ||
    process.env.EMAIL_FROM || process.env.FROM_EMAIL;
  if (!apiKey || !from) throw new Error("Resend RSVP email is not configured.");

  const reminder = kind === "reminder";
  const update = kind === "update";
  const event = Boolean(booking.isAayssaEvent);
  const subjectType = event ? "AAYSSA Event" : "Home Pooja";
  const date = formatEmailDate(booking.poojaDate);
  const title = reminder
    ? `${subjectType} Reminder`
    : update
      ? `${subjectType} RSVP Updated`
      : `${subjectType} RSVP Received`;
  const intro = reminder
    ? `This is a reminder that the ${subjectType} you RSVP’d to is tomorrow.`
    : update
      ? `Your ${subjectType} RSVP has been updated.`
      : `Your ${subjectType} RSVP has been received.`;
  const replyTo = process.env.RESEND_REPLY_TO_EMAIL;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  if (reminder && rsvp.id) {
    headers["Idempotency-Key"] = `aayssa-rsvp-reminder-${rsvp.id}-${booking.poojaDate}`;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify({
      from,
      to: [rsvp.email],
      cc: [AAYSSA_EVENT_SUMMARY_EMAIL],
      subject: `AAYSSA ${title} — ${date}`,
      ...(replyTo ? { reply_to: replyTo } : {}),
      text: [
        `Namaskaram ${rsvp.attendeeName},`, "", intro,
        `${event ? "Event" : "Host"}: ${booking.requesterName}`, `Date: ${date}`,
        booking.preferredTime ? `Time: ${booking.preferredTime}` : "",
        booking.poojaAddress ? `Address: ${booking.poojaAddress}` : "",
        `RSVP: ${rsvp.status}`,
        `Adults: ${rsvp.adults}`, `Kids: ${rsvp.kids}`,
        rsvp.notes ? `Notes: ${rsvp.notes}` : "", "",
        "Atlanta Ayyappa Seva Sangam"
      ].filter(Boolean).join("\n"),
      html: `
        <div style="font-family:Arial,sans-serif;color:#2c211a;line-height:1.6;max-width:620px;margin:auto">
          <h2 style="color:#8a3f12">${escapeHtml(title)}</h2>
          <p>Namaskaram ${escapeHtml(rsvp.attendeeName)},</p>
          <p>${escapeHtml(intro)}</p>
          <p><strong>${event ? "Event" : "Host"}:</strong> ${escapeHtml(booking.requesterName)}<br>
          <strong>Date:</strong> ${escapeHtml(date)}<br>
          ${booking.preferredTime ? `<strong>Time:</strong> ${escapeHtml(booking.preferredTime)}<br>` : ""}
          ${booking.poojaAddress ? `<strong>Address:</strong> ${escapeHtml(booking.poojaAddress)}<br>` : ""}
          <strong>RSVP:</strong> ${escapeHtml(rsvp.status)}<br>
          <strong>Adults:</strong> ${rsvp.adults}<br>
          <strong>Kids:</strong> ${rsvp.kids}</p>
          ${rsvp.notes ? `<p><strong>Notes:</strong> ${escapeHtml(rsvp.notes)}</p>` : ""}
          <p>Atlanta Ayyappa Seva Sangam</p>
        </div>`
    })
  });
  if (!response.ok) {
    console.error("Resend RSVP email failed:", response.status, await response.text());
    throw new Error("Unable to send RSVP email.");
  }
}

async function sendHostSummarySafely(details) {
  try {
    await sendHostSummary(details);
    return true;
  } catch (error) {
    console.error(`RSVP host ${details.kind} summary error:`, error);
    return false;
  }
}

async function sendHostSummary({ kind, booking, rsvps }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || process.env.RESEND_FROM ||
    process.env.EMAIL_FROM || process.env.FROM_EMAIL;
  if (!apiKey || !from) throw new Error("Resend RSVP email is not configured.");
  if (!isValidEmail(booking.email)) {
    throw new Error("The Home Pooja host does not have a valid email address.");
  }

  const attending = summarizeRsvps(rsvps, "Attending");
  const maybe = summarizeRsvps(rsvps, "Maybe");
  const final = kind === "final";
  const label = final ? "Final RSVP Summary" : "Preliminary RSVP Summary";
  const event = Boolean(booking.isAayssaEvent);
  const subjectType = event ? booking.eventName : "Home Pooja";
  const date = formatEmailDate(booking.poojaDate);
  const replyTo = process.env.RESEND_REPLY_TO_EMAIL;
  const attendeeLines = rsvps.length
    ? rsvps.map(rsvp =>
        `${rsvp.attendeeName} — ${rsvp.status}; ${rsvp.adults} adult(s), ${rsvp.kids} kid(s)${rsvp.notes ? `; ${rsvp.notes}` : ""}`
      )
    : ["No Attending or Maybe RSVPs have been submitted."];
  const attendeeRows = rsvps.length
    ? rsvps.map(rsvp => `
        <tr>
          <td style="padding:7px;border-bottom:1px solid #ead8c5">${escapeHtml(rsvp.attendeeName)}</td>
          <td style="padding:7px;border-bottom:1px solid #ead8c5">${escapeHtml(rsvp.status)}</td>
          <td style="padding:7px;border-bottom:1px solid #ead8c5">${rsvp.adults}</td>
          <td style="padding:7px;border-bottom:1px solid #ead8c5">${rsvp.kids}</td>
          <td style="padding:7px;border-bottom:1px solid #ead8c5">${escapeHtml(rsvp.notes)}</td>
        </tr>`).join("")
    : `<tr><td colspan="5" style="padding:10px">No Attending or Maybe RSVPs have been submitted.</td></tr>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `aayssa-rsvp-host-${kind}-${booking.id}-${booking.poojaDate}`
    },
    body: JSON.stringify({
      from,
      to: [booking.email],
      ...(cleanString(booking.email).toLowerCase() !== AAYSSA_EVENT_SUMMARY_EMAIL
        ? { cc: [AAYSSA_EVENT_SUMMARY_EMAIL] }
        : {}),
      subject: `AAYSSA ${subjectType} ${label} — ${date}`,
      ...(replyTo ? { reply_to: replyTo } : {}),
      text: [
        event ? "Namaskaram AAYSSA Team," : `Namaskaram ${booking.requesterName},`, "",
        `Here is the ${label.toLowerCase()} for ${event ? booking.eventName : "the Home Pooja"} on ${date}.`,
        `Attending: ${attending.households} response(s), ${attending.adults} adult(s), ${attending.kids} kid(s)`,
        `Maybe: ${maybe.households} response(s), ${maybe.adults} adult(s), ${maybe.kids} kid(s)`,
        "", "RSVP details:", ...attendeeLines, "",
        final ? "This is the final morning summary." : "A final summary will be sent on the morning of the pooja.",
        "", "Atlanta Ayyappa Seva Sangam"
      ].join("\n"),
      html: `
        <div style="font-family:Arial,sans-serif;color:#2c211a;line-height:1.6;max-width:720px;margin:auto">
          <h2 style="color:#8a3f12">${escapeHtml(subjectType)} ${escapeHtml(label)}</h2>
          <p>${event ? "Namaskaram AAYSSA Team," : `Namaskaram ${escapeHtml(booking.requesterName)},`}</p>
          <p>Here is the ${escapeHtml(label.toLowerCase())} for ${event ? escapeHtml(booking.eventName) : "the Home Pooja"} on <strong>${escapeHtml(date)}</strong>.</p>
          <p><strong>Attending:</strong> ${attending.households} response(s), ${attending.adults} adult(s), ${attending.kids} kid(s)<br>
          <strong>Maybe:</strong> ${maybe.households} response(s), ${maybe.adults} adult(s), ${maybe.kids} kid(s)</p>
          <table style="border-collapse:collapse;width:100%;margin:20px 0">
            <thead><tr><th style="padding:7px;text-align:left">Name</th><th style="padding:7px;text-align:left">Status</th><th style="padding:7px;text-align:left">Adults</th><th style="padding:7px;text-align:left">Kids</th><th style="padding:7px;text-align:left">Notes</th></tr></thead>
            <tbody>${attendeeRows}</tbody>
          </table>
          <p>${final ? "This is the final morning summary." : "A final summary will be sent on the morning of the pooja."}</p>
          <p>Atlanta Ayyappa Seva Sangam</p>
        </div>`
    })
  });
  if (!response.ok) {
    console.error("Resend RSVP host summary failed:", response.status, await response.text());
    throw new Error("Unable to send RSVP host summary.");
  }
}

function summarizeRsvps(rsvps, status) {
  const matching = rsvps.filter(rsvp => rsvp.status === status);
  return matching.reduce((summary, rsvp) => ({
    households: summary.households + 1,
    adults: summary.adults + rsvp.adults,
    kids: summary.kids + rsvp.kids
  }), { households: 0, adults: 0, kids: 0 });
}

function easternDateWithOffset(offset) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const current = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  current.setUTCDate(current.getUTCDate() + offset);
  return current.toISOString().slice(0, 10);
}

function formatEmailDate(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return value || "Not provided";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC"
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

async function sendVerificationCode(email) {
  const response = await fetch(`${requiredSupabaseUrl()}/auth/v1/otp`, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({ email, create_user: true })
  });
  if (!response.ok) throw new Error("Unable to send the verification code.");
}

async function verifyEmailCode(email, code) {
  const token = cleanString(code).replace(/\D/g, "");
  if (!token) return "";
  const response = await fetch(`${requiredSupabaseUrl()}/auth/v1/verify`, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({ email, token, type: "email" })
  });
  if (!response.ok) return "";
  const data = await response.json();
  return cleanString(data?.user?.email).toLowerCase() === email
    ? cleanString(data.access_token)
    : "";
}

async function authenticatedEmail(accessToken) {
  const token = cleanString(accessToken);
  if (!token) return "";
  const response = await fetch(`${requiredSupabaseUrl()}/auth/v1/user`, {
    headers: {
      apikey: requiredSupabaseKey(),
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) return "";
  const user = await response.json();
  return cleanString(user?.email).toLowerCase();
}

function requiredSupabaseUrl() {
  const value = cleanString(process.env.SUPABASE_URL).replace(/\/$/, "");
  if (!value) throw new Error("Email verification is unavailable.");
  return value;
}

function requiredSupabaseKey() {
  const value = cleanString(process.env.SUPABASE_PUBLISHABLE_KEY);
  if (!value) throw new Error("Email verification is unavailable.");
  return value;
}

function supabaseHeaders() {
  const key = requiredSupabaseKey();
  return {
    "Content-Type": "application/json",
    apikey: key,
    Authorization: `Bearer ${key}`
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function selectValue(value) {
  return cleanString(value?.value ?? value);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeReference(value) {
  const reference = cleanString(value);
  if (/^[1-9]\d*$/.test(reference)) return reference;
  if (/^event:\d{4}-\d{2}-\d{2}$/.test(reference)) return reference;
  return "";
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function fieldKey(id) {
  return `field_${id}`;
}

function badRequest(res, message) {
  return res.status(400).json({ success: false, message });
}

function methodNotAllowed(res) {
  return res.status(405).json({ success: false, message: "Method not allowed." });
}

function hasBoardAccess(memberRow) {
  const role = memberRow?.field_10493689;
  const id = Number(role?.id ?? role);
  const name = cleanString(role?.value).toLowerCase();
  return id === 7473605 || id === 7473606 || name === "board" || name === "admin";
}
