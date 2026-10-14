import {
  VOLUNTEERS_TABLE_ID,
  findMemberByEmail,
  mapVolunteerRow
} from "./_lib/aayssa.js";
import {
  fetchMaaladharanDashboardSummary
} from "./_lib/maaladharan.js";
import {
  handleFeedbackDigest
} from "./_lib/feedback.js";

const ZEFFY_API_BASE_URL =
  "https://api.zeffy.com/api/v1";

const DEFAULT_DONATION_CURRENCY =
  "USD";

export default async function handler(req, res) {

  if (req.query?.resource === "feedback-digest") {
    return handleFeedbackDigest(req, res);
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  try {

    const cookies =
      parseCookies(req.headers.cookie || "");

    const accessToken =
      cookies.aayssa_access;


    if (!accessToken) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated."
      });
    }


    const SUPABASE_URL =
      process.env.SUPABASE_URL;

    const SUPABASE_PUBLISHABLE_KEY =
      process.env.SUPABASE_PUBLISHABLE_KEY;

    const BASEROW_TOKEN =
      process.env.BASEROW_TOKEN;

    const BASEROW_TABLE_ID =
      process.env.BASEROW_TABLE_ID;

    const BASEROW_VOLUNTEERS_TABLE_ID =
      process.env.BASEROW_VOLUNTEERS_TABLE_ID ||
      VOLUNTEERS_TABLE_ID;


    if (
      !SUPABASE_URL ||
      !SUPABASE_PUBLISHABLE_KEY ||
      !BASEROW_TOKEN ||
      !BASEROW_TABLE_ID ||
      !BASEROW_VOLUNTEERS_TABLE_ID
    ) {

      console.error(
        "Missing required environment variables."
      );

      return res.status(500).json({
        success: false,
        message: "Dashboard service unavailable."
      });
    }



    // ==================================================
    // 1. Validate current Supabase session
    // ==================================================

    const userResponse =
      await fetch(
        `${SUPABASE_URL}/auth/v1/user`,
        {
          headers: {

            apikey:
              SUPABASE_PUBLISHABLE_KEY,

            Authorization:
              `Bearer ${accessToken}`
          }
        }
      );


    if (!userResponse.ok) {

      return res.status(401).json({
        success: false,
        message: "Session expired."
      });
    }


    const user =
      await userResponse.json();


    if (!user?.email) {

      return res.status(401).json({
        success: false,
        message:
          "Authenticated email unavailable."
      });
    }


    const normalizedEmail =
      String(user.email)
        .trim()
        .toLowerCase();



    // ==================================================
    // 2. Look up authenticated member in Baserow
    // ==================================================

    const memberRow =
      await findMemberByEmail(normalizedEmail);

    if (!memberRow) {

      return res.status(403).json({
        success: false,
        message: "Membership not found."
      });
    }


    // ==================================================
    // 3. Server-side BOARD / ADMIN authorization
    //
    // Member = 7473604
    // Board  = 7473605
    // Admin  = 7473606
    // ==================================================

    const roleField =
      memberRow.field_10493689;


    const roleId =
      roleField?.id ??
      roleField?.value ??
      roleField;


    const roleName =
      roleField?.value ??
      "";


    const isBoardOrAdmin =
      Number(roleId) === 7473605 ||
      Number(roleId) === 7473606 ||
      roleName === "Board" ||
      roleName === "Admin";


    if (!isBoardOrAdmin) {

      return res.status(403).json({
        success: false,
        message:
          "Board or administrator access required."
      });
    }



    // ==================================================
    // 4. Find Baserow automatic "Created on" field
    //
    // We discover it by field TYPE instead of
    // hard-coding a field ID.
    // ==================================================

    let createdOnFieldKey = null;


    try {

      createdOnFieldKey =
        await findCreatedOnFieldKey(
          BASEROW_TABLE_ID,
          BASEROW_TOKEN
        );


      if (!createdOnFieldKey) {

        console.warn(
          "No Baserow Created on field was found."
        );
      }


    } catch (error) {

      console.error(
        "Unable to discover Created on field:",
        error
      );

      // Dashboard should continue working even if
      // registration trends cannot be calculated.

      createdOnFieldKey = null;
    }



    // ==================================================
    // 5. Retrieve ALL membership rows
    //
    // SERVER-SIDE only.
    // Baserow token never reaches browser.
    // ==================================================

    const rows =
      await fetchAllBaserowRows(
        BASEROW_TABLE_ID,
        BASEROW_TOKEN
      );

    const volunteerRows =
      await fetchAllBaserowRows(
        BASEROW_VOLUNTEERS_TABLE_ID,
        BASEROW_TOKEN
      );



    // ==================================================
    // 6. Aggregate current dashboard statistics
    // ==================================================

    let registeredFamilies = 0;

    let activeFamilies = 0;

    let totalAdults = 0;

    let totalKids = 0;


    const volunteerCounts = {

      Pooja: 0,

      Annadhanam: 0,

      Bhajan: 0,

      Media: 0,

      Decorations: 0
    };


    let primaryMemberVolunteers = 0;

    let spouseVolunteers = 0;

    let otherFamilyVolunteers = 0;



    // Store valid registration dates here.
    const registrationDates = [];



    for (const row of rows) {

      registeredFamilies += 1;



      // ----------------------------------------------
      // Membership Status
      // field_10227507
      // ----------------------------------------------

      const status =
        row.field_10227507?.value ??
        row.field_10227507 ??
        "";


      if (
        String(status)
          .toLowerCase() === "active"
      ) {

        activeFamilies += 1;
      }



      // ----------------------------------------------
      // Adults
      // field_10281686
      // ----------------------------------------------

      totalAdults +=
        safeNumber(
          row.field_10281686
        );



      // ----------------------------------------------
      // Kids
      // field_10281655
      // ----------------------------------------------

      totalKids +=
        safeNumber(
          row.field_10281655
        );



      // ----------------------------------------------
      // Registration Date / Created on
      // ----------------------------------------------

      if (createdOnFieldKey) {

        const rawCreatedOn =
          row[createdOnFieldKey];


        const createdDate =
          parseBaserowDate(
            rawCreatedOn
          );


        if (createdDate) {

          registrationDates.push(
            createdDate
          );
        }
      }
    }

    for (const row of volunteerRows) {

      const volunteer =
        mapVolunteerRow(row);

      if (
        !volunteer.active ||
        !volunteer.interested
      ) {
        continue;
      }

      if (volunteer.memberType === "primary") {
        primaryMemberVolunteers += 1;
      } else if (volunteer.memberType === "spouse") {
        spouseVolunteers += 1;
      } else {
        otherFamilyVolunteers += 1;
      }

      for (const interest of volunteer.areas) {

        if (
          Object.prototype
            .hasOwnProperty.call(
              volunteerCounts,
              interest
            )
        ) {

          volunteerCounts[interest] += 1;
        }
      }
    }



    const totalPeople =
      totalAdults + totalKids;



    // ==================================================
    // 7. Build last 12 months Registration Trends
    // ==================================================

    let registrationTrends = [];


    if (createdOnFieldKey) {

      registrationTrends =
        buildRegistrationTrends(
          registrationDates,
          12
        );
    }

    const [
      donationSummary,
      maaladharanSummary
    ] =
      await Promise.all([
        safeFetchAdminDonationSummary(),
        safeFetchMaaladharanDashboardSummary()
      ]);



    // ==================================================
    // 8. Return aggregate dashboard information only
    // ==================================================

    return res.status(200).json({

      success: true,

      stats: {

        registeredFamilies,

        activeFamilies,

        totalAdults,

        totalKids,

        totalPeople,


        volunteerCounts,


        volunteerParticipation: {

          primaryMember:
            primaryMemberVolunteers,

          spouse:
            spouseVolunteers,

          otherFamilyMember:
            otherFamilyVolunteers
        },


        // --------------------------------------------
        // NEW: Registration trend information
        // --------------------------------------------

        registrationTrendAvailable:
          Boolean(createdOnFieldKey),


        registrationTrends,


        donationSummary,

        maaladharanSummary

      }
    });



  } catch (error) {

    console.error(
      "Dashboard stats API error:",
      error
    );


    return res.status(500).json({

      success: false,

      message:
        "Unable to load dashboard statistics."
    });
  }
}





// ====================================================
// Find Baserow automatic Created on field
//
// Calls the table field-schema endpoint and searches
// for a field whose type is "created_on".
//
// Returns something like:
//
// field_12345678
//
// No Created on field ID needs to be hard-coded.
// ====================================================

async function findCreatedOnFieldKey(
  tableId,
  token
) {

  const url =
    `https://api.baserow.io/api/database/fields/table/${tableId}/`;


  const response =
    await fetch(
      url,
      {
        headers: {
          Authorization:
            `Token ${token}`
        }
      }
    );


  if (!response.ok) {

    throw new Error(
      `Unable to retrieve Baserow field schema: ${response.status}`
    );
  }


  const fields =
    await response.json();


  if (!Array.isArray(fields)) {

    return null;
  }



  // First preference:
  // specifically find an automatic Created on field.

  const createdOnField =
    fields.find(field =>
      field?.type === "created_on"
    );


  if (
    !createdOnField ||
    !createdOnField.id
  ) {

    return null;
  }


  return `field_${createdOnField.id}`;
}





// ====================================================
// Retrieve every Baserow row
//
// Baserow paginates responses.
// Pagination is handled server-side.
// ====================================================

async function fetchAllBaserowRows(
  tableId,
  token
) {

  const rows = [];

  let page = 1;

  const size = 200;


  while (true) {

    const url =
      `https://api.baserow.io/api/database/rows/table/${tableId}/` +
      `?user_field_names=false` +
      `&page=${page}` +
      `&size=${size}`;


    const response =
      await fetch(
        url,
        {
          headers: {
            Authorization:
              `Token ${token}`
          }
        }
      );


    if (!response.ok) {

      throw new Error(
        `Baserow rows request failed: ${response.status}`
      );
    }


    const data =
      await response.json();


    if (
      Array.isArray(data.results)
    ) {

      rows.push(
        ...data.results
      );
    }


    if (!data.next) {
      break;
    }


    page += 1;
  }


  return rows;
}


async function safeFetchMaaladharanDashboardSummary() {
  try {
    return await fetchMaaladharanDashboardSummary();
  } catch (error) {
    console.error(
      "Maaladharan dashboard summary error:",
      error
    );

    return {
      available: false,
      season: "2026-27 Mandalam",
      totalSwamies: 0,
      registeredSwamies: [],
      padiCounts: [],
      dateCounts: []
    };
  }
}


async function safeFetchAdminDonationSummary() {
  try {
    return await fetchAdminDonationSummary();
  } catch (error) {
    console.error(
      "Dashboard donation summary unavailable:",
      error
    );

    return buildUnavailableDonationSummary();
  }
}


async function fetchAdminDonationSummary() {
  if (!process.env.ZEFFY_API_KEY) {
    console.warn(
      "Missing ZEFFY_API_KEY; dashboard donation summary unavailable."
    );

    return buildUnavailableDonationSummary();
  }

  const year =
    new Date().getUTCFullYear();

  const yearStart =
    Math.floor(Date.UTC(year, 0, 1) / 1000);

  const nextYearStart =
    Math.floor(Date.UTC(year + 1, 0, 1) / 1000);

  const payments =
    await fetchZeffyPages(
      "/payments",
      {
        status:
          "succeeded",
        "created[gte]":
          yearStart,
        "created[lte]":
          nextYearStart - 1
      }
    );

  const mappedPayments =
    payments.map(mapZeffyPayment);

  const currency =
    mappedPayments[0]?.currency ||
    DEFAULT_DONATION_CURRENCY;

  return {
    available: true,
    year,
    currency,
    totalPaidThisYear:
      mappedPayments.reduce(
        (total, payment) =>
          total + payment.amount,
        0
      ),
    paymentCount:
      mappedPayments.length,
    monthlyDonations:
      buildMonthlyDonationTrends(
        mappedPayments,
        12
      )
  };
}


function buildUnavailableDonationSummary() {
  return {
    available: false,
    year:
      new Date().getUTCFullYear(),
    currency:
      DEFAULT_DONATION_CURRENCY,
    totalPaidThisYear:
      0,
    paymentCount:
      0,
    monthlyDonations:
      []
  };
}


async function fetchZeffyPages(
  path,
  params
) {
  const rows = [];

  let cursor = "";

  do {
    const url =
      new URL(`${ZEFFY_API_BASE_URL}${path}`);

    url.searchParams.set(
      "limit",
      "100"
    );

    Object
      .entries(params || {})
      .forEach(([key, value]) => {
        if (
          value !== undefined &&
          value !== null &&
          value !== ""
        ) {
          url.searchParams.set(
            key,
            String(value)
          );
        }
      });

    if (cursor) {
      url.searchParams.set(
        "starting_after",
        cursor
      );
    }

    const response =
      await fetch(
        url,
        {
          headers: {
            Authorization:
              `Bearer ${process.env.ZEFFY_API_KEY}`
          }
        }
      );

    if (!response.ok) {
      console.error(
        "Zeffy dashboard API request failed:",
        response.status,
        path
      );

      throw new Error(
        "Unable to load Zeffy dashboard records."
      );
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
  } while (cursor);

  return rows;
}


function mapZeffyPayment(payment) {
  const createdTimestamp =
    Number(payment.created || 0);

  return {
    createdDate:
      createdTimestamp
        ? new Date(createdTimestamp * 1000)
        : null,
    amount:
      centsToDollars(payment.amount),
    currency:
      String(
        payment.currency ||
        DEFAULT_DONATION_CURRENCY
      ).toUpperCase()
  };
}


function centsToDollars(value) {
  const amount =
    Number(value || 0);

  if (!Number.isFinite(amount)) {
    return 0;
  }

  return Math.round(amount) / 100;
}


function buildMonthlyDonationTrends(
  payments,
  numberOfMonths = 12
) {
  const months =
    buildMonthBuckets(numberOfMonths)
      .map(item => ({
        ...item,
        amount: 0,
        count: 0
      }));

  const monthMap =
    new Map(
      months.map(item => [
        item.month,
        item
      ])
    );

  for (const payment of payments) {
    if (!payment.createdDate) {
      continue;
    }

    const parts =
      getDatePartsInTimeZone(
        payment.createdDate,
        "America/New_York"
      );

    const monthKey =
      `${parts.year}-${String(parts.month).padStart(2, "0")}`;

    const target =
      monthMap.get(monthKey);

    if (target) {
      target.amount += payment.amount;
      target.count += 1;
    }
  }

  return months.map(item => ({
    ...item,
    amount:
      Math.round(item.amount * 100) / 100
  }));
}


function buildMonthBuckets(
  numberOfMonths = 12
) {
  const timeZone =
    "America/New_York";

  const nowParts =
    getDatePartsInTimeZone(
      new Date(),
      timeZone
    );

  const months = [];

  for (
    let offset = numberOfMonths - 1;
    offset >= 0;
    offset--
  ) {
    const monthDate =
      new Date(
        nowParts.year,
        nowParts.month - 1 - offset,
        1
      );

    const year =
      monthDate.getFullYear();

    const month =
      monthDate.getMonth() + 1;

    months.push({
      month:
        `${year}-${String(month).padStart(2, "0")}`,
      label:
        monthDate.toLocaleString(
          "en-US",
          {
            month: "short",
            year: "numeric"
          }
        )
    });
  }

  return months;
}





// ====================================================
// Build monthly registration trends
//
// Example output:
//
// [
//   {
//     month: "2026-01",
//     label: "Jan 2026",
//     count: 3
//   },
//   {
//     month: "2026-02",
//     label: "Feb 2026",
//     count: 7
//   }
// ]
//
// Includes months with ZERO registrations so the
// chart stays continuous.
// ====================================================

function buildRegistrationTrends(
  dates,
  numberOfMonths = 12
) {

  const timeZone =
    "America/New_York";


  // Get today's Atlanta year/month
  const nowParts =
    getDatePartsInTimeZone(
      new Date(),
      timeZone
    );


  const currentYear =
    nowParts.year;

  const currentMonth =
    nowParts.month;


  const months = [];


  // Create the last 12 Atlanta calendar months
  for (
    let offset = numberOfMonths - 1;
    offset >= 0;
    offset--
  ) {

    const monthDate =
      new Date(
        currentYear,
        currentMonth - 1 - offset,
        1
      );


    const year =
      monthDate.getFullYear();

    const month =
      monthDate.getMonth() + 1;


    const monthKey =
      `${year}-${String(month).padStart(2, "0")}`;


    const label =
      monthDate.toLocaleString(
        "en-US",
        {
          month: "short",
          year: "numeric"
        }
      );


    months.push({
      month: monthKey,
      label,
      count: 0
    });
  }


  const monthMap =
    new Map(
      months.map(item => [
        item.month,
        item
      ])
    );


  // Count registrations using Atlanta local date
  for (const date of dates) {

    const parts =
      getDatePartsInTimeZone(
        date,
        timeZone
      );


    const monthKey =
      `${parts.year}-${String(parts.month).padStart(2, "0")}`;


    const target =
      monthMap.get(monthKey);


    if (target) {
      target.count += 1;
    }
  }


  return months;
}

function getDatePartsInTimeZone(
  date,
  timeZone
) {

  const formatter =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric"
      }
    );


  const parts =
    formatter.formatToParts(date);


  const values = {};


  for (const part of parts) {

    if (
      part.type === "year" ||
      part.type === "month" ||
      part.type === "day"
    ) {

      values[part.type] =
        Number(part.value);
    }
  }


  return {
    year: values.year,
    month: values.month,
    day: values.day
  };
}

// ====================================================
// Safely parse Baserow Created on timestamp
// ====================================================

function parseBaserowDate(value) {

  if (!value) {
    return null;
  }


  // Baserow normally returns an ISO date/time string.

  const date =
    new Date(value);


  if (
    Number.isNaN(
      date.getTime()
    )
  ) {

    return null;
  }


  return date;
}





// ====================================================
// Convert Baserow number values safely
// ====================================================

function safeNumber(value) {

  const number =
    Number(value);


  if (
    Number.isFinite(number)
  ) {

    return number;
  }


  return 0;
}





// ====================================================
// Convert Baserow multi-select values into strings
// ====================================================

function getMultiSelectValues(items) {

  if (!Array.isArray(items)) {
    return [];
  }


  return items
    .map(item => {

      if (
        typeof item === "string"
      ) {

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





// ====================================================
// Parse HttpOnly cookies
// ====================================================

function parseCookies(cookieHeader) {

  const cookies = {};


  cookieHeader
    .split(";")
    .forEach(cookie => {

      const index =
        cookie.indexOf("=");


      if (index === -1) {
        return;
      }


      const key =
        cookie
          .slice(0, index)
          .trim();


      const value =
        cookie
          .slice(index + 1)
          .trim();


      if (key) {

        cookies[key] =
          decodeURIComponent(value);
      }
    });


  return cookies;
}
