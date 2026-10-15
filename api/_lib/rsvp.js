import {
  cleanString,
  getBaserowBaseUrl,
  getBaserowHeaders
} from "./aayssa.js";

const RSVP_TABLE_ID =
  process.env.BASEROW_RSVP_TABLE_ID || "1264849";
const HOME_POOJA_TABLE_ID =
  process.env.BASEROW_HOME_POOJA_TABLE_ID || "1240702";

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
  requesterName: 11317824,
  email: 11317825,
  poojaDate: 11317827,
  poojaAddress: 11317828,
  preferredTime: 11317829,
  requestStatus: 11317830
};

const STATUS_OPTIONS = {
  Attending: 8379707,
  "Not Attending": 8379708,
  Maybe: 8379709
};

export async function handlePublicRsvp(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    const bookingId = positiveInteger(req.body?.bookingId);
    const attendeeName = cleanString(req.body?.attendeeName);
    const email = cleanString(req.body?.email).toLowerCase();
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

    if (!bookingId || !attendeeName || !isValidEmail(email)) {
      return badRequest(
        res,
        "Attendee name, a valid email, and a Home Pooja booking are required."
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

    const booking = await assertActiveBooking(bookingId);

    const response = await fetch(
      `${getBaserowBaseUrl()}/api/database/rows/table/${RSVP_TABLE_ID}/?user_field_names=false`,
      {
        method: "POST",
        headers: getBaserowHeaders(),
        body: JSON.stringify({
          [fieldKey(FIELDS.attendeeName)]: attendeeName,
          [fieldKey(FIELDS.email)]: email,
          [fieldKey(FIELDS.phone)]: phone,
          [fieldKey(FIELDS.adults)]: adults,
          [fieldKey(FIELDS.kids)]: kids,
          [fieldKey(FIELDS.notes)]: notes,
          [fieldKey(FIELDS.status)]: STATUS_OPTIONS[status],
          [fieldKey(FIELDS.bookingLink)]: String(bookingId)
        })
      }
    );

    if (!response.ok) {
      console.error("RSVP creation failed:", response.status, await response.text());
      throw new Error("Unable to save your RSVP.");
    }

    const savedRsvp = await response.json();
    const confirmationEmailSent = await sendRsvpEmailSafely({
      kind: "confirmation",
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

    return res.status(201).json({
      success: true,
      message: confirmationEmailSent
        ? "Your RSVP has been received. A confirmation email has been sent."
        : "Your RSVP has been received.",
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
    const allRsvps = (await fetchAllRows(RSVP_TABLE_ID))
      .map(mapRsvpRow);
    const rsvps = allRsvps.filter(rsvp =>
        ["Attending", "Maybe"].includes(rsvp.status) &&
        isValidEmail(rsvp.email) &&
        rsvp.bookingId
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
        .map(booking => [booking.id, booking])
    );

    const due = rsvps.filter(rsvp => bookings.has(rsvp.bookingId));
    const results = await Promise.all(due.map(rsvp =>
      sendRsvpEmailSafely({
        kind: "reminder",
        rsvp,
        booking: bookings.get(rsvp.bookingId)
      })
    ));
    const summaryBookings = activeBookings.filter(booking =>
      booking.poojaDate === preliminaryDate || booking.poojaDate === today
    );
    const summaryResults = await Promise.all(summaryBookings.map(booking => {
      const kind = booking.poojaDate === today ? "final" : "preliminary";
      const bookingRsvps = allRsvps.filter(rsvp =>
        rsvp.bookingId === booking.id &&
        ["Attending", "Maybe"].includes(rsvp.status)
      );
      return sendHostSummarySafely({ kind, booking, rsvps: bookingRsvps });
    }));

    return res.status(200).json({
      success: true,
      date: tomorrow,
      due: due.length,
      sent: results.filter(Boolean).length,
      hostSummariesDue: summaryBookings.length,
      hostSummariesSent: summaryResults.filter(Boolean).length
    });
  } catch (error) {
    console.error("RSVP reminder error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to send RSVP reminders."
    });
  }
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

function mapBookingRow(row) {
  return {
    id: Number(row.id),
    entryType: selectValue(row[fieldKey(HOME_POOJA_FIELDS.entryType)]),
    requesterName: cleanString(row[fieldKey(HOME_POOJA_FIELDS.requesterName)]),
    email: cleanString(row[fieldKey(HOME_POOJA_FIELDS.email)]).toLowerCase(),
    poojaDate: cleanString(row[fieldKey(HOME_POOJA_FIELDS.poojaDate)]),
    poojaAddress: cleanString(row[fieldKey(HOME_POOJA_FIELDS.poojaAddress)]),
    preferredTime: cleanString(row[fieldKey(HOME_POOJA_FIELDS.preferredTime)]),
    status: selectValue(row[fieldKey(HOME_POOJA_FIELDS.requestStatus)])
  };
}

function mapRsvpRow(row) {
  return {
    id: Number(row.id),
    attendeeName: cleanString(row[fieldKey(FIELDS.attendeeName)]),
    email: cleanString(row[fieldKey(FIELDS.email)]).toLowerCase(),
    adults: Number(row[fieldKey(FIELDS.adults)]) || 0,
    kids: Number(row[fieldKey(FIELDS.kids)]) || 0,
    notes: cleanString(row[fieldKey(FIELDS.notes)]),
    status: selectValue(row[fieldKey(FIELDS.status)]),
    bookingId: positiveInteger(row[fieldKey(FIELDS.bookingLink)])
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
  const date = formatEmailDate(booking.poojaDate);
  const title = reminder ? "Home Pooja Reminder" : "Home Pooja RSVP Received";
  const intro = reminder
    ? "This is a reminder that the Home Pooja you RSVP’d to is tomorrow."
    : "Your Home Pooja RSVP has been received.";
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
      subject: `AAYSSA ${title} — ${date}`,
      ...(replyTo ? { reply_to: replyTo } : {}),
      text: [
        `Namaskaram ${rsvp.attendeeName},`, "", intro,
        `Host: ${booking.requesterName}`, `Date: ${date}`,
        `Time: ${booking.preferredTime || "To be confirmed"}`,
        `Address: ${booking.poojaAddress}`, `RSVP: ${rsvp.status}`,
        `Adults: ${rsvp.adults}`, `Kids: ${rsvp.kids}`,
        rsvp.notes ? `Notes: ${rsvp.notes}` : "", "",
        "Atlanta Ayyappa Seva Sangam"
      ].filter(Boolean).join("\n"),
      html: `
        <div style="font-family:Arial,sans-serif;color:#2c211a;line-height:1.6;max-width:620px;margin:auto">
          <h2 style="color:#8a3f12">${escapeHtml(title)}</h2>
          <p>Namaskaram ${escapeHtml(rsvp.attendeeName)},</p>
          <p>${escapeHtml(intro)}</p>
          <p><strong>Host:</strong> ${escapeHtml(booking.requesterName)}<br>
          <strong>Date:</strong> ${escapeHtml(date)}<br>
          <strong>Time:</strong> ${escapeHtml(booking.preferredTime || "To be confirmed")}<br>
          <strong>Address:</strong> ${escapeHtml(booking.poojaAddress)}<br>
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
      subject: `AAYSSA Home Pooja ${label} — ${date}`,
      ...(replyTo ? { reply_to: replyTo } : {}),
      text: [
        `Namaskaram ${booking.requesterName},`, "",
        `Here is your ${label.toLowerCase()} for the Home Pooja on ${date}.`,
        `Attending: ${attending.households} response(s), ${attending.adults} adult(s), ${attending.kids} kid(s)`,
        `Maybe: ${maybe.households} response(s), ${maybe.adults} adult(s), ${maybe.kids} kid(s)`,
        "", "RSVP details:", ...attendeeLines, "",
        final ? "This is the final morning summary." : "A final summary will be sent on the morning of the pooja.",
        "", "Atlanta Ayyappa Seva Sangam"
      ].join("\n"),
      html: `
        <div style="font-family:Arial,sans-serif;color:#2c211a;line-height:1.6;max-width:720px;margin:auto">
          <h2 style="color:#8a3f12">Home Pooja ${escapeHtml(label)}</h2>
          <p>Namaskaram ${escapeHtml(booking.requesterName)},</p>
          <p>Here is your ${escapeHtml(label.toLowerCase())} for the Home Pooja on <strong>${escapeHtml(date)}</strong>.</p>
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
