import "dotenv/config";
import cors from "cors";
import express from "express";
import { lookupVehicle, VehicleLookupError } from "./vehicle-service.js";

const app = express();
const port = Number(process.env.PORT || 4000);

app.use(cors());
app.use(express.json());

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    mode: process.env.SCRAPER_MODE || "govuk"
  });
});

app.post("/vehicle", async (request, response) => {
  const registrationNumber = normalizeRegistrationNumber(
    request.body?.registrationNumber
  );

  if (!registrationNumber) {
    response.status(400).json({
      error: "registrationNumber is required"
    });
    return;
  }

  try {
    const result = await lookupVehicle(registrationNumber);
    response.json(result);
  } catch (error) {
    const status =
      error instanceof VehicleLookupError && typeof error.status === "number"
        ? error.status
        : 502;

    response.status(status).json({
      error: getErrorMessage(error)
    });
  }
});

app.use((_request, response) => {
  response.status(404).json({
    error: "Not found"
  });
});

app.listen(port, () => {
  console.log(`MyCar backend listening on http://localhost:${port}`);
});

function normalizeRegistrationNumber(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, "").toUpperCase();
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected backend error";
}
