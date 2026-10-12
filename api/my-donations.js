import {
  getAuthenticatedMember
} from "./_lib/aayssa.js";

const ZEFFY_API_BASE_URL =
  "https://api.zeffy.com/api/v1";

const DEFAULT_CURRENCY =
  "USD";

export default async function handler(req, res) {
  if (req.method !== "GET") {
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

    if (!process.env.ZEFFY_API_KEY) {
      console.error(
        "Missing ZEFFY_API_KEY."
      );

      return res.status(500).json({
        success: false,
        message: "Donation service unavailable."
      });
    }

    const donations =
      await getDonationSummary(
        auth.primaryEmail || auth.normalizedEmail
      );

    return res.status(200).json({
      success: true,
      donations
    });

  } catch (error) {
    console.error(
      "My donations API error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Unable to load donation records."
    });
  }
}

async function getDonationSummary(email) {
  const year =
    new Date().getUTCFullYear();

  const yearStart =
    Math.floor(Date.UTC(year, 0, 1) / 1000);

  const nextYearStart =
    Math.floor(Date.UTC(year + 1, 0, 1) / 1000);

  const contacts =
    await fetchZeffyPages(
      "/contacts",
      {
        email
      }
    );

  const matchingContacts =
    contacts.filter(contact =>
      String(contact.email || "")
        .trim()
        .toLowerCase() === email
    );

  const paymentsById =
    new Map();

  for (const contact of matchingContacts) {
    if (!contact.id) {
      continue;
    }

    const payments =
      await fetchZeffyPages(
        "/payments",
        {
          contact:
            contact.id,
          status:
            "succeeded",
          "created[gte]":
            yearStart,
          "created[lte]":
            nextYearStart - 1
        }
      );

    payments.forEach(payment => {
      if (payment.id) {
        paymentsById.set(
          payment.id,
          payment
        );
      }
    });
  }

  const payments =
    Array.from(paymentsById.values())
      .map(mapPayment)
      .sort((left, right) =>
        right.createdTimestamp - left.createdTimestamp
      );

  const currency =
    payments[0]?.currency ||
    matchingContacts[0]?.currency ||
    DEFAULT_CURRENCY;

  return {
    year,
    currency:
      String(currency).toUpperCase(),
    totalPaidThisYear:
      payments.reduce(
        (total, payment) =>
          total + payment.amount,
        0
      ),
    taxReceiptCount:
      payments.filter(payment =>
        Boolean(payment.receiptUrl)
      ).length,
    payments:
      payments.map(payment => ({
        id:
          payment.id,
        date:
          payment.date,
        amount:
          payment.amount,
        eligibleAmount:
          payment.eligibleAmount,
        currency:
          payment.currency,
        description:
          payment.description,
        receiptUrl:
          payment.receiptUrl
      }))
  };
}

async function fetchZeffyPages(path, params) {
  const rows = [];
  let cursor = "";

  do {
    const url =
      new URL(`${ZEFFY_API_BASE_URL}${path}`);

    url.searchParams.set(
      "limit",
      "100"
    );

    Object.entries(params).forEach(([key, value]) => {
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
        "Zeffy API request failed:",
        response.status,
        path
      );

      throw new Error(
        "Unable to load Zeffy records."
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

function mapPayment(payment) {
  const createdTimestamp =
    Number(payment.created || 0);

  return {
    id:
      String(payment.id || ""),
    createdTimestamp,
    date:
      createdTimestamp
        ? new Date(createdTimestamp * 1000).toISOString()
        : "",
    amount:
      centsToDollars(payment.amount),
    eligibleAmount:
      centsToDollars(
        payment.eligible_amount ?? payment.amount
      ),
    currency:
      String(payment.currency || DEFAULT_CURRENCY).toUpperCase(),
    description:
      cleanString(payment.description) ||
      "AAYSSA Donation",
    receiptUrl:
      cleanString(payment.receipt_url)
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

function cleanString(value) {
  return String(value ?? "")
    .trim();
}
