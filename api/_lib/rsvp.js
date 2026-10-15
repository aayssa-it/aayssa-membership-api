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

    await assertActiveBooking(bookingId);

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

    return res.status(201).json({
      success: true,
      message: "Your RSVP has been received."
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
  const type = selectValue(row[fieldKey(HOME_POOJA_FIELDS.entryType)]);
  const status = selectValue(row[fieldKey(HOME_POOJA_FIELDS.requestStatus)]);

  if (type !== "Booking" || !["Approved", "Submitted"].includes(status)) {
    const error = new Error("This Home Pooja booking is no longer available for RSVP.");
    error.status = 409;
    throw error;
  }
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
