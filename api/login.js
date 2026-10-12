import {
  findMemberByEmail
} from "./_lib/aayssa.js";

export default async function handler(req, res) {
  const allowedOrigins = [
    "https://atlantaayyappasevasangam.org",
    "https://www.atlantaayyappasevasangam.org"
  ];

  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    const { email } = req.body || {};

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Please enter your email address."
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const BASEROW_TOKEN = process.env.BASEROW_TOKEN;
    const BASEROW_TABLE_ID = process.env.BASEROW_TABLE_ID;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_PUBLISHABLE_KEY =
      process.env.SUPABASE_PUBLISHABLE_KEY;

    if (
      !BASEROW_TOKEN ||
      !BASEROW_TABLE_ID ||
      !SUPABASE_URL ||
      !SUPABASE_PUBLISHABLE_KEY
    ) {
      console.error("Missing required environment variables.");

      return res.status(500).json({
        success: false,
        message: "Login service is temporarily unavailable."
      });
    }

    const memberExists =
      Boolean(await findMemberByEmail(normalizedEmail));

    /*
      Always return a generic success message to the browser.

      This prevents someone from testing email addresses
      to discover who is registered.
    */

    if (!memberExists) {
      return res.status(200).json({
        success: true,
        message:
          "If this email is registered with AAYSSA, a secure passcode will be sent shortly."
      });
    }

    // Ask Supabase to send the email OTP.
    const supabaseResponse = await fetch(
      `${SUPABASE_URL}/auth/v1/otp`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`
        },
        body: JSON.stringify({
          email: normalizedEmail,
          create_user: true,
          options: {
              email_redirect_to:
                "https://portal.atlantaayyappasevasangam.org"
          }
        })
      }
    );

    if (!supabaseResponse.ok) {
      console.error(
        "Supabase magic-link request failed:",
        supabaseResponse.status,
        await supabaseResponse.text()
      );

      return res.status(500).json({
        success: false,
        message: "Unable to send the login passcode right now."
      });
    }

    return res.status(200).json({
      success: true,
      message:
        "If this email is registered with AAYSSA, a secure passcode will be sent shortly."
    });
  } catch (error) {
    console.error("Login API error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again."
    });
  }
}
