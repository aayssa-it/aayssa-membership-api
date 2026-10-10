import {
  cleanString,
  findMemberByEmail,
  getAuthenticatedMember,
  getBaserowBaseUrl,
  getBaserowHeaders
} from "./aayssa.js";

const TABLE_ID =
  process.env.BASEROW_HOME_POOJA_TABLE_ID || "1240702";

const FIELDS = {
  calendarEntry: 11317807,
  entryType: 11317808,
  family: 11317809,
  requesterName: 11317824,
  email: 11317825,
  phoneNumber: 11317826,
  poojaDate: 11317827,
  poojaAddress: 11317828,
  preferredTime: 11317829,
  requestStatus: 11317830,
  requesterNote: 11317831,
  adminNotes: 11317832,
  blockReason: 11317833,
  emailVerified: 11317834,
  approvedBy: 11317836,
  approvedOn: 11317838,
  createdOn: 11317839
};

const DEFAULT_BLOCKS = new Map([
  ["2026-11-14", "Pushpabhishekam preparation"],
  ["2026-11-15", "Pushpabhishekam"],
  ["2026-11-21", "Sastha Preethi preparation"],
  ["2026-11-22", "Sastha Preethi"],
  ["2026-12-04", "Mandalam Closing"]
]);

const THANKSGIVING_DATES = new Set([
  "2026-11-25",
  "2026-11-26"
]);

const MANDALAM_START = "2026-10-30";
const MANDALAM_END = "2026-11-29";

export async function handlePublicHomePooja(req, res) {
  if (process.env.HOME_POOJA_PUBLIC_ENABLED !== "true") {
    return res.status(404).json({
      success: false,
      message: "Home Pooja booking is not yet open to the public."
    });
  }

  if (req.method === "GET") {
    try {
      return res.status(200).json({
        success: true,
        calendar:
          await buildPublicCalendar(req.query)
      });
    } catch (error) {
      return handleError(res, error);
    }
  }

  if (req.method !== "POST") {
    return methodNotAllowed(res);
  }

  const action =
    cleanString(req.body?.action)
      .toLowerCase();

  const email =
    normalizeEmail(req.body?.email);

  try {
    if (cleanString(req.body?.website)) {
      return res.status(200).json({
        success: true,
        message:
          action === "request-code"
            ? "A verification passcode has been sent."
            : "Your Home Pooja has been booked."
      });
    }

    if (!isValidEmail(email)) {
      return badRequest(
        res,
        "Enter a valid email address."
      );
    }

    if (action === "request-code") {
      await sendVerificationCode(email);

      return res.status(200).json({
        success: true,
        message:
          "A verification passcode has been sent."
      });
    }

    if (action !== "submit") {
      return badRequest(
        res,
        "Select a valid request action."
      );
    }

    const request =
      normalizeBooking(req.body);

    const validationError =
      validateBooking(request);

    if (validationError) {
      return badRequest(res, validationError);
    }

    const verified =
      await verifyEmailCode(
        email,
        req.body?.code
      );

    if (!verified) {
      return res.status(401).json({
        success: false,
        message:
          "The verification passcode is invalid or expired."
      });
    }

    const memberRow =
      await findMemberByEmail(email);

    await assertDateCanBeRequested(
      request.poojaDate
    );

    await createBooking({
      request,
      email,
      familyId: memberRow?.id || null,
      emailVerified: true
    });

    return res.status(201).json({
      success: true,
      message:
        "Your Home Pooja has been booked."
    });
  } catch (error) {
    return handleError(res, error);
  }
}

export async function handleMemberHomePooja(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return methodNotAllowed(res);
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
        message: "Board access required during preview."
      });
    }

    await claimUnlinkedBookings(
      auth.normalizedEmail,
      auth.memberRow.id
    );

    if (req.method === "GET") {
      const [requests, calendar] =
        await Promise.all([
          fetchFamilyBookings(
            auth.memberRow.id
          ),
          buildPublicCalendar(
            req.query,
            { includeBookingDetails: true }
          )
        ]);

      return res.status(200).json({
        success: true,
        requests,
        calendar
      });
    }

    const request =
      normalizeBooking(req.body);

    const validationError =
      validateBooking(request);

    if (validationError) {
      return badRequest(res, validationError);
    }

    await assertDateCanBeRequested(
      request.poojaDate
    );

    await createBooking({
      request,
      email: auth.normalizedEmail,
      familyId: auth.memberRow.id,
      emailVerified: true
    });

    return res.status(201).json({
      success: true,
      message:
        "Your Home Pooja has been booked."
    });
  } catch (error) {
    return handleError(res, error);
  }
}

export async function handleAdminHomePooja(req, res) {
  if (!["GET", "POST", "PATCH"].includes(req.method)) {
    return methodNotAllowed(res);
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

    if (req.method === "GET") {
      const [entries, calendar] =
        await Promise.all([
          fetchAllEntries(),
          buildPublicCalendar(
            req.query,
            { includeBookingDetails: true }
          )
        ]);

      return res.status(200).json({
        success: true,
        entries,
        calendar
      });
    }

    if (req.method === "POST") {
      const date =
        cleanString(req.body?.poojaDate);

      const reason =
        cleanString(req.body?.blockReason)
          .slice(0, 250);

      if (!isDateString(date) || !reason) {
        return badRequest(
          res,
          "A valid date and block reason are required."
        );
      }

      await createBlock(date, reason);

      return res.status(201).json({
        success: true,
        message: "The date has been blocked."
      });
    }

    const id =
      Number(req.body?.id);

    const action =
      cleanString(req.body?.action)
        .toLowerCase();

    const notes =
      cleanString(req.body?.adminNotes)
        .slice(0, 1000);

    if (action === "unblock-date") {
      const date =
        cleanString(req.body?.poojaDate);

      if (!isDateString(date)) {
        return badRequest(
          res,
          "Select a valid blocked date."
        );
      }

      await unblockDate(
        date,
        notes,
        auth.normalizedEmail
      );

      return res.status(200).json({
        success: true,
        message: "The date is now available."
      });
    }

    if (action === "edit-block") {
      const originalDate =
        cleanString(req.body?.originalDate);

      const date =
        cleanString(req.body?.poojaDate);

      const reason =
        cleanString(req.body?.blockReason)
          .slice(0, 250);

      if (
        !isDateString(originalDate) ||
        !isDateString(date) ||
        !reason
      ) {
        return badRequest(
          res,
          "The original date, updated date, and event name are required."
        );
      }

      await editBlockedDate({
        originalDate,
        date,
        reason,
        adminEmail: auth.normalizedEmail
      });

      return res.status(200).json({
        success: true,
        message: "The blocked event was updated."
      });
    }

    if (!Number.isInteger(id) || id < 1) {
      return badRequest(
        res,
        "Select a valid calendar entry."
      );
    }

    const row =
      await fetchEntry(id);

    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Calendar entry not found."
      });
    }

    if (action === "edit-booking") {
      if (getSelect(row, FIELDS.entryType) !== "Booking") {
        return badRequest(res, "Only Home Pooja bookings can be edited.");
      }

      const preferredTime = cleanString(req.body?.preferredTime).slice(0, 100);
      const poojaAddress = cleanString(req.body?.poojaAddress).slice(0, 1000);

      if (!preferredTime || !poojaAddress) {
        return badRequest(res, "Scheduled time and Pooja address are required.");
      }

      await patchEntry(id, {
        [fieldKey(FIELDS.preferredTime)]: preferredTime,
        [fieldKey(FIELDS.poojaAddress)]: poojaAddress,
        [fieldKey(FIELDS.adminNotes)]: "Booking time or address edited",
        [fieldKey(FIELDS.approvedBy)]: auth.normalizedEmail,
        [fieldKey(FIELDS.approvedOn)]: todayInEasternTime()
      });
    } else if (action === "unblock") {
      if (getSelect(row, FIELDS.entryType) !== "Blocked") {
        return badRequest(
          res,
          "Only blocked dates can be unblocked."
        );
      }

      await patchEntry(id, {
        [fieldKey(FIELDS.requestStatus)]:
          await selectOptionId(
            FIELDS.requestStatus,
            "Cancelled"
          ),
        [fieldKey(FIELDS.adminNotes)]: notes
      });
    } else {
      return badRequest(
        res,
        "Select edit booking or unblock."
      );
    }

    return res.status(200).json({
      success: true,
      message: "The calendar entry was updated."
    });
  } catch (error) {
    return handleError(res, error);
  }
}

function normalizeBooking(body) {
  return {
    requesterName:
      cleanString(body?.requesterName)
        .slice(0, 150),
    phoneNumber:
      cleanString(body?.phoneNumber)
        .slice(0, 50),
    poojaDate:
      cleanString(body?.poojaDate),
    poojaAddress:
      cleanString(body?.poojaAddress)
        .slice(0, 1000),
    requesterNote:
      cleanString(body?.requesterNote)
        .slice(0, 1000)
  };
}

function validateBooking(request) {
  if (!request.requesterName) {
    return "Requester name is required.";
  }

  if (!request.phoneNumber) {
    return "Phone number is required.";
  }

  if (!request.poojaAddress) {
    return "Pooja address is required.";
  }

  if (!isDateString(request.poojaDate)) {
    return "Select a valid Pooja date.";
  }

  if (
    request.poojaDate <
      todayInEasternTime()
  ) {
    return "Select a future Pooja date.";
  }

  if (!getTimeForDate(request.poojaDate)) {
    return "Home Pooja is not available on the selected date.";
  }

  return "";
}

function getTimeForDate(value) {
  if (!isDateString(value)) {
    return "";
  }

  if (THANKSGIVING_DATES.has(value)) {
    return "5:00 PM–8:00 PM";
  }

  const day =
    new Date(value + "T12:00:00Z")
      .getUTCDay();

  if (day === 0) {
    return "9:00 AM–12:00 PM";
  }

  if (day === 6) {
    return "5:00 PM–8:00 PM";
  }

  if (
    day === 5 &&
    value >= MANDALAM_START &&
    value <= MANDALAM_END
  ) {
    return "5:00 PM–8:00 PM";
  }

  return "";
}

async function assertDateCanBeRequested(date) {
  const unavailable =
    await getUnavailableReason(date);

  if (unavailable) {
    const error =
      new Error(unavailable);

    error.status = 409;
    throw error;
  }
}

async function getUnavailableReason(
  date,
  excludedId = null
) {
  if (!getTimeForDate(date)) {
    return "Home Pooja is not available on this date.";
  }

  const entries =
    await fetchEntriesForDate(date);

  const mappedEntries =
    entries
      .filter(row =>
        Number(row.id) !== Number(excludedId)
      )
      .map(mapEntry);

  const conflict =
    mappedEntries
      .find(entry =>
        (entry.entryType === "Blocked" &&
          entry.status === "Blocked") ||
        (entry.entryType === "Booking" &&
          ["Approved", "Submitted"].includes(
            entry.status
          ))
      );

  if (conflict) {
    return conflict.entryType === "Blocked"
      ? conflict.blockReason || "This date is blocked."
      : "This date is already booked.";
  }

  const defaultBlockOverridden =
    mappedEntries.some(entry =>
      entry.entryType === "Blocked" &&
      entry.status === "Cancelled"
    );

  if (
    DEFAULT_BLOCKS.has(date) &&
    !defaultBlockOverridden
  ) {
    return DEFAULT_BLOCKS.get(date);
  }

  return "";
}

async function buildPublicCalendar(
  query = {},
  { includeBookingDetails = false } = {}
) {
  const from =
    isDateString(query?.from)
      ? query.from
      : todayInEasternTime();

  const requestedTo =
    isDateString(query?.to)
      ? query.to
      : addDays(from, 120);

  const maximumTo =
    addDays(from, 370);

  const to =
    requestedTo > maximumTo
      ? maximumTo
      : requestedTo;

  const rows =
    await fetchEntriesBetween(from, to);

  const state = new Map();
  const defaultBlockOverrides = new Set();

  for (const row of rows) {
    const entry =
      mapEntry(row);

    if (
      entry.entryType === "Blocked" &&
      entry.status === "Cancelled"
    ) {
      defaultBlockOverrides.add(
        entry.poojaDate
      );
    }

    if (
      entry.entryType === "Booking" &&
      ["Approved", "Submitted"].includes(
        entry.status
      )
    ) {
      state.set(entry.poojaDate, {
        status: "Booked",
        reason: "Home Pooja booked",
        ...(includeBookingDetails
          ? {
              requesterName:
                entry.requesterName,
              bookingTime:
                entry.preferredTime,
              poojaAddress:
                entry.poojaAddress
            }
          : {})
      });
    }

    if (
      entry.entryType === "Blocked" &&
      entry.status === "Blocked"
    ) {
      state.set(entry.poojaDate, {
        status: "Blocked",
        reason:
          entry.blockReason || "Special event"
      });
    }
  }

  const dates = [];

  for (
    let date = from;
    date <= to;
    date = addDays(date, 1)
  ) {
    const time =
      getTimeForDate(date);

    const defaultReason =
      defaultBlockOverrides.has(date)
        ? ""
        : DEFAULT_BLOCKS.get(date);

    const current =
      state.get(date);

    const isBlocked =
      Boolean(defaultReason) ||
      current?.status === "Blocked";

    if (!time && !isBlocked) {
      continue;
    }

    dates.push({
      date,
      time: time || "",
      status:
        defaultReason
          ? "Blocked"
          : current?.status || "Available",
      reason:
        defaultReason ||
        current?.reason ||
        "",
      ...(includeBookingDetails &&
      current?.status === "Booked"
        ? {
            requesterName:
              current.requesterName || "",
            bookingTime:
              current.bookingTime || time || "",
            poojaAddress:
              current.poojaAddress || ""
          }
        : {})
    });
  }

  return {
    from,
    to,
    dates
  };
}

async function createBooking({
  request,
  email,
  familyId,
  emailVerified
}) {
  const values = {
    [fieldKey(FIELDS.calendarEntry)]:
      request.requesterName +
      " - " +
      request.poojaDate,
    [fieldKey(FIELDS.entryType)]:
      await selectOptionId(
        FIELDS.entryType,
        "Booking"
      ),
    [fieldKey(FIELDS.family)]:
      familyId
        ? [Number(familyId)]
        : [],
    [fieldKey(FIELDS.requesterName)]:
      request.requesterName,
    [fieldKey(FIELDS.email)]:
      email,
    [fieldKey(FIELDS.phoneNumber)]:
      request.phoneNumber,
    [fieldKey(FIELDS.poojaDate)]:
      request.poojaDate,
    [fieldKey(FIELDS.poojaAddress)]:
      request.poojaAddress,
    [fieldKey(FIELDS.preferredTime)]:
      getTimeForDate(request.poojaDate),
    [fieldKey(FIELDS.requestStatus)]:
      await selectOptionId(
        FIELDS.requestStatus,
        "Approved"
      ),
    [fieldKey(FIELDS.requesterNote)]:
      request.requesterNote,
    [fieldKey(FIELDS.emailVerified)]:
      Boolean(emailVerified),
    [fieldKey(FIELDS.approvedBy)]:
      "First come, first served",
    [fieldKey(FIELDS.approvedOn)]:
      todayInEasternTime()
  };

  await createRow(values);
}

async function createBlock(date, reason) {
  const current =
    await getBlockConflictReason(date);

  if (current) {
    const error =
      new Error(current);

    error.status = 409;
    throw error;
  }

  await createRow({
    [fieldKey(FIELDS.calendarEntry)]:
      "Blocked - " + date,
    [fieldKey(FIELDS.entryType)]:
      await selectOptionId(
        FIELDS.entryType,
        "Blocked"
      ),
    [fieldKey(FIELDS.poojaDate)]:
      date,
    [fieldKey(FIELDS.preferredTime)]:
      getTimeForDate(date),
    [fieldKey(FIELDS.requestStatus)]:
      await selectOptionId(
        FIELDS.requestStatus,
        "Blocked"
      ),
    [fieldKey(FIELDS.blockReason)]:
      reason
  });
}

async function getBlockConflictReason(
  date,
  excludedId = null
) {
  const rows =
    await fetchEntriesForDate(date);

  const entries =
    rows
      .filter(row =>
        Number(row.id) !== Number(excludedId)
      )
      .map(mapEntry);

  const conflict =
    entries.find(entry =>
      (entry.entryType === "Blocked" &&
        entry.status === "Blocked") ||
      (entry.entryType === "Booking" &&
        ["Approved", "Submitted"].includes(
          entry.status
        ))
    );

  const defaultBlockOverridden =
    entries.some(entry =>
      entry.entryType === "Blocked" &&
      entry.status === "Cancelled"
    );

  return conflict
    ? conflict.entryType === "Blocked"
      ? conflict.blockReason || "This date is blocked."
      : "This date is already booked."
    : DEFAULT_BLOCKS.has(date) &&
        !defaultBlockOverridden
      ? DEFAULT_BLOCKS.get(date)
      : "";
}

async function editBlockedDate({
  originalDate,
  date,
  reason,
  adminEmail
}) {
  const rows =
    await fetchEntriesForDate(originalDate);

  const activeBlock =
    rows.find(row => {
      const entry = mapEntry(row);

      return (
        entry.entryType === "Blocked" &&
        entry.status === "Blocked"
      );
    });

  const originalConflict =
    await getBlockConflictReason(originalDate);

  if (!activeBlock && !originalConflict) {
    const error =
      new Error("The blocked event no longer exists.");

    error.status = 409;
    throw error;
  }

  const destinationConflict =
    await getBlockConflictReason(
      date,
      activeBlock?.id
    );

  if (
    destinationConflict &&
    !(
      !activeBlock &&
      date === originalDate &&
      DEFAULT_BLOCKS.has(originalDate)
    )
  ) {
    const error =
      new Error(destinationConflict);

    error.status = 409;
    throw error;
  }

  if (activeBlock) {
    await patchEntry(activeBlock.id, {
      [fieldKey(FIELDS.calendarEntry)]:
        "Blocked - " + date,
      [fieldKey(FIELDS.poojaDate)]: date,
      [fieldKey(FIELDS.preferredTime)]:
        getTimeForDate(date),
      [fieldKey(FIELDS.blockReason)]: reason,
      [fieldKey(FIELDS.adminNotes)]:
        "Blocked event edited",
      [fieldKey(FIELDS.approvedBy)]:
        adminEmail,
      [fieldKey(FIELDS.approvedOn)]:
        todayInEasternTime()
    });

    return;
  }

  await unblockDate(
    originalDate,
    "Built-in block edited",
    adminEmail
  );

  await createBlock(date, reason);
}

async function unblockDate(
  date,
  notes,
  adminEmail
) {
  const rows =
    await fetchEntriesForDate(date);

  const activeBlock =
    rows.find(row => {
      const entry = mapEntry(row);

      return (
        entry.entryType === "Blocked" &&
        entry.status === "Blocked"
      );
    });

  const cancelledStatus =
    await selectOptionId(
      FIELDS.requestStatus,
      "Cancelled"
    );

  if (activeBlock) {
    await patchEntry(activeBlock.id, {
      [fieldKey(FIELDS.requestStatus)]:
        cancelledStatus,
      [fieldKey(FIELDS.adminNotes)]: notes,
      [fieldKey(FIELDS.approvedBy)]:
        adminEmail,
      [fieldKey(FIELDS.approvedOn)]:
        todayInEasternTime()
    });

    return;
  }

  if (!DEFAULT_BLOCKS.has(date)) {
    const error =
      new Error("This date is not currently blocked.");

    error.status = 409;
    throw error;
  }

  await createRow({
    [fieldKey(FIELDS.calendarEntry)]:
      "Unblocked - " + date,
    [fieldKey(FIELDS.entryType)]:
      await selectOptionId(
        FIELDS.entryType,
        "Blocked"
      ),
    [fieldKey(FIELDS.poojaDate)]: date,
    [fieldKey(FIELDS.preferredTime)]:
      getTimeForDate(date),
    [fieldKey(FIELDS.requestStatus)]:
      cancelledStatus,
    [fieldKey(FIELDS.blockReason)]:
      DEFAULT_BLOCKS.get(date),
    [fieldKey(FIELDS.adminNotes)]: notes,
    [fieldKey(FIELDS.approvedBy)]:
      adminEmail,
    [fieldKey(FIELDS.approvedOn)]:
      todayInEasternTime()
  });
}

async function claimUnlinkedBookings(
  email,
  familyId
) {
  const rows =
    await fetchRows(
      "filter__field_" +
      FIELDS.email +
      "__equal=" +
      encodeURIComponent(email)
    );

  const familyKey =
    fieldKey(FIELDS.family);

  for (const row of rows) {
    if (
      !Array.isArray(row[familyKey]) ||
      row[familyKey].length === 0
    ) {
      await patchEntry(row.id, {
        [familyKey]: [
          Number(familyId)
        ]
      });
    }
  }
}

async function fetchFamilyBookings(familyId) {
  const rows =
    await fetchRows(
      "filter__field_" +
      FIELDS.family +
      "__link_row_has=" +
      encodeURIComponent(familyId)
    );

  return rows
    .map(mapEntry)
    .filter(entry =>
      entry.entryType === "Booking"
    )
    .sort((a, b) =>
      a.poojaDate.localeCompare(b.poojaDate)
    );
}

async function fetchAllEntries() {
  const rows =
    await fetchRows("");

  return rows
    .map(mapEntry)
    .sort((a, b) =>
      a.poojaDate.localeCompare(b.poojaDate)
    );
}

async function fetchEntriesForDate(date) {
  const rows =
    await fetchRows("");

  return rows.filter(row =>
    cleanString(
      row[fieldKey(FIELDS.poojaDate)]
    ) === date
  );
}

async function fetchEntriesBetween(from, to) {
  const rows =
    await fetchRows("");

  return rows.filter(row => {
    const date =
      cleanString(
        row[fieldKey(FIELDS.poojaDate)]
      );

    return date >= from && date <= to;
  });
}

async function fetchEntry(id) {
  const response =
    await fetch(
      rowUrl(id),
      {
        headers: getBaserowHeaders()
      }
    );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      "Unable to load the calendar entry."
    );
  }

  return response.json();
}

async function fetchRows(filter) {
  const rows = [];
  let page = 1;

  while (true) {
    const separator =
      filter ? "&" + filter : "";

    const response =
      await fetch(
        tableUrl() +
          "?user_field_names=false" +
          "&size=200&page=" +
          page +
          separator,
        {
          headers: getBaserowHeaders()
        }
      );

    if (!response.ok) {
      throw new Error(
        "Unable to load Home Pooja bookings."
      );
    }

    const data =
      await response.json();

    rows.push(
      ...(Array.isArray(data.results)
        ? data.results
        : [])
    );

    if (!data.next) {
      break;
    }

    page += 1;
  }

  return rows;
}

async function createRow(values) {
  const response =
    await fetch(
      tableUrl() +
        "?user_field_names=false",
      {
        method: "POST",
        headers: getBaserowHeaders(),
        body: JSON.stringify(values)
      }
    );

  if (!response.ok) {
    console.error(
      "Home Pooja row creation failed:",
      response.status,
      await response.text()
    );

    throw new Error(
      "Unable to save the Home Pooja request."
    );
  }
}

async function patchEntry(id, values) {
  const response =
    await fetch(
      rowUrl(id),
      {
        method: "PATCH",
        headers: getBaserowHeaders(),
        body: JSON.stringify(values)
      }
    );

  if (!response.ok) {
    console.error(
      "Home Pooja row update failed:",
      response.status,
      await response.text()
    );

    throw new Error(
      "Unable to update the calendar entry."
    );
  }
}

const optionCache = new Map();

async function selectOptionId(fieldId, value) {
  if (!optionCache.has(fieldId)) {
    const response =
      await fetch(
        getBaserowBaseUrl() +
          "/api/database/fields/table/" +
          TABLE_ID +
          "/",
        {
          headers: getBaserowHeaders()
        }
      );

    if (!response.ok) {
      throw new Error(
        "Unable to load Home Pooja configuration."
      );
    }

    const fields =
      await response.json();

    for (const field of fields) {
      if (Array.isArray(field.select_options)) {
        optionCache.set(
          field.id,
          field.select_options
        );
      }
    }
  }

  const option =
    (optionCache.get(fieldId) || [])
      .find(item =>
        cleanString(item.value)
          .toLowerCase() ===
        cleanString(value)
          .toLowerCase()
      );

  if (!option) {
    throw new Error(
      "Home Pooja table is missing option: " +
      value
    );
  }

  return option.id;
}

function mapEntry(row) {
  return {
    id: row.id,
    entryType:
      getSelect(row, FIELDS.entryType),
    requesterName:
      cleanString(
        row[fieldKey(FIELDS.requesterName)]
      ),
    email:
      cleanString(
        row[fieldKey(FIELDS.email)]
      ),
    phoneNumber:
      cleanString(
        row[fieldKey(FIELDS.phoneNumber)]
      ),
    poojaDate:
      cleanString(
        row[fieldKey(FIELDS.poojaDate)]
      ),
    poojaAddress:
      cleanString(
        row[fieldKey(FIELDS.poojaAddress)]
      ),
    preferredTime:
      cleanString(
        row[fieldKey(FIELDS.preferredTime)]
      ),
    status:
      getSelect(row, FIELDS.requestStatus),
    requesterNote:
      cleanString(
        row[fieldKey(FIELDS.requesterNote)]
      ),
    adminNotes:
      cleanString(
        row[fieldKey(FIELDS.adminNotes)]
      ),
    blockReason:
      cleanString(
        row[fieldKey(FIELDS.blockReason)]
      ),
    approvedBy:
      cleanString(
        row[fieldKey(FIELDS.approvedBy)]
      ),
    approvedOn:
      cleanString(
        row[fieldKey(FIELDS.approvedOn)]
      ),
    createdOn:
      cleanString(
        row[fieldKey(FIELDS.createdOn)]
      )
  };
}

function getSelect(row, fieldId) {
  const value =
    row[fieldKey(fieldId)];

  return cleanString(
    value?.value ?? value
  );
}

function hasBoardAccess(memberRow) {
  const role =
    memberRow?.field_10493689;

  const roleId = Number(role?.id ?? role);
  const roleName = cleanString(role?.value)
    .toLowerCase();

  return (
    roleId === 7473605 ||
    roleId === 7473606 ||
    roleName === "board" ||
    roleName === "admin"
  );
}

async function sendVerificationCode(email) {
  const response =
    await fetch(
      process.env.SUPABASE_URL +
        "/auth/v1/otp",
      {
        method: "POST",
        headers: supabaseHeaders(),
        body: JSON.stringify({
          email,
          create_user: true
        })
      }
    );

  if (!response.ok) {
    throw new Error(
      "Unable to send the verification passcode."
    );
  }
}

async function verifyEmailCode(email, code) {
  const token =
    String(code || "")
      .replace(/\D/g, "");

  if (!token) {
    return false;
  }

  const response =
    await fetch(
      process.env.SUPABASE_URL +
        "/auth/v1/verify",
      {
        method: "POST",
        headers: supabaseHeaders(),
        body: JSON.stringify({
          email,
          token,
          type: "email"
        })
      }
    );

  if (!response.ok) {
    return false;
  }

  const data =
    await response.json();

  return Boolean(data.access_token) &&
    normalizeEmail(data?.user?.email) ===
      email;
}

function supabaseHeaders() {
  const key =
    process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!process.env.SUPABASE_URL || !key) {
    throw new Error(
      "Email verification is unavailable."
    );
  }

  return {
    "Content-Type": "application/json",
    apikey: key,
    Authorization: "Bearer " + key
  };
}

function todayInEasternTime() {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    )
      .formatToParts(new Date());

  const values =
    Object.fromEntries(
      parts.map(part => [
        part.type,
        part.value
      ])
    );

  return (
    values.year +
    "-" +
    values.month +
    "-" +
    values.day
  );
}

function addDays(value, count) {
  const date =
    new Date(value + "T12:00:00Z");

  date.setUTCDate(
    date.getUTCDate() + count
  );

  return date
    .toISOString()
    .slice(0, 10);
}

function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/
    .test(cleanString(value));
}

function normalizeEmail(value) {
  return cleanString(value)
    .toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    .test(value);
}

function fieldKey(id) {
  return "field_" + id;
}

function tableUrl() {
  return getBaserowBaseUrl() +
    "/api/database/rows/table/" +
    TABLE_ID +
    "/";
}

function rowUrl(id) {
  return tableUrl() +
    id +
    "/?user_field_names=false";
}

function badRequest(res, message) {
  return res.status(400).json({
    success: false,
    message
  });
}

function methodNotAllowed(res) {
  return res.status(405).json({
    success: false,
    message: "Method not allowed."
  });
}

function handleError(res, error) {
  console.error(
    "Home Pooja API error:",
    error
  );

  return res
    .status(Number(error?.status) || 500)
    .json({
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Home Pooja service is unavailable."
    });
}
