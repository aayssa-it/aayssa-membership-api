import {
  cleanString,
  fetchFamilyVolunteerRows,
  findMemberByEmail,
  getAuthenticatedMember,
  getSpouseEmail,
  getSpouseEmailFieldKey,
  mapVolunteerRow,
  updateVolunteerRow,
  updateMemberRow
} from "./_lib/aayssa.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
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

    const profile =
      normalizeProfile(req.body?.profile || {});

    if (
      !profile.firstName ||
      !profile.lastName
    ) {
      return res.status(400).json({
        success: false,
        message:
          "First name and last name are required."
      });
    }

    if (
      profile.mobileNumber &&
      profile.normalizedPhone.length !== 10
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please enter a valid 10-digit U.S. mobile number."
      });
    }

    if (
      profile.spouseEmail &&
      !isValidEmail(profile.spouseEmail)
    ) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid spouse email address."
      });
    }

    if (
      profile.spouseEmail &&
      profile.spouseEmail ===
        cleanString(auth.memberRow.field_10464593).toLowerCase()
    ) {
      return res.status(400).json({
        success: false,
        message:
          "The spouse email must be different from the primary email."
      });
    }

    const existingEmailMember =
      profile.spouseEmail
        ? await findMemberByEmail(profile.spouseEmail)
        : null;

    if (
      existingEmailMember &&
      existingEmailMember.id !== auth.memberRow.id
    ) {
      return res.status(409).json({
        success: false,
        message:
          "This spouse email is already linked to another membership."
      });
    }

    const spouseEmailFieldKey =
      await getSpouseEmailFieldKey();

    if (
      profile.spouseEmail &&
      !spouseEmailFieldKey
    ) {
      return res.status(500).json({
        success: false,
        message:
          "The Spouse Email Address field is missing from the member table."
      });
    }

    const memberUpdates = {
      field_10227506: profile.firstName,
      field_10473214: profile.lastName,
      field_10227562: profile.spouseFirstName,
      field_10473216: profile.spouseLastName,
      field_10281595: profile.normalizedPhone,
      field_10281618: profile.address,
      field_10281686: profile.noOfAdults,
      field_10281655: profile.noOfKids,
      field_10281810: profile.emailOptIn,
      field_10281812: profile.textOptIn
    };

    if (spouseEmailFieldKey) {
      memberUpdates[spouseEmailFieldKey] =
        profile.spouseEmail;
    }

    const updatedRow =
      await updateMemberRow(
        auth.memberRow.id,
        memberUpdates
      );

    await syncVolunteerNames(
      auth.memberRow.id,
      updatedRow
    );

    return res.status(200).json({
      success: true,
      member:
        await mapUpdatedMember(updatedRow)
    });

  } catch (error) {
    console.error(
      "Update profile API error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to update member profile."
    });
  }
}

async function syncVolunteerNames(
  memberRowId,
  memberRow
) {
  const volunteerRows =
    await fetchFamilyVolunteerRows(memberRowId);

  const primaryName =
    `${memberRow.field_10227506 || ""} ${memberRow.field_10473214 || ""}`
      .trim();

  const spouseName =
    `${memberRow.field_10227562 || ""} ${memberRow.field_10473216 || ""}`
      .trim();

  for (const row of volunteerRows) {
    const volunteer =
      mapVolunteerRow(row);

    if (volunteer.memberType === "primary") {
      await updateVolunteerRow(
        row.id,
        {
          field_10642219:
            primaryName
        }
      );
    }

    if (
      volunteer.memberType === "spouse" &&
      spouseName
    ) {
      await updateVolunteerRow(
        row.id,
        {
          field_10642219:
            spouseName
        }
      );
    }
  }
}

function normalizeProfile(profile) {
  const mobileNumber =
    cleanString(profile.mobileNumber);

  return {
    firstName:
      cleanString(profile.firstName),
    lastName:
      cleanString(profile.lastName),
    spouseFirstName:
      cleanString(profile.spouseFirstName),
    spouseLastName:
      cleanString(profile.spouseLastName),
    spouseEmail:
      cleanString(profile.spouseEmail).toLowerCase(),
    mobileNumber,
    normalizedPhone:
      mobileNumber
        .replace(/\D/g, "")
        .slice(-10),
    address:
      cleanString(profile.address),
    noOfAdults:
      normalizeOptionalNumber(profile.noOfAdults),
    noOfKids:
      normalizeOptionalNumber(profile.noOfKids),
    emailOptIn:
      Boolean(profile.emailOptIn),
    textOptIn:
      Boolean(profile.textOptIn)
  };
}

function normalizeOptionalNumber(value) {
  if (
    value === "" ||
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const number =
    Number(value);

  if (
    !Number.isFinite(number) ||
    number < 0
  ) {
    return null;
  }

  return Math.floor(number);
}

async function mapUpdatedMember(row) {
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

  return {
    firstName:
      row.field_10227506 || "",
    lastName:
      row.field_10473214 || "",
    membershipId:
      row.field_10361167 || "",
    status:
      row.field_10227507?.value ||
      row.field_10227507 ||
      "",
    role,
    email:
      row.field_10281594 || "",
    spouseEmail:
      await getSpouseEmail(row),
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
  };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
