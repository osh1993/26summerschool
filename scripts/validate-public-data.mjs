import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const CampCore = require("../apps-script/Core.js");

/**
 * Apps Script 게시 게이트와 CI가 같은 순수 검증기를 사용한다.
 * 한쪽만 통과하는 공개 JSON이 생기지 않게 하는 것이 목적이다.
 */
export function validatePublicSnapshot(snapshot, sensitiveValues = []) {
  const issues = CampCore.validatePublicSnapshot(snapshot, sensitiveValues);
  const blocking = CampCore.blockingIssues(issues);
  return {
    ok: blocking.length === 0,
    issues,
    errors: blocking.map(formatIssue),
    warnings: issues.filter((row) => row.blocking === false).map(formatIssue)
  };
}

function formatIssue(row) {
  const entity = [row.entity_type, row.entity_id].filter(Boolean).join(":");
  return `${row.rule_code}${entity ? ` (${entity})` : ""}: ${row.message_private || row.rule_code}`;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("사용법: node scripts/validate-public-data.mjs <snapshot.json>");
  const snapshot = JSON.parse(await fs.readFile(file, "utf8"));
  const result = validatePublicSnapshot(snapshot);
  for (const warning of result.warnings) console.warn(`WARN ${warning}`);
  for (const error of result.errors) console.error(`ERROR ${error}`);
  if (!result.ok) process.exitCode = 1;
  else console.log(`OK ${file}: 공개 데이터 검증 통과`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
