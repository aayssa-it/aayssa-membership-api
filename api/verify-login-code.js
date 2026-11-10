import {
  isMobileClient
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
    const {
      email,
      code
    } = req.body || {};

    const normalizedEmail =
      String(email || "")
        .trim()
        .toLowerCase();

    const token =
      String(code || "")
        .replace(/\D/g, "");

    if (
      !normalizedEmail ||
      !token
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Email and passcode are required."
      });
    }

    const SUPABASE_URL =
      process.env.SUPABASE_URL;

    const SUPABASE_PUBLISHABLE_KEY =
      process.env.SUPABASE_PUBLISHABLE_KEY;

    if (
      !SUPABASE_URL ||
      !SUPABASE_PUBLISHABLE_KEY
    ) {
      console.error(
        "Missing Supabase environment variables."
      );

      return res.status(500).json({
        success: false,
        message:
          "Authentication service unavailable."
      });
    }

    const response =
      await fetch(
        `${SUPABASE_URL}/auth/v1/verify`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey:
              SUPABASE_PUBLISHABLE_KEY,
            Authorization:
              `Bearer ${SUPABASE_PUBLISHABLE_KEY}`
          },
          body:
            JSON.stringify({
              email:
                normalizedEmail,
              token,
              type:
                "email"
            })
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      !data.access_token ||
      !data.refresh_token
    ) {
      console.error(
        "Supabase passcode verification failed:",
        response.status,
        data
      );

      return res.status(401).json({
        success: false,
        message:
          "The passcode is invalid or expired."
      });
    }

    if (isMobileClient(req)) {
      return res.status(200).json({
        success: true,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: Number(data.expires_in) || 3600
      });
    }

    res.setHeader("Set-Cookie", [
      `aayssa_access=${encodeURIComponent(data.access_token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
      `aayssa_refresh=${encodeURIComponent(data.refresh_token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
    ]);

    return res.status(200).json({
      success: true,
      redirectUrl:
        "https://portal.atlantaayyappasevasangam.org/"
    });

  } catch (error) {
    console.error(
      "Verify login code API error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to verify the passcode right now."
    });
  }
}
