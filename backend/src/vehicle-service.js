import { load } from "cheerio";

const GOVUK_BASE_URL = "https://vehicleenquiry.service.gov.uk";

export class VehicleLookupError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "VehicleLookupError";
    this.status = status;
  }
}

export async function lookupVehicle(registrationNumber) {
  const mode = process.env.SCRAPER_MODE || "govuk";

  if (mode === "demo") {
    return buildDemoVehicle(registrationNumber);
  }

  if (mode === "govuk") {
    return scrapeVehicleFromGovUk(registrationNumber);
  }

  if (mode === "html") {
    return scrapeVehicleFromHtml(registrationNumber);
  }

  throw new Error(`Unsupported SCRAPER_MODE "${mode}"`);
}

function buildDemoVehicle(registrationNumber) {
  return {
    source: "demo",
    registrationNumber,
    vehicle: {
      registrationNumber,
      make: "DEMO",
      colour: "BLUE",
      fuelType: "PETROL",
      yearOfManufacture: 2019,
      taxStatus: "Taxed",
      taxDueDate: "2027-03-01",
      motStatus: "Valid",
      motExpiryDate: "2027-01-15"
    }
  };
}

async function scrapeVehicleFromGovUk(registrationNumber) {
  const cookies = new Map();

  const startPage = await fetchWithCookies(`${GOVUK_BASE_URL}/`, {
    cookies
  });
  const startHtml = await startPage.text();
  const startToken = extractFormToken(startHtml);

  const confirmPage = await submitGovUkForm({
    cookies,
    body: {
      authenticity_token: startToken,
      "wizard_vehicle_enquiry_capture_vrn[vrn]": registrationNumber
    }
  });
  const confirmHtml = await confirmPage.text();
  classifyGovUkPage(confirmHtml, registrationNumber, "confirm");
  const confirmToken = extractFormToken(confirmHtml);

  const resultPage = await submitGovUkForm({
    cookies,
    body: {
      authenticity_token: confirmToken,
      "wizard_vehicle_enquiry_capture_confirm_vehicle[confirmed]": "Yes"
    }
  });
  const resultHtml = await resultPage.text();
  classifyGovUkPage(resultHtml, registrationNumber, "result");

  return {
    source: "govuk-vehicle-enquiry",
    registrationNumber,
    vehicle: parseGovUkResult(resultHtml, registrationNumber)
  };
}

async function scrapeVehicleFromHtml(registrationNumber) {
  const targetUrlTemplate = process.env.SCRAPER_TARGET_URL;
  if (!targetUrlTemplate) {
    throw new Error("SCRAPER_TARGET_URL is required for html mode");
  }

  const requestUrl = targetUrlTemplate.replace(
    "{registrationNumber}",
    encodeURIComponent(registrationNumber)
  );

  const response = await fetch(requestUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    }
  });

  if (!response.ok) {
    throw new Error(`Scraper target failed with ${response.status}`);
  }

  const html = await response.text();
  const $ = load(html);

  return {
    source: requestUrl,
    registrationNumber,
    vehicle: {
      registrationNumber,
      make: readValue($, [
        '[data-field="make"]',
        "#make",
        ".vehicle-make"
      ]),
      colour: readValue($, [
        '[data-field="colour"]',
        "#colour",
        ".vehicle-colour"
      ]),
      fuelType: readValue($, [
        '[data-field="fuelType"]',
        "#fuelType",
        ".vehicle-fuel"
      ]),
      yearOfManufacture: toNumber(
        readValue($, [
          '[data-field="yearOfManufacture"]',
          "#yearOfManufacture",
          ".vehicle-year"
        ])
      ),
      taxStatus: readValue($, [
        '[data-field="taxStatus"]',
        "#taxStatus",
        ".vehicle-tax-status"
      ]),
      taxDueDate: readValue($, [
        '[data-field="taxDueDate"]',
        "#taxDueDate",
        ".vehicle-tax-due-date"
      ]),
      motStatus: readValue($, [
        '[data-field="motStatus"]',
        "#motStatus",
        ".vehicle-mot-status"
      ]),
      motExpiryDate: readValue($, [
        '[data-field="motExpiryDate"]',
        "#motExpiryDate",
        ".vehicle-mot-expiry-date"
      ])
    },
    rawHtmlSample: html.slice(0, 500)
  };
}

async function submitGovUkForm({ cookies, body }) {
  const response = await fetchWithCookies(
    `${GOVUK_BASE_URL}/vehicle-enquiry/save?locale=en`,
    {
      method: "POST",
      cookies,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(body).toString()
    }
  );

  return followRedirects(response, cookies);
}

async function followRedirects(response, cookies) {
  let currentResponse = response;

  while (isRedirectStatus(currentResponse.status)) {
    const location = currentResponse.headers.get("location");
    if (!location) {
      throw new Error(`Redirect ${currentResponse.status} missing location header`);
    }

    currentResponse = await fetchWithCookies(
      new URL(location, GOVUK_BASE_URL).toString(),
      {
        cookies
      }
    );
  }

  if (!currentResponse.ok) {
    throw new Error(`GOV.UK flow failed with ${currentResponse.status}`);
  }

  return currentResponse;
}

function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

async function fetchWithCookies(url, options) {
  const { cookies, headers, ...rest } = options;

  let response;

  try {
    response = await fetch(url, {
      ...rest,
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        ...(cookies && cookies.size > 0
          ? {
              Cookie: Array.from(cookies.entries())
                .map(([name, value]) => `${name}=${value}`)
                .join("; ")
            }
          : {}),
        ...headers
      }
    });
  } catch (error) {
    throw new VehicleLookupError(
      `Network error while contacting GOV.UK: ${getMessage(error)}`,
      502
    );
  }

  if (cookies) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, value] = pair.split("=");
      if (name && value) {
        cookies.set(name.trim(), value.trim());
      }
    }
  }

  return response;
}

function getMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected network error";
}

function extractFormToken(html) {
  const match = html.match(
    /<form action="\/vehicle-enquiry\/save\?locale=en"[\s\S]*?name="authenticity_token" value="([^"]+)"/
  );

  if (!match?.[1]) {
    throw new VehicleLookupError("Could not extract GOV.UK form token", 502);
  }

  return match[1];
}

function classifyGovUkPage(html, registrationNumber, stage) {
  const $ = load(html);
  const title = $("title").text().replace(/\s+/g, " ").trim();
  const pageText = $("main").text().replace(/\s+/g, " ").trim();

  if (title.includes("Vehicle Tax and MOT status results")) {
    return "result";
  }

  if (title.includes("Is this the vehicle you are looking for?")) {
    return "confirm";
  }

  if (pageText.includes("You must enter a registration number")) {
    throw new VehicleLookupError("Enter a registration number", 400);
  }

  if (
    pageText.includes("Enter a valid registration number") ||
    pageText.includes("You must enter a valid registration number")
  ) {
    throw new VehicleLookupError("Enter a valid registration number", 400);
  }

  if (pageText.toLowerCase().includes("vehicle details could not be found")) {
    throw new VehicleLookupError(
      `No vehicle details found for ${registrationNumber}`,
      404
    );
  }

  if (title.includes("Enter the registration number of the vehicle")) {
    throw new VehicleLookupError(
      stage === "confirm"
        ? `Registration ${registrationNumber} was not accepted by GOV.UK`
        : `Vehicle details could not be loaded for ${registrationNumber}`,
      400
    );
  }

  throw new VehicleLookupError("Unexpected GOV.UK result page", 502);
}

function parseGovUkResult(html, registrationNumber) {
  const $ = load(html);
  const title = $("title").text().trim();

  if (!title.includes("Vehicle Tax and MOT status results")) {
    classifyGovUkPage(html, registrationNumber, "result");
  }

  return {
    registrationNumber,
    make: readDetailById($, "make"),
    colour: readDetailById($, "colour"),
    fuelType: readDetailById($, "fuel_type"),
    yearOfManufacture: toNumber(readDetailById($, "year_of_manufacture")),
    engineCapacity: toNumber(readDetailById($, "engine_capacity")),
    taxStatus: normalizeGovUkTaxStatus($("#tax-status-panel .govuk-panel__title").text()),
    taxDueDate: parseGovUkLongDate($("#tax-status-panel .govuk-panel__body").text()),
    motStatus: normalizeGovUkMotStatus($("#mot_hidden_details").text()),
    motExpiryDate: parseGovUkLongDate($("#mot-status-panel .govuk-panel__body").text())
  };
}

function readDetailById($, id) {
  return $(`#${id} dd`).first().text().trim();
}

function parseGovUkLongDate(value) {
  const cleaned = value.replace(/(Tax due:|Expires:)/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }

  const match = cleaned.match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/);
  if (!match) {
    return cleaned;
  }

  const [, dayText, monthText, yearText] = match;
  const monthIndex = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december"
  ].indexOf(monthText.toLowerCase());

  if (monthIndex === -1) {
    return cleaned;
  }

  return `${yearText}-${String(monthIndex + 1).padStart(2, "0")}-${String(
    Number(dayText)
  ).padStart(2, "0")}`;
}

function normalizeGovUkTaxStatus(value) {
  if (value.includes("Taxed")) {
    return "Taxed";
  }

  if (value.includes("Untaxed")) {
    return "Untaxed";
  }

  if (value.includes("SORN")) {
    return "SORN";
  }

  return value.replace(/\s+/g, " ").trim();
}

function normalizeGovUkMotStatus(value) {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }

  if (cleaned.toLowerCase().includes("valid mot")) {
    return "Valid";
  }

  if (cleaned.toLowerCase().includes("no mot")) {
    return "Not valid";
  }

  return cleaned;
}

function readValue($, selectors) {
  for (const selector of selectors) {
    const text = $(selector).first().text().trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function toNumber(value) {
  const parsed = Number(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}
