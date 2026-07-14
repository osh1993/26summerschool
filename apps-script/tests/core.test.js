'use strict';
const assert = require('assert');
const Core = require('../Core.js');

function validSnapshot() {
  return {
    schema_version: 'public-snapshot/v1',
    event: { event_id: '2026-summer', name: '여름수련회', starts_on: '2026-07-23', ends_on: '2026-07-25', timezone: 'Asia/Seoul' },
    generated_at: '2026-07-14T10:00:00+09:00',
    updated_at: '2026-07-14T09:00:00+09:00',
    publish_id: 'pub-test-001',
    notices: [],
    groups: [{ group_id: 'G01', display_name: '1조', members: [{ public_id: 'P-ABC234', public_name: '참가자A', role: 'member' }] }],
    vehicles: [{ vehicle_id: 'V01', label: '교회 차량 1', capacity: 10, accessibility: false }],
    trips: [{
      trip_id: 'T01', date: '2026-07-23', time: '13:30', direction: 'IN', origin: '광주 집결지', destination: '수련회장', meeting_point: '광주 집결지',
      status: 'confirmed', vehicle_id: 'V01', driver_label: '교회 차량 1 담당', capacity: 10, passenger_count: 1, remaining_seats: 8,
      passengers: [{ public_id: 'P-ABC234', public_name: '참가자A', boarding_status: 'confirmed' }], updated_at: '2026-07-14T09:00:00+09:00'
    }],
    unassigned_summary: [],
    validation: { status: 'ok', blocking_error_count: 0, warning_count: 0, warnings: [] }
  };
}

function ruleCodes(issues) { return issues.map((row) => row.rule_code); }

assert.strictEqual(Core.intervalsOverlap('2026-07-23T10:00:00+09:00', '2026-07-23T11:00:00+09:00', '2026-07-23T11:00:00+09:00', '2026-07-23T12:00:00+09:00'), false);
assert.strictEqual(Core.intervalsOverlap('2026-07-23T10:00:00+09:00', '2026-07-23T11:01:00+09:00', '2026-07-23T11:00:00+09:00', '2026-07-23T12:00:00+09:00'), true);

const operations = {
  participants: [{ participant_id: 'pt_A', active: true }],
  groups: [{ group_id: 'G01', min_size: 0, max_size: 6, active: true }],
  groupAssignments: [{ assignment_id: 'A1', participant_id: 'pt_A', group_id: 'G01' }],
  relations: [], locations: [], travelDemands: [{ demand_id: 'D1', participant_id: 'pt_A', direction: 'IN', origin_location_id: 'L1', destination_location_id: 'L2', earliest_depart_at: '2026-07-23T10:00:00+09:00', latest_depart_at: '2026-07-23T11:00:00+09:00', demand_status: 'confirmed' }],
  vehicles: [{ vehicle_id: 'V01', capacity_total: 2, active: true }],
  trips: [{ trip_id: 'T01', vehicle_id: 'V01', driver_participant_id: 'pt_D', direction: 'IN', origin_location_id: 'L1', destination_location_id: 'L2', depart_at: '2026-07-23T10:30:00+09:00', arrival_estimate: '2026-07-23T11:30:00+09:00', trip_status: 'confirmed' }],
  tripPassengers: [{ trip_passenger_id: 'TP1', trip_id: 'T01', participant_id: 'pt_A', demand_id: 'D1', boarding_status: 'confirmed', seat_count: 1 }]
};
assert.ok(!ruleCodes(Core.validateInternalModel(operations)).includes('VEHICLE_OVER_CAPACITY'));
const belowMin = JSON.parse(JSON.stringify(operations));
belowMin.groups[0].min_size = 2;
const minIssue = Core.validateInternalModel(belowMin).find((row) => row.rule_code === 'GROUP_SIZE_BELOW_MIN');
assert.ok(minIssue && minIssue.blocking === true);
const overCapacity = JSON.parse(JSON.stringify(operations));
overCapacity.tripPassengers.push({ trip_passenger_id: 'TP2', trip_id: 'T01', participant_id: 'pt_B', demand_id: 'D2', boarding_status: 'confirmed', seat_count: 1 });
assert.ok(ruleCodes(Core.validateInternalModel(overCapacity)).includes('VEHICLE_OVER_CAPACITY'));
const duplicateGroup = JSON.parse(JSON.stringify(operations));
duplicateGroup.groupAssignments.push({ assignment_id: 'A2', participant_id: 'pt_A', group_id: 'G02' });
assert.ok(ruleCodes(Core.validateInternalModel(duplicateGroup)).includes('MULTIPLE_ACTIVE_GROUPS'));
const brokenReferences = JSON.parse(JSON.stringify(operations));
brokenReferences.groupAssignments.push({ assignment_id: 'A-missing', participant_id: 'pt_MISSING', group_id: 'G01' });
brokenReferences.tripPassengers.push({ trip_passenger_id: 'TP-missing', trip_id: 'T01', participant_id: 'pt_MISSING', demand_id: 'D-missing', boarding_status: 'confirmed', seat_count: 1 });
assert.strictEqual(Core.validateInternalModel(brokenReferences).filter((row) => row.rule_code === 'PARTICIPANT_REFERENCE_BROKEN').length, 2);

const relationConflicts = Core.findBundleRelationConflicts(
  [{ participant_id: 'pt_A' }, { participant_id: 'pt_B' }],
  [
    { relation_id: 'R1', participant_a_id: 'pt_A', participant_b_id: 'pt_B', relation_type: 'must_together', active: true },
    { relation_id: 'R2', participant_a_id: 'pt_A', participant_b_id: 'pt_B', relation_type: 'must_separate', active: true }
  ]
);
assert.deepStrictEqual(ruleCodes(relationConflicts), ['RELATION_CONFLICT']);

assert.deepStrictEqual(Core.validatePublicSnapshot(validSnapshot(), []), []);
const unknown = validSnapshot(); unknown.groups[0].members[0].legal_name = '민감한 실명';
assert.ok(ruleCodes(Core.validatePublicSnapshot(unknown, [])).includes('PUBLIC_FIELD_NOT_ALLOWED'));
const phone = validSnapshot(); phone.notices.push({ notice_id: 'N1', title: '연락', message: '010-1234-5678', severity: 'info' });
assert.ok(ruleCodes(Core.validatePublicSnapshot(phone, [])).includes('PUBLIC_FIELD_LEAK'));
const badSeats = validSnapshot(); badSeats.trips[0].remaining_seats = 7;
assert.ok(ruleCodes(Core.validatePublicSnapshot(badSeats, [])).includes('PUBLIC_REMAINING_SEATS_INVALID'));
const canary = validSnapshot(); canary.notices.push({ notice_id: 'N2', title: '안내', message: 'PRIVATE-CANARY', severity: 'info' });
assert.ok(ruleCodes(Core.validatePublicSnapshot(canary, ['PRIVATE-CANARY'])).includes('PUBLIC_FIELD_LEAK'));

const warningSnapshot = validSnapshot();
warningSnapshot.validation = { status: 'warning', blocking_error_count: 0, warning_count: 2, warnings: [{ rule_code: 'UNASSIGNED_DEMAND', message: '배정되지 않은 이동 수요가 있습니다.', count: 2 }] };
assert.deepStrictEqual(Core.validatePublicSnapshot(warningSnapshot, []), []);
const hiddenWarning = JSON.parse(JSON.stringify(warningSnapshot)); hiddenWarning.validation.status = 'ok';
assert.ok(ruleCodes(Core.validatePublicSnapshot(hiddenWarning, [])).includes('PUBLIC_VALIDATION_STATUS_INVALID'));
assert.deepStrictEqual(Core.aggregatePublicWarnings([
  Core.issue('UNASSIGNED_DEMAND', 'demand', 'D1', 'private detail', false, 'warning'),
  Core.issue('UNASSIGNED_DEMAND', 'demand', 'D2', 'different private detail', false, 'warning'),
  Core.issue('SOME_INTERNAL_WARNING', 'system', 'X', 'must not be public', false, 'warning')
]), [
  { rule_code: 'OPERATION_REVIEW_REQUIRED', message: '운영자 확인이 필요한 경고가 있습니다.', count: 1 },
  { rule_code: 'UNASSIGNED_DEMAND', message: '배정되지 않은 이동 수요가 있습니다.', count: 2 }
]);

function transactionResult(failPhase) {
  const state = { pointer: 'pub-old', staged: {} };
  const candidate = validSnapshot(); candidate.publish_id = 'pub-new';
  const adapter = {
    stage(value) {
      if (failPhase === 'stage') throw new Error('injected stage failure');
      state.staged[value.publish_id] = JSON.parse(JSON.stringify(value));
    },
    read(id) {
      if (failPhase === 'read') throw new Error('injected read failure');
      const value = state.staged[id];
      if (failPhase === 'corrupt') value.trips[0].remaining_seats = -1;
      return value;
    },
    switchPointer(id) {
      if (failPhase === 'switch') throw new Error('injected atomic switch failure');
      state.pointer = id;
    }
  };
  try { Core.runPublicationTransaction(candidate, adapter, []); } catch (error) { /* expected failure injection */ }
  return state.pointer;
}
['stage', 'read', 'corrupt', 'switch'].forEach((phase) => assert.strictEqual(transactionResult(phase), 'pub-old', phase + ' failure must preserve old pointer'));
assert.strictEqual(transactionResult('none'), 'pub-new');

console.log('Core tests passed');
