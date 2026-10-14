import {
  cleanString,
  getBaserowBaseUrl,
  getBaserowHeaders
} from "./aayssa.js";

const TABLE_ID =
  process.env.BASEROW_FEEDBACK_TABLE_ID || "1262224";

const DIGEST_TO =
  "aayssa.official@gmail.com";

const CATEGORIES = [
  "Pooja",
  "Annadhanam",
  "Bhajan",
  "Media",
  "Events and Programs",
  "Volunteering and Seva",
  "Membership and Member Portal",
  "Facilities and Logistics",
  "Finance and Donations",
  "General Suggestion",
  "Other"
];

let fieldConfigurationPromise;

export async function handlePublicFeedback(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    if (cleanString(req.body?.website)) {
      return res.status(201).json({
        success: true,
        message: "Thank you for sharing your feedback."
      });
    }

    const feedback = cleanString(req.body?.feedback)
      .slice(0, 5000);
    const category = cleanString(req.body?.category);
    const anonymous = req.body?.anonymous !== false;

    if (!feedback) {
      return badRequest(res, "Feedback is required.");
    }

    if (!CATEGORIES.includes(category)) {
      return badRequest(res, "Select a valid feedback category.");
    }

    const name = anonymous
      ? ""
      : cleanString(req.body?.name).slice(0, 150);
    const email = anonymous
      ? ""
      : cleanString(req.body?.email).toLowerCase().slice(0, 254);
    const phone = anonymous
      ? ""
      : cleanString(req.body?.phoneNumber).slice(0, 50);
    const mayContact = anonymous
      ? false
      : Boolean(req.body?.mayContact) && Boolean(email || phone);

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return badRequest(res, "Enter a valid email address.");
    }

    const fields = await getFieldConfiguration();
    const payload = {
      [fields.feedback.name]: feedback,
      [fields.category.name]: selectOptionId(fields.category, category),
      [fields.anonymous.name]: anonymous,
      [fields.name.name]: name,
      [fields.email.name]: email,
      [fields.phoneNumber.name]: phone,
      [fields.mayContact.name]: mayContact,
      [fields.status.name]: selectOptionId(fields.status, "New"),
      [fields.includedInDigest.name]: false
    };

    const response = await fetch(
      `${getBaserowBaseUrl()}/api/database/rows/table/${TABLE_ID}/?user_field_names=true`,
      {
        method: "POST",
        headers: getBaserowHeaders(),
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      console.error(
        "Feedback row creation failed:",
        response.status,
        await response.text()
      );
      throw new Error("Unable to save feedback.");
    }

    return res.status(201).json({
      success: true,
      message: "Thank you. Your feedback has been submitted to AAYSSA."
    });
  } catch (error) {
    console.error("Public feedback error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to submit feedback right now. Please try again."
    });
  }
}

export async function handleFeedbackDigest(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false });
  }

  const secret = process.env.CRON_SECRET;
  const authorization = cleanString(req.headers.authorization);

  if (!secret || authorization !== `Bearer ${secret}`) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized."
    });
  }

  try {
    const feedbackRows = (await fetchAllFeedbackRows())
      .filter(row => !Boolean(row["Included in Digest"]));

    if (feedbackRows.length === 0) {
      return res.status(200).json({
        success: true,
        sent: false,
        count: 0,
        message: "No new feedback for this digest."
      });
    }

    await sendFeedbackDigest(feedbackRows);

    const sentOn = new Date().toISOString();
    await Promise.all(
      feedbackRows.map(row => markDigestSent(row.id, sentOn))
    );

    return res.status(200).json({
      success: true,
      sent: true,
      count: feedbackRows.length
    });
  } catch (error) {
    console.error("Feedback digest error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to send the feedback digest."
    });
  }
}

async function getFieldConfiguration() {
  if (!fieldConfigurationPromise) {
    fieldConfigurationPromise = loadFieldConfiguration();
  }
  return fieldConfigurationPromise;
}

async function loadFieldConfiguration() {
  const response = await fetch(
    `${getBaserowBaseUrl()}/api/database/fields/table/${TABLE_ID}/`,
    { headers: getBaserowHeaders() }
  );

  if (!response.ok) {
    throw new Error("Unable to load feedback table fields.");
  }

  const fields = await response.json();
  const byName = new Map(
    fields.map(field => [cleanString(field.name).toLowerCase(), field])
  );
  const required = {
    feedback: "Feedback",
    category: "Category",
    anonymous: "Anonymous",
    name: "Name",
    email: "Email",
    phoneNumber: "Phone Number",
    mayContact: "May Contact",
    status: "Status",
    includedInDigest: "Included in Digest",
    digestSentOn: "Digest Sent On"
  };
  const configuration = {};

  for (const [key, name] of Object.entries(required)) {
    const field = byName.get(name.toLowerCase());
    if (!field) {
      throw new Error(`Feedback table is missing field: ${name}`);
    }
    configuration[key] = field;
  }

  return configuration;
}

function selectOptionId(field, value) {
  const option = Array.isArray(field.select_options)
    ? field.select_options.find(item =>
        cleanString(item.value).toLowerCase() === value.toLowerCase()
      )
    : null;

  if (!option) {
    throw new Error(
      `Feedback table field ${field.name} is missing option: ${value}`
    );
  }

  return option.id;
}

async function fetchAllFeedbackRows() {
  const rows = [];
  let page = 1;

  while (true) {
    const response = await fetch(
      `${getBaserowBaseUrl()}/api/database/rows/table/${TABLE_ID}/?user_field_names=true&size=200&page=${page}`,
      { headers: getBaserowHeaders() }
    );

    if (!response.ok) {
      throw new Error("Unable to load feedback submissions.");
    }

    const data = await response.json();
    rows.push(...(Array.isArray(data.results) ? data.results : []));

    if (!data.next) {
      break;
    }
    page += 1;
  }

  return rows;
}

async function sendFeedbackDigest(rows) {
  const apiKey = process.env.RESEND_API_KEY;
  const from =
    process.env.RESEND_FROM_EMAIL ||
    process.env.RESEND_FROM ||
    process.env.EMAIL_FROM ||
    process.env.FROM_EMAIL;

  if (!apiKey || !from) {
    throw new Error("Resend feedback digest is not configured.");
  }

  const sections = rows.map((row, index) => {
    const category = selectValue(row.Category) || "Other";
    const anonymous = Boolean(row.Anonymous);
    const contact = anonymous
      ? "Anonymous"
      : [row.Name, row.Email, row["Phone Number"]]
          .map(cleanString)
          .filter(Boolean)
          .join(" · ") || "Contact not provided";
    const mayContact = !anonymous && Boolean(row["May Contact"])
      ? "Yes"
      : "No";

    return {
      text: [
        `${index + 1}. ${category}`,
        cleanString(row.Feedback),
        `Submitted by: ${contact}`,
        `May contact: ${mayContact}`
      ].join("\n"),
      html: `
        <div style="padding:16px 0;border-bottom:1px solid #ead8c5">
          <h3 style="margin:0 0 8px;color:#8a3f12">${index + 1}. ${escapeHtml(category)}</h3>
          <p style="white-space:pre-wrap">${escapeHtml(cleanString(row.Feedback))}</p>
          <p style="color:#666"><strong>Submitted by:</strong> ${escapeHtml(contact)}<br><strong>May contact:</strong> ${mayContact}</p>
        </div>
      `
    };
  });

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [DIGEST_TO],
      subject: `AAYSSA Weekly Feedback Digest — ${rows.length} submission${rows.length === 1 ? "" : "s"}`,
      text: [
        `AAYSSA Weekly Feedback Digest (${rows.length})`,
        "",
        ...sections.flatMap(section => [section.text, ""])
      ].join("\n"),
      html: `
        <div style="font-family:Arial,sans-serif;color:#2c211a;line-height:1.55;max-width:720px;margin:auto">
          <h2 style="color:#8a3f12">AAYSSA Weekly Feedback Digest</h2>
          <p>${rows.length} new submission${rows.length === 1 ? "" : "s"} received.</p>
          ${sections.map(section => section.html).join("")}
        </div>
      `
    })
  });

  if (!response.ok) {
    console.error(
      "Resend feedback digest failed:",
      response.status,
      await response.text()
    );
    throw new Error("Unable to send feedback digest email.");
  }
}

async function markDigestSent(id, sentOn) {
  const fields = await getFieldConfiguration();
  const response = await fetch(
    `${getBaserowBaseUrl()}/api/database/rows/table/${TABLE_ID}/${id}/?user_field_names=true`,
    {
      method: "PATCH",
      headers: getBaserowHeaders(),
      body: JSON.stringify({
        [fields.includedInDigest.name]: true,
        [fields.digestSentOn.name]: sentOn
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Unable to mark feedback ${id} as included.`);
  }
}

function selectValue(value) {
  return value && typeof value === "object"
    ? value.value || value.name || ""
    : cleanString(value);
}

function escapeHtml(value) {
  return cleanString(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function badRequest(res, message) {
  return res.status(400).json({ success: false, message });
}
