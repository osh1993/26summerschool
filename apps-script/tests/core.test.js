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

// ── 명단 가져오기(Roster Import) 순수 로직 테스트 ──────────────────────────
const rosterMap = [
  { normalized_field: 'legal_name', required: true },
  { normalized_field: 'person_type', required: false },
  { normalized_field: 'campus', required: true },
  { normalized_field: 'grade_band', required: false },
  { normalized_field: 'engagement_score', required: false },
  { normalized_field: 'phone', required: false }
];
function existingOne() {
  return [{ _row: 2, participant_id: 'pt_1', person_type: 'student', legal_name: '김하늘', campus: 'imd', grade_band: '', gender: '', engagement_score: 5, newcomer: '', leader_candidate: '', public_id: 'P-AAAA11', public_name: '', public_consent: false, active: true, source_response_id: 'Form_Raw_Students:2' }];
}

// 신규 insert: public_consent FALSE, public_name '', 앵커 source_response_id 확인
const rosterInsert = Core.planRosterUpsert([], [], [
  { index: 2, fields: { legal_name: '이바다', person_type: 'student', campus: 'suwan' } }
], rosterMap, { mode: 'commit', eventId: '2026-summer' });
assert.strictEqual(rosterInsert.summary.insert, 1);
assert.strictEqual(rosterInsert.inserts[0].participant.public_consent, false);
assert.strictEqual(rosterInsert.inserts[0].participant.public_name, '');
assert.strictEqual(rosterInsert.inserts[0].participant.active, true);
assert.strictEqual(rosterInsert.inserts[0].participant.source_response_id, 'roster_import:이바다|student|suwan');

// 재실행 idempotent: 앵커가 있으면 insert 0, 변경 없으면 update 0
const anchored = [{ _row: 2, participant_id: 'pt_9', person_type: 'student', legal_name: '이바다', campus: 'suwan', grade_band: '', gender: '', engagement_score: 3, public_id: 'P-Z', public_name: '', public_consent: false, active: true, source_response_id: 'roster_import:이바다|student|suwan' }];
const rosterIdem = Core.planRosterUpsert(anchored, [], [{ index: 2, fields: { legal_name: '이바다', person_type: 'student', campus: 'suwan' } }], rosterMap, { mode: 'commit', eventId: '2026-summer' });
assert.strictEqual(rosterIdem.summary.insert, 0);
assert.strictEqual(rosterIdem.summary.update, 0);

// 빈 칸 채움
const rosterFill = Core.planRosterUpsert(existingOne(), [], [{ index: 2, fields: { legal_name: '김하늘', person_type: 'student', campus: 'imd', grade_band: 'middle_2' } }], rosterMap, { mode: 'commit', eventId: 'e' });
assert.strictEqual(rosterFill.summary.update, 1);
assert.strictEqual(rosterFill.updates[0].setParticipant.grade_band, 'middle_2');

// 충돌 보존(commit) vs 덮어쓰기(commit-overwrite)
const conflictRows = [{ index: 2, fields: { legal_name: '김하늘', person_type: 'student', campus: 'imd', engagement_score: 3 } }];
const rosterConflict = Core.planRosterUpsert(existingOne(), [], conflictRows, rosterMap, { mode: 'commit', eventId: 'e' });
assert.ok(ruleCodes(rosterConflict.issues).includes('ROSTER_FIELD_CONFLICT'));
assert.strictEqual(rosterConflict.summary.update, 0);
const rosterOverwrite = Core.planRosterUpsert(existingOne(), [], conflictRows, rosterMap, { mode: 'commit-overwrite', eventId: 'e' });
assert.strictEqual(rosterOverwrite.updates[0].setParticipant.engagement_score, 3);

// 동명이인 병합 금지
const twins = [
  { _row: 2, participant_id: 'pt_a', person_type: 'student', legal_name: '박별', campus: 'imd', active: true, source_response_id: 'Form_Raw_Students:2' },
  { _row: 3, participant_id: 'pt_b', person_type: 'student', legal_name: '박별', campus: 'imd', active: true, source_response_id: 'Form_Raw_Students:3' }
];
const rosterAmbiguous = Core.planRosterUpsert(twins, [], [{ index: 2, fields: { legal_name: '박별', person_type: 'student', campus: 'imd' } }], rosterMap, { mode: 'commit', eventId: 'e' });
assert.ok(ruleCodes(rosterAmbiguous.issues).includes('ROSTER_AMBIGUOUS_MATCH'));
assert.strictEqual(rosterAmbiguous.summary.insert, 0);
assert.strictEqual(rosterAmbiguous.summary.update, 0);

// 민감정보 라우팅과 Change_Log REDACTED
const routed = Core.routePrivateFields({ legal_name: 'x', phone: '010-1234-5678', campus: 'imd', birth_date: '2010-01-01' });
assert.ok(routed.privateFields.phone && routed.privateFields.birth_date);
assert.strictEqual(routed.participantFields.phone, undefined);
const rosterPrivate = Core.planRosterUpsert(
  [{ _row: 2, participant_id: 'pt_1', person_type: 'student', legal_name: '김하늘', campus: 'imd', active: true, source_response_id: 'x' }],
  [{ _row: 2, participant_id: 'pt_1', phone: '', birth_date: '' }],
  [{ index: 2, fields: { legal_name: '김하늘', person_type: 'student', campus: 'imd', phone: '010-2222-3333' } }],
  rosterMap, { mode: 'commit', eventId: 'e' }
);
assert.strictEqual(rosterPrivate.updates[0].setPrivate.phone, '010-2222-3333');
const phoneChange = rosterPrivate.updates[0].changeLog.find((c) => c.field_name === 'phone');
assert.strictEqual(phoneChange.old_value, '[REDACTED]');
assert.strictEqual(phoneChange.new_value, '[REDACTED]');

// 민감 필드가 참가자 대상으로 전달되면 차단
assert.ok(ruleCodes(Core.findRosterPrivateLeak({ phone: 'x', campus: 'imd' })).includes('ROSTER_PRIVATE_FIELD_IN_PUBLIC'));
assert.deepStrictEqual(Core.findRosterPrivateLeak({ campus: 'imd' }), []);

// 명단 누락 기존 참가자는 보고만, active 미변경
const rosterMissing = Core.planRosterUpsert(
  [
    { _row: 2, participant_id: 'pt_1', person_type: 'student', legal_name: '김하늘', campus: 'imd', active: true, source_response_id: 'x' },
    { _row: 3, participant_id: 'pt_2', person_type: 'student', legal_name: '이바다', campus: 'suwan', active: true, source_response_id: 'y' }
  ], [], [{ index: 2, fields: { legal_name: '김하늘', person_type: 'student', campus: 'imd' } }], rosterMap, { mode: 'commit', eventId: 'e' }
);
assert.strictEqual(rosterMissing.summary.missing_existing, 1);
assert.strictEqual(rosterMissing.missingExisting[0].participant_id, 'pt_2');

// 파일 내 중복 / 빈 행 / 필수 누락
const rosterEdge = Core.planRosterUpsert([], [], [
  { index: 2, fields: { legal_name: '중복', person_type: 'student', campus: 'imd' } },
  { index: 3, fields: { legal_name: '중복', person_type: 'student', campus: 'imd' } },
  { index: 4, fields: { legal_name: '', person_type: '', campus: '' } },
  { index: 5, fields: { legal_name: '무캠퍼스', person_type: 'student', campus: '' } }
], rosterMap, { mode: 'commit', eventId: 'e' });
const edgeCodes = ruleCodes(rosterEdge.issues);
assert.ok(edgeCodes.includes('ROSTER_DUPLICATE_IN_FILE'));
assert.ok(edgeCodes.includes('ROSTER_EMPTY_ROW_SKIPPED'));
assert.ok(edgeCodes.includes('ROSTER_REQUIRED_FIELD_MISSING'));
assert.strictEqual(rosterEdge.summary.insert, 1);

// 매핑 없음
assert.ok(ruleCodes(Core.planRosterUpsert([], [], [], [], { mode: 'commit' }).issues).includes('ROSTER_NO_MAPPING'));

// preview와 commit의 계획 집계 일치
const equalityRows = [{ index: 2, fields: { legal_name: '김하늘', person_type: 'student', campus: 'imd', grade_band: 'middle_2' } }];
assert.deepStrictEqual(
  Core.planRosterUpsert(existingOne(), [], equalityRows, rosterMap, { mode: 'preview', eventId: 'e' }).summary,
  Core.planRosterUpsert(existingOne(), [], equalityRows, rosterMap, { mode: 'commit', eventId: 'e' }).summary
);

console.log('Core tests passed');
