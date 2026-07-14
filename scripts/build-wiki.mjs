import fs from "node:fs/promises";
import { validatePublicSnapshot } from "./validate-public-data.mjs";

const [source = "docs/data/sample.json", output = "wiki/Current-Status.md"] = process.argv.slice(2);

const snapshot = source.startsWith("http://") || source.startsWith("https://")
  ? await fetch(source).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${source}`);
      return response.json();
    })
  : JSON.parse(await fs.readFile(source, "utf8"));

const result = validatePublicSnapshot(snapshot);
if (!result.ok) throw new Error(`공개 데이터 검증 실패:\n${result.errors.join("\n")}`);

const lines = [
  `# 현재 공시 요약`,
  "",
  `> 상세하고 최신인 정보는 [수련회 운영 대시보드](https://osh1993.github.io/26summerschool/)에서 확인하세요.`,
  "",
  `- 행사: **${escapeMarkdown(snapshot.event.name)}**`,
  `- 기간: ${snapshot.event.starts_on} ~ ${snapshot.event.ends_on}`,
  `- 공시 번호: \`${snapshot.publish_id}\``,
  `- 업데이트: ${snapshot.updated_at}`,
  "",
  "## 조별 인원",
  "",
  "| 조 | 인원 |",
  "|---|---:|",
  ...(snapshot.groups ?? []).map((group) => `| ${escapeMarkdown(group.display_name)} | ${group.members.length}명 |`),
  "",
  "## 다음 운행",
  "",
  "| 일자·시각 | 방향 | 차량 | 출발 → 도착 | 상태 |",
  "|---|---|---|---|---|",
  ...(snapshot.trips ?? []).slice(0, 8).map((trip) =>
    `| ${trip.date} ${trip.time} | ${trip.direction} | ${escapeMarkdown(vehicleLabel(snapshot, trip.vehicle_id))} | ${escapeMarkdown(trip.origin)} → ${escapeMarkdown(trip.destination)} | ${trip.status} |`
  ),
  "",
  snapshot.unassigned_summary?.length
    ? `> ⚠️ 현재 미배정 이동 수요 ${snapshot.unassigned_summary.reduce((sum, item) => sum + Number(item.count || 0), 0)}건이 있습니다. 운영자가 확인 중입니다.`
    : "> ✅ 공개된 이동 수요는 모두 배정되었습니다.",
  "",
  "개인정보 보호를 위해 이 Wiki에는 상세 탑승 명단을 복제하지 않습니다.",
  ""
];

await fs.mkdir(new URL(".", new URL(`file:///${output.replaceAll("\\", "/")}`)), { recursive: true }).catch(() => {});
await fs.writeFile(output, lines.join("\n"), "utf8");
console.log(`Wrote ${output}`);

function vehicleLabel(data, id) {
  return data.vehicles.find((vehicle) => vehicle.vehicle_id === id)?.label ?? id;
}

function escapeMarkdown(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}
