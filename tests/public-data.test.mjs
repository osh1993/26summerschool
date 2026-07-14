import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validatePublicSnapshot } from "../scripts/validate-public-data.mjs";

const samplePath = new URL("../docs/data/sample.json", import.meta.url);

test("합성 공개 스냅샷이 계약을 통과한다", { skip: !fs.existsSync(samplePath) }, () => {
  const snapshot = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  const result = validatePublicSnapshot(snapshot);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("전화번호와 금지 필드를 차단한다", () => {
  const snapshot = baseSnapshot();
  snapshot.groups.push({
    group_id: "G01",
    display_name: "1조",
    members: [{ public_id: "P-TEST", public_name: "참가자 01", phone: "010-1234-5678" }]
  });
  const result = validatePublicSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /PUBLIC_FIELD_NOT_ALLOWED|PUBLIC_FIELD_LEAK/);
});

test("운전자 포함 차량 정원 초과를 차단한다", () => {
  const snapshot = baseSnapshot();
  snapshot.vehicles.push({ vehicle_id: "V01", label: "차량 A", capacity: 2 });
  snapshot.trips.push({
    trip_id: "T01", date: "2026-07-23", time: "13:00", direction: "IN",
    origin: "광주 집결지", destination: "수련회장", meeting_point: "광주 집결지",
    status: "confirmed", vehicle_id: "V01", capacity: 2, passenger_count: 2,
    remaining_seats: 0, updated_at: "2026-07-14T12:00:00+09:00",
    passengers: [
      { public_id: "P-A", public_name: "참가자 A", boarding_status: "confirmed" },
      { public_id: "P-B", public_name: "참가자 B", boarding_status: "confirmed" }
    ]
  });
  const result = validatePublicSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /PUBLIC_REMAINING_SEATS_INVALID/);
});

test("필수 validation과 알 수 없는 최상위 필드를 차단한다", () => {
  const missingValidation = baseSnapshot();
  delete missingValidation.validation;
  assert.match(validatePublicSnapshot(missingValidation).errors.join("\n"), /PUBLIC_REQUIRED_FIELD_MISSING/);

  const unknownField = baseSnapshot();
  unknownField.internal_revision = "secret";
  assert.match(validatePublicSnapshot(unknownField).errors.join("\n"), /PUBLIC_FIELD_NOT_ALLOWED/);
});

test("중복 ID와 존재하지 않는 차량 참조를 차단한다", () => {
  const snapshot = baseSnapshot();
  snapshot.vehicles = [
    { vehicle_id: "V01", label: "차량 A", capacity: 4 },
    { vehicle_id: "V01", label: "차량 B", capacity: 4 }
  ];
  snapshot.trips = [{
    trip_id: "T01", date: "2026-07-23", time: "13:00", direction: "IN",
    origin: "광주 집결지", destination: "수련회장", meeting_point: "광주 집결지",
    status: "confirmed", vehicle_id: "V99", capacity: 4, passenger_count: 0,
    remaining_seats: 3, passengers: [], updated_at: "2026-07-14T12:00:00+09:00"
  }];
  const errors = validatePublicSnapshot(snapshot).errors.join("\n");
  assert.match(errors, /PUBLIC_DUPLICATE_ID/);
  assert.match(errors, /PUBLIC_REFERENCE_BROKEN/);
});

function baseSnapshot() {
  return {
    schema_version: "public-snapshot/v1",
    event: { event_id: "test", name: "테스트", starts_on: "2026-07-23", ends_on: "2026-07-25", timezone: "Asia/Seoul" },
    generated_at: "2026-07-14T12:00:00+09:00",
    updated_at: "2026-07-14T12:00:00+09:00",
    publish_id: "PUB-TEST",
    notices: [], groups: [], vehicles: [], trips: [], unassigned_summary: [],
    validation: { status: "ok", blocking_error_count: 0, warning_count: 0, warnings: [] }
  };
}
