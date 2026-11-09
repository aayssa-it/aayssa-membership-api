import {
  getAuthenticatedMember
} from "./_lib/aayssa.js";
import {
  getDonationSummary
} from "./_lib/donations.js";

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
