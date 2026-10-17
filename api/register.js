import {
  buildVolunteerPayload,
  createVolunteerRow,
  findMemberByEmail,
  getPrimaryName,
  getSpouseEmailFieldKey,
  getSpouseName
} from "./_lib/aayssa.js";
import {
  handlePublicMaaladharan
} from "./_lib/maaladharan.js";
import {
  handlePublicHomePooja
} from "./_lib/home-pooja.js";
import {
  handlePublicFeedback
} from "./_lib/feedback.js";
import {
  handlePublicRsvp
} from "./_lib/rsvp.js";

const AAYSSA_FAMILY_WHATSAPP_URL =
  "https://chat.whatsapp.com/CDH3nm4UUslCpLUxeoBVab?mode=gi_t";
const AAYSSA_OFFICIAL_EMAIL = "aayssa.official@gmail.com";

export default async function handler(req, res) {

  // =========================================================
  // CORS
  // Allow the AAYSSA website to call this API
  // =========================================================

  const allowedOrigins = [
    "https://atlantaayyappasevasangam.org",
    "https://www.atlantaayyappasevasangam.org"
  ];

  const origin =
    req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );
  }

  res.setHeader("Vary", "Origin");

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  // Handle browser preflight request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.query?.resource === "home-pooja") {
    return handlePublicHomePooja(req, res);
  }

  if (req.query?.resource === "feedback") {
    return handlePublicFeedback(req, res);
  }

  if (req.query?.resource === "rsvp") {
    return handlePublicRsvp(req, res);
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  if (req.query?.resource === "maaladharan") {
    return handlePublicMaaladharan(req, res);
  }

  try {

    // =========================================================
    // 1. Get submitted values
    // =========================================================

    const {
      firstName,
      lastName,
      spouseFirstName,
      spouseLastName,
      spouseEmail,
      email,
      mobileNumber,
      address,
      noOfKids,
      noOfAdults,
      volunteerInterest,
      areasOfInterest,
      primaryVolunteer,
      spouseVolunteer,
      additionalVolunteers,
      emailOptIn,
      textOptIn
    } = req.body || {};


    // =========================================================
    // 2. Normalize email and phone
    // =========================================================

    const normalizedEmail = String(email || "")
      .trim()
      .toLowerCase();

    const normalizedSpouseEmail =
      String(spouseEmail || "")
        .trim()
        .toLowerCase();

    const normalizedPhone = String(mobileNumber || "")
      .replace(/\D/g, "")
      .slice(-10);


    // =========================================================
    // 3. Required field validation
    // =========================================================

    if (
      !String(firstName || "").trim() ||
      !String(lastName || "").trim() ||
      !normalizedEmail ||
      !normalizedPhone
    ) {

      return res.status(400).json({
        success: false,
        message:
          "First Name, Last Name, Email and Mobile Number are required."
      });
    }


    // =========================================================
    // 4. Validate phone
    // =========================================================

    if (normalizedPhone.length !== 10) {

      return res.status(400).json({
        success: false,
        message:
          "Please enter a valid 10-digit U.S. mobile number."
      });
    }


    // =========================================================
    // 5. Validate email
    // =========================================================

    const emailPattern =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(normalizedEmail)) {

      return res.status(400).json({
        success: false,
        message:
          "Please enter a valid email address."
      });
    }

    if (
      normalizedSpouseEmail &&
      !emailPattern.test(normalizedSpouseEmail)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please enter a valid spouse email address."
      });
    }

    if (
      normalizedSpouseEmail &&
      normalizedSpouseEmail === normalizedEmail
    ) {
      return res.status(400).json({
        success: false,
        message:
          "The spouse email must be different from the primary email."
      });
    }


    // =========================================================
    // 6. Load secure Vercel environment variables
    // =========================================================

    const BASEROW_TOKEN =
      process.env.BASEROW_TOKEN;

    const TABLE_ID =
      process.env.BASEROW_TABLE_ID;

    if (!BASEROW_TOKEN || !TABLE_ID) {
      throw new Error(
        "Server configuration is missing."
      );
    }


    const headers = {
      Authorization: `Token ${BASEROW_TOKEN}`,
      "Content-Type": "application/json"
    };


    // =========================================================
    // 7. Check duplicate normalized email
    //
    // Normalized Email field:
    // field_10464593
    // =========================================================

    const existingPrimaryEmailMember =
      await findMemberByEmail(normalizedEmail);

    const existingSpouseEmailMember =
      normalizedSpouseEmail
        ? await findMemberByEmail(normalizedSpouseEmail)
        : null;

    const spouseEmailFieldKey =
      await getSpouseEmailFieldKey();

    if (
      normalizedSpouseEmail &&
      !spouseEmailFieldKey
    ) {
      throw new Error(
        "The Spouse Email Address field is missing from the member table."
      );
    }


    // =========================================================
    // 8. Check duplicate normalized phone
    //
    // Normalized Phone field:
    // field_10464626
    // =========================================================

    const phoneUrl =
      `https://api.baserow.io/api/database/rows/table/${TABLE_ID}/` +
      `?user_field_names=false` +
      `&filter__field_10464626__equal=` +
      encodeURIComponent(normalizedPhone);


    const phoneResponse =
      await fetch(phoneUrl, {
        method: "GET",
        headers
      });


    if (!phoneResponse.ok) {

      const errorText =
        await phoneResponse.text();

      console.error(
        "Baserow phone lookup failed:",
        errorText
      );

      throw new Error(
        "Unable to check phone duplicates."
      );
    }


    const phoneData =
      await phoneResponse.json();


    const emailExists =
      Boolean(
        existingPrimaryEmailMember ||
        existingSpouseEmailMember
      );

    const phoneExists =
      phoneData.count > 0;


    // =========================================================
    // 9. Block duplicate registration
    // =========================================================

    if (emailExists && phoneExists) {

      return res.status(409).json({
        success: false,
        duplicate: true,
        type: "both",
        message:
          "You are already registered with AAYSSA. Please use the Update My Profile link from your welcome email."
      });
    }


    if (emailExists) {

      return res.status(409).json({
        success: false,
        duplicate: true,
        type: "email",
        message:
          "This email address is already registered with AAYSSA. Please use the Update My Profile link from your welcome email."
      });
    }


    if (phoneExists) {

      return res.status(409).json({
        success: false,
        duplicate: true,
        type: "phone",
        message:
          "This mobile number is already registered with AAYSSA. Please use the Update My Profile link or contact AAYSSA for assistance."
      });
    }


    // =========================================================
    // 10. Prepare new Baserow member
    // =========================================================

    const newMember = {

      // First Name
      field_10227506:
        String(firstName).trim(),

      // Last Name
      field_10473214:
        String(lastName).trim(),

      // Membership Status
      field_10227507:
        "Active",

      // Every public registration starts as Member
      field_10493689: 7473604,
    
      // Spouse First Name
      field_10227562:
        spouseFirstName
          ? String(spouseFirstName).trim()
          : "",

      // Spouse Last Name
      field_10473216:
        spouseLastName
          ? String(spouseLastName).trim()
          : "",

      // Email
      // Store lowercase normalized version
      field_10281594:
        normalizedEmail,

      // Mobile Number
      // Store standardized 10-digit version
      field_10281595:
        normalizedPhone,

      // Address
      field_10281618:
        address
          ? String(address).trim()
          : "",

      // No. of Kids
      field_10281655:
        noOfKids === "" ||
        noOfKids === undefined ||
        noOfKids === null
          ? null
          : Number(noOfKids),

      // No. of Adults
      field_10281686:
        noOfAdults === "" ||
        noOfAdults === undefined ||
        noOfAdults === null
          ? null
          : Number(noOfAdults),

      // Email Opt-in
      field_10281810:
        Boolean(emailOptIn),

      // Text Opt-in
      field_10281812:
        Boolean(textOptIn),
    
      // Role = Member
      field_10493689: 7473604
    };

    if (spouseEmailFieldKey) {
      newMember[spouseEmailFieldKey] =
        normalizedSpouseEmail;
    }


    // =========================================================
    // 11. Create member in Baserow
    // =========================================================

    const createUrl =
      `https://api.baserow.io/api/database/rows/table/${TABLE_ID}/` +
      `?user_field_names=false`;


    const createResponse =
      await fetch(createUrl, {

        method: "POST",

        headers,

        body: JSON.stringify(
          newMember
        )
      });


    if (!createResponse.ok) {

      const errorText =
        await createResponse.text();

      console.error(
        "Baserow member creation failed:",
        errorText
      );

      return res.status(500).json({
        success: false,
        message:
          "We could not complete your registration. Please try again."
      });
    }


    const createdMember =
      await createResponse.json();


    // =========================================================
    // 12. Create per-person volunteer records
    // =========================================================

    try {
      await createRegistrationVolunteerRows({
        familyRow: createdMember,
        legacyVolunteerInterest:
          volunteerInterest,
        legacyAreasOfInterest:
          areasOfInterest,
        primaryVolunteer,
        spouseVolunteer,
        additionalVolunteers
      });

    } catch (error) {
      console.error(
        "Baserow volunteer record creation failed after member registration:",
        error
      );
    }

    const confirmationEmailSent =
      await sendMembershipConfirmationSafely({
        email: normalizedEmail,
        firstName: String(firstName).trim(),
        lastName: String(lastName).trim()
      });


    // =========================================================
    // 13. Successful registration
    // =========================================================

    return res.status(201).json({

      success: true,

      duplicate: false,

      message:
        confirmationEmailSent
          ? "Thank you! Your AAYSSA membership registration has been successfully submitted. A confirmation email has been sent."
          : "Thank you! Your AAYSSA membership registration has been successfully submitted.",

      confirmationEmailSent,

      memberRowId:
        createdMember.id
    });


  } catch (error) {

    console.error(
      "AAYSSA Registration API:",
      error
    );

    return res.status(500).json({

      success: false,

      message:
        "Unable to process your registration at this time. Please try again later."
    });
  }
}

async function sendMembershipConfirmationSafely({
  email,
  firstName,
  lastName
}) {
  try {
    await sendMembershipConfirmation({
      email,
      firstName,
      lastName
    });
    return true;
  } catch (error) {
    console.error(
      "Membership confirmation email error:",
      error
    );
    return false;
  }
}

async function sendMembershipConfirmation({
  email,
  firstName,
  lastName
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from =
    process.env.RESEND_FROM_EMAIL ||
    process.env.RESEND_FROM ||
    process.env.EMAIL_FROM ||
    process.env.FROM_EMAIL;

  if (!apiKey || !from) {
    throw new Error(
      "Resend confirmation email is not configured."
    );
  }

  const fullName =
    `${firstName} ${lastName}`.trim();
  const replyTo =
    process.env.RESEND_REPLY_TO_EMAIL;

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to: [email],
        cc: [AAYSSA_OFFICIAL_EMAIL],
        subject:
          "Welcome to the AAYSSA Family",
        ...(replyTo ? { reply_to: replyTo } : {}),
        text: [
          `Swamiye Saranam Ayyappa, ${fullName}.`,
          "",
          "Thank you for registering with Atlanta Ayyappa Seva Sangam. Your AAYSSA membership registration has been received.",
          "",
          `Join the AAYSSA Family WhatsApp Group: ${AAYSSA_FAMILY_WHATSAPP_URL}`,
          "",
          "Swamiye Saranam Ayyappa,",
          "Atlanta Ayyappa Seva Sangam"
        ].join("\n"),
        html: `
          <div style="font-family:Arial,sans-serif;color:#2c211a;line-height:1.6;max-width:620px;margin:auto">
            <h2 style="color:#8a3f12">Welcome to the AAYSSA Family</h2>
            <p>Swamiye Saranam Ayyappa, ${escapeEmailHtml(fullName)}.</p>
            <p>Thank you for registering with Atlanta Ayyappa Seva Sangam. Your AAYSSA membership registration has been received.</p>
            <p><a href="${AAYSSA_FAMILY_WHATSAPP_URL}" style="display:inline-block;padding:11px 18px;background:#26783c;color:#fff;text-decoration:none;border-radius:7px;font-weight:bold">Join the AAYSSA Family WhatsApp Group</a></p>
            <p>Swamiye Saranam Ayyappa,<br>Atlanta Ayyappa Seva Sangam</p>
          </div>
        `
      })
    }
  );

  if (!response.ok) {
    console.error(
      "Resend membership confirmation failed:",
      response.status,
      await response.text()
    );
    throw new Error(
      "Unable to send membership confirmation email."
    );
  }
}

function escapeEmailHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function createRegistrationVolunteerRows({
  familyRow,
  legacyVolunteerInterest,
  legacyAreasOfInterest,
  primaryVolunteer,
  spouseVolunteer,
  additionalVolunteers
}) {
  const familyRowId =
    familyRow.id;

  const primaryName =
    getPrimaryName(familyRow);

  const spouseName =
    getSpouseName(familyRow);

  const legacyInterestedMembers =
    normalizeArray(legacyVolunteerInterest);

  const legacyAreas =
    normalizeArray(legacyAreasOfInterest);

  const primary =
    normalizeVolunteerRequest(
      primaryVolunteer,
      {
        interested:
          legacyInterestedMembers.includes("Primary Member") ||
          legacyAreas.length > 0,
        areas:
          legacyAreas
      }
    );

  await createVolunteerRow(
    buildVolunteerPayload({
      familyRowId,
      name: primaryName,
      memberType: "primary",
      interested:
        primary.interested,
      areas:
        primary.areas,
      active: true
    })
  );

  if (spouseName) {
    const spouse =
      normalizeVolunteerRequest(
        spouseVolunteer,
        {
          interested:
            legacyInterestedMembers.includes("Spouse"),
          areas:
            legacyInterestedMembers.includes("Spouse")
              ? legacyAreas
              : []
        }
      );

    await createVolunteerRow(
      buildVolunteerPayload({
        familyRowId,
        name: spouseName,
        memberType: "spouse",
        interested:
          spouse.interested,
        areas:
          spouse.areas,
        active: true
      })
    );
  }

  const additional =
    Array.isArray(additionalVolunteers)
      ? additionalVolunteers
      : [];

  for (const volunteer of additional) {
    const normalized =
      normalizeVolunteerRequest(volunteer);

    if (!normalized.name) {
      continue;
    }

    await createVolunteerRow(
      buildVolunteerPayload({
        familyRowId,
        name:
          normalized.name,
        memberType:
          "additional",
        relationship:
          normalized.relationship,
        interested:
          normalized.interested,
        areas:
          normalized.areas,
        active:
          true
      })
    );
  }
}

function normalizeVolunteerRequest(
  volunteer,
  fallback = {}
) {
  const source =
    volunteer && typeof volunteer === "object"
      ? volunteer
      : {};

  const areas =
    Array.isArray(source.areas)
      ? source.areas
      : Array.isArray(source.areasOfInterest)
        ? source.areasOfInterest
        : fallback.areas || [];

  return {
    name:
      String(source.name || "")
        .trim(),
    relationship:
      String(source.relationship || "")
        .trim(),
    interested:
      source.interested === undefined
        ? Boolean(fallback.interested)
        : Boolean(source.interested),
    areas:
      normalizeArray(areas)
  };
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value
      .map(item =>
        String(item || "").trim()
      )
      .filter(Boolean);
  }

  if (value) {
    return [
      String(value).trim()
    ].filter(Boolean);
  }

  return [];
}
