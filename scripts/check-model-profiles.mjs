import { readFileSync } from "node:fs";

const { reviewed_on: date } = JSON.parse(readFileSync(
  new URL("../src/bridge/model-profiles.json", import.meta.url),
  "utf8",
));
const reviewed = Date.parse(`${date}T00:00:00Z`);
const today = Date.parse(new Date().toISOString().slice(0, 10));
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(reviewed) ||
    new Date(reviewed).toISOString().slice(0, 10) !== date || reviewed > today) {
  console.error("Model profiles must specify a valid, non-future reviewed_on date.");
  process.exitCode = 1;
} else if ((today - reviewed) / 86400000 >= 30) {
  console.error(`Model profiles last reviewed on ${date}. Follow docs/model-profiles.md before updating reviewed_on.`);
  process.exitCode = 1;
} else {
  console.log(`Model profiles last reviewed on ${date}.`);
}
