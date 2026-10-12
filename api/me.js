import {
  getAuthenticatedMember,
  getSpouseEmail
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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

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

    const row = auth.memberRow;
    const spouseEmail =
      await getSpouseEmail(row);

    // Translate Baserow Role safely
    const roleId =
      row.field_10493689?.id ??
      row.field_10493689?.value ??
      row.field_10493689;

    let role = "Member";

    if (
      Number(roleId) === 7473605 ||
      row.field_10493689?.value === "Board"
    ) {
      role = "Board";
    }

    if (
      Number(roleId) === 7473606 ||
      row.field_10493689?.value === "Admin"
    ) {
      role = "Admin";
    }

    /*
      Return ONLY fields that the member is
      allowed to see.

      Never return the complete Baserow row.
    */

    return res.status(200).json({
      success: true,

      member: {
        firstName: row.field_10227506 || "",
        lastName: row.field_10473214 || "",

        membershipId:
          row.field_10361167 || "",

        status:
          row.field_10227507?.value ||
          row.field_10227507 ||
          "",

        role,

        email:
          row.field_10281594 || "",

        spouseEmail,

        mobileNumber:
          row.field_10281595 || "",

        address:
          row.field_10281618 || "",

        spouseFirstName:
          row.field_10227562 || "",

        spouseLastName:
          row.field_10473216 || "",

        noOfAdults:
          row.field_10281686 ?? null,

        noOfKids:
          row.field_10281655 ?? null,

        volunteerInterest:
          row.field_10281690 || [],

        areasOfInterest:
          row.field_10281806 || [],

        emailOptIn:
          Boolean(row.field_10281810),

        textOptIn:
          Boolean(row.field_10281812),

        editProfileLink:
          row.field_10361006 || ""
      }
    });

  } catch (error) {
    console.error("Member profile API error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load member profile."
    });
  }
}
