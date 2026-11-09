/*
  Zeffy donation history for one email address.
  Used by GET /api/my-donations (members) and
  /api/register?resource=donations (any donor who verifies their email).
*/

const ZEFFY_API_BASE_URL =
  "https://api.zeffy.com/api/v1";

const DEFAULT_CURRENCY =
  "USD";

export async function getDonationSummary(email) {
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

// ==========================================================
// Donations for any donor who proves they own the email
// (members and non-members). Used by the mobile app.
//
//   POST /api/register?resource=donations
//        { action: "request-code", email }
//        { action: "verify", email, code }   (X-Client: mobile)
//   GET  /api/register?resource=donations
//        Authorization: Bearer <access token from "verify">
//
// Only the verified email's own Zeffy donations are returned.
// ==========================================================

const EMAIL_PATTERN =
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handlePublicDonations(req, res) {
  try {
    if (req.method === "GET") {
      return await getVerifiedDonations(req, res);
    }

    if (req.method !== "POST") {
      return res.status(405).json({
        success: false,
        message: "Method not allowed."
      });
    }

    const action =
      cleanString(req.body?.action);

    const email =
      cleanString(req.body?.email).toLowerCase();

    // Spam honeypot: pretend success, do nothing.
    if (cleanString(req.body?.website)) {
      return res.status(200).json({
        success: true,
        message: "If the email is valid, a verification code has been sent."
      });
    }

    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address."
      });
    }

    if (action === "request-code") {
      await sendDonorCode(email);

      return res.status(200).json({
        success: true,
        message: "A verification code has been sent to your email."
      });
    }

    if (action === "verify") {
      if (String(req.headers["x-client"] || "").toLowerCase() !== "mobile") {
        return res.status(400).json({
          success: false,
          message: "Email verification for donations is available in the mobile app."
        });
      }

      const tokens =
        await verifyDonorCode(email, req.body?.code);

      if (!tokens) {
        return res.status(401).json({
          success: false,
          message: "The code is invalid or expired."
        });
      }

      return res.status(200).json({
        success: true,
        email,
        ...tokens
      });
    }

    return res.status(400).json({
      success: false,
      message: "Select a valid action."
    });
  } catch (error) {
    console.error("Public donations error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load donations right now. Please try again."
    });
  }
}

async function getVerifiedDonations(req, res) {
  const match =
    String(req.headers.authorization || "")
      .match(/^Bearer\s+([A-Za-z0-9._~+/=-]+)$/);

  if (!match) {
    return res.status(401).json({
      success: false,
      message: "Please verify your email."
    });
  }

  const { supabaseUrl, publishableKey } =
    supabaseConfig();

  const userResponse =
    await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${match[1]}`
      }
    });

  if (!userResponse.ok) {
    return res.status(401).json({
      success: false,
      message: "Please verify your email again."
    });
  }

  const user =
    await userResponse.json();

  const email =
    cleanString(user?.email).toLowerCase();

  if (!email) {
    return res.status(401).json({
      success: false,
      message: "Please verify your email again."
    });
  }

  if (!process.env.ZEFFY_API_KEY) {
    throw new Error("Missing ZEFFY_API_KEY.");
  }

  return res.status(200).json({
    success: true,
    email,
    donations: await getDonationSummary(email)
  });
}

async function sendDonorCode(email) {
  const { supabaseUrl, publishableKey } =
    supabaseConfig();

  const response =
    await fetch(`${supabaseUrl}/auth/v1/otp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`
      },
      body: JSON.stringify({
        email,
        create_user: true
      })
    });

  if (!response.ok) {
    console.error("Donor code request failed:", response.status);
    throw new Error("Unable to send verification code.");
  }
}

async function verifyDonorCode(email, code) {
  const { supabaseUrl, publishableKey } =
    supabaseConfig();

  const token =
    String(code || "").replace(/\D/g, "");

  if (!token) {
    return null;
  }

  const response =
    await fetch(`${supabaseUrl}/auth/v1/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`
      },
      body: JSON.stringify({
        email,
        token,
        type: "email"
      })
    });

  if (!response.ok) {
    return null;
  }

  const data =
    await response.json();

  const verifiedEmail =
    cleanString(data?.user?.email).toLowerCase();

  if (!data?.access_token || !data?.refresh_token || verifiedEmail !== email) {
    return null;
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: Number(data.expires_in) || 3600
  };
}

function supabaseConfig() {
  const supabaseUrl =
    process.env.SUPABASE_URL;

  const publishableKey =
    process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !publishableKey) {
    throw new Error("Email verification is not configured.");
  }

  return { supabaseUrl, publishableKey };
}
