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

// ── 성 마스킹 ────────────────────────────────────────────────────────────
assert.strictEqual(Core.maskSurname('홍길동'), '홍○○');       // 단성 3자
assert.strictEqual(Core.maskSurname('김수'), '김○');           // 단성 2자
assert.strictEqual(Core.maskSurname('남궁민수'), '남궁○○');    // 복성 4자
assert.strictEqual(Core.maskSurname('선우정아'), '선우○○');    // 복성 4자
assert.strictEqual(Core.maskSurname('John Smith'), 'John*');    // 영문 폴백(성 미노출)
assert.strictEqual(Core.maskSurname('김'), '김*');              // 한 글자 이름 폴백
assert.strictEqual(Core.maskSurname(''), '');
assert.strictEqual(Core.maskSurname('   '), '');

// ── 내부 인증 검증(순수, 해시함수 주입) ──────────────────────────────────
const crypto = require('crypto');
function sha256hex(text) { return crypto.createHash('sha256').update(String(text)).digest('hex'); }
const storedHash = sha256hex('secret-pw');
assert.strictEqual(Core.verifyInternalCredential('camp', 'secret-pw', 'camp', storedHash, sha256hex), true);   // 정답
assert.strictEqual(Core.verifyInternalCredential('camp', 'wrong-pw', 'camp', storedHash, sha256hex), false);   // 오답(비번)
assert.strictEqual(Core.verifyInternalCredential('intruder', 'secret-pw', 'camp', storedHash, sha256hex), false); // 오답(ID)
assert.strictEqual(Core.verifyInternalCredential('camp', 'secret-pw', 'camp', storedHash.toUpperCase(), sha256hex), true); // hex 대소문자 무관
assert.strictEqual(Core.verifyInternalCredential('camp', 'secret-pw', '', storedHash, sha256hex), false);      // 미설정 storedUser
assert.strictEqual(Core.verifyInternalCredential('camp', 'secret-pw', 'camp', storedHash, null), false);       // 해시함수 미주입

// ── 세션 표시 헬퍼 ───────────────────────────────────────────────────────
assert.strictEqual(Core.sessionPartLabel('morning'), '오전');
assert.strictEqual(Core.sessionPartLabel('afternoon'), '오후');
assert.strictEqual(Core.sessionPartLabel('night'), '밤');
assert.strictEqual(Core.sessionPartLabel('unknown'), '');
const attendanceRows = [
  { participant_id: 'p1', slot_id: 'S_D1_MORNING', presence_status: 'present' },
  { participant_id: 'p1', slot_id: 'S_D1_NIGHT', presence_status: 'absent' },
  { participant_id: 'p2', slot_id: 'S_D1_MORNING', presence_status: 'present' }
];
assert.deepStrictEqual(Core.presentSlotIds(attendanceRows, 'p1'), ['S_D1_MORNING']);
assert.deepStrictEqual(Core.presentSlotIds(attendanceRows), ['S_D1_MORNING', 'S_D1_MORNING']);
const stdSlots = Core.buildStandardTimeSlots('2026-summer');
assert.strictEqual(stdSlots.length, 7);
assert.strictEqual(stdSlots[0].slot_id, 'S_D1_MORNING');
assert.strictEqual(stdSlots[0].label, '1일차 오전');
assert.strictEqual(stdSlots[0].event_id, '2026-summer');
assert.strictEqual(stdSlots[6].day_index, 3);
assert.strictEqual(stdSlots[6].part, 'morning');

// ── 외향성 균형 축 ───────────────────────────────────────────────────────
const distStats = Core.computeDistributionStats([
  { extraversion_score: 1, engagement_score: 2 },
  { extraversion_score: 5, engagement_score: 4 }
]);
assert.strictEqual(distStats.extraversionMean, 3);
assert.strictEqual(distStats.engagementMean, 3);
const balGlobal = { count: 4, groupCount: 2, engagementMean: 3, extraversionMean: 3, campus: { imd: 4 }, grade: { unknown: 4 } };
const highCand = { group: { group_id: 'G1', target_size: 2 }, members: [{ person_type: 'student', extraversion_score: 5, engagement_score: 3, campus: 'imd' }] };
const lowCand = { group: { group_id: 'G2', target_size: 2 }, members: [{ person_type: 'student', extraversion_score: 1, engagement_score: 3, campus: 'imd' }] };
const addHigh = [{ person_type: 'student', extraversion_score: 5, engagement_score: 3, campus: 'imd' }];
const pHigh = Core.incrementalGroupPenalty(highCand, addHigh, balGlobal);
const pLow = Core.incrementalGroupPenalty(lowCand, addHigh, balGlobal);
assert.ok(pHigh > pLow, '외향성이 편중되는 조에 더 높은 페널티가 부여되어야 한다');
assert.strictEqual(Math.round((pHigh - pLow) * 1000) / 1000, 24); // 외향성 편차 항(가중치 12)만 차이

// ── 학생만 자동 배정 + 교사 role 보존 ────────────────────────────────────
const studentOnly = Core.computeGroupProposal({
  groups: [{ group_id: 'G1', active: true, max_size: 999 }],
  participants: [
    { participant_id: 's1', person_type: 'student', active: true },
    { participant_id: 's2', person_type: 'student', active: true },
    { participant_id: 't1', person_type: 'teacher', active: true }
  ],
  attendance: [], relations: [],
  groupAssignments: [{ assignment_id: 'm1', participant_id: 't1', group_id: 'G1', role: 'teacher', assignment_source: 'manual' }]
}, {});
const studentAssigned = studentOnly.assignments.map((a) => a.participant_id).sort();
assert.deepStrictEqual(studentAssigned, ['s1', 's2']);           // 학생만 자동 배정
studentOnly.assignments.forEach((a) => assert.ok(['leader', 'member'].includes(a.role))); // 자동은 leader/member만

// ── 부조장(sub_leader) 수동 배정 보존 + 역할 확보 경고 ───────────────────
const subProposal = Core.computeGroupProposal({
  groups: [{ group_id: 'G1', active: true, max_size: 999 }],
  participants: [
    { participant_id: 's1', person_type: 'student', active: true, leader_candidate: true },
    { participant_id: 's2', person_type: 'student', active: true }
  ],
  attendance: [], relations: [],
  groupAssignments: [{ assignment_id: 'm2', participant_id: 's2', group_id: 'G1', role: 'sub_leader', assignment_source: 'manual' }]
}, {});
const subAssigned = subProposal.assignments.map((a) => a.participant_id);
assert.ok(!subAssigned.includes('s2'));                          // 부조장 수동 배정 보존(재배정 금지)
assert.strictEqual(subProposal.assignments.find((a) => a.participant_id === 's1').role, 'leader'); // 리더 자동 부여
const subCodes = ruleCodes(subProposal.issues);
assert.ok(!subCodes.includes('GROUP_MISSING_LEADER'));           // leader(자동)·sub_leader(수동) 모두 있음
assert.ok(!subCodes.includes('GROUP_MISSING_SUBLEADER'));
const missingRoles = ruleCodes(Core.computeGroupProposal({
  groups: [{ group_id: 'G1', active: true, max_size: 999 }],
  participants: [{ participant_id: 's1', person_type: 'student', active: true }],
  attendance: [], relations: [], groupAssignments: []
}, {}).issues);
assert.ok(missingRoles.includes('GROUP_MISSING_LEADER'));        // 조장 없음 경고
assert.ok(missingRoles.includes('GROUP_MISSING_SUBLEADER'));     // 부조장 없음 경고

// 로스터 insert에 외향성 기본값(3) 반영
assert.strictEqual(rosterInsert.inserts[0].participant.extraversion_score, 3);

// ── 공개 스냅샷 v2 검증(수용/거부) ───────────────────────────────────────
function validV2Snapshot() {
  const s = validSnapshot();
  s.schema_version = 'public-snapshot/v2';
  s.time_slots = [
    { slot_id: 'S_D1_MORNING', label: '1일차 오전', day_index: 1, part: 'morning' },
    { slot_id: 'S_D1_NIGHT', label: '1일차 밤', day_index: 1, part: 'night' }
  ];
  s.groups[0].members[0].campus = '임동';
  s.groups[0].members[0].session_slots = ['S_D1_MORNING'];
  s.groups[0].members.push({ public_id: 'P-XYZ789', public_name: '남궁○○', role: 'sub_leader', campus: '수완', session_slots: [] });
  return s;
}
// v1은 하위호환으로 계속 통과, v2 정본도 통과
assert.deepStrictEqual(Core.validatePublicSnapshot(validSnapshot(), []), []);
assert.deepStrictEqual(Core.validatePublicSnapshot(validV2Snapshot(), []), []);
// role 어휘 확장 수용
const v2Roles = validV2Snapshot(); v2Roles.groups[0].members[0].role = 'teacher';
assert.deepStrictEqual(Core.validatePublicSnapshot(v2Roles, []), []);
// v2인데 time_slots 누락 → 필수 필드 누락
const v2NoSlots = validV2Snapshot(); delete v2NoSlots.time_slots;
assert.ok(ruleCodes(Core.validatePublicSnapshot(v2NoSlots, [])).includes('PUBLIC_REQUIRED_FIELD_MISSING'));
// part/day_index enum 위반
const v2BadPart = validV2Snapshot(); v2BadPart.time_slots[0].part = 'evening';
assert.ok(ruleCodes(Core.validatePublicSnapshot(v2BadPart, [])).includes('PUBLIC_ENUM_INVALID'));
const v2BadDay = validV2Snapshot(); v2BadDay.time_slots[0].day_index = 4;
assert.ok(ruleCodes(Core.validatePublicSnapshot(v2BadDay, [])).includes('PUBLIC_ENUM_INVALID'));
// role enum 위반
const v2BadRole = validV2Snapshot(); v2BadRole.groups[0].members[0].role = 'captain';
assert.ok(ruleCodes(Core.validatePublicSnapshot(v2BadRole, [])).includes('PUBLIC_ENUM_INVALID'));
// session_slots가 존재하지 않는 slot 참조
const v2BadRef = validV2Snapshot(); v2BadRef.groups[0].members[0].session_slots = ['S_NOPE'];
assert.ok(ruleCodes(Core.validatePublicSnapshot(v2BadRef, [])).includes('PUBLIC_REFERENCE_BROKEN'));
// 실명 필드 유입 거부
const v2Extra = validV2Snapshot(); v2Extra.groups[0].members[0].legal_name = '실명';
assert.ok(ruleCodes(Core.validatePublicSnapshot(v2Extra, [])).includes('PUBLIC_FIELD_NOT_ALLOWED'));

// ── 전체 실명 부재 불변조건 ──────────────────────────────────────────────
const v2Leak = validV2Snapshot(); v2Leak.groups[0].members[0].public_name = '홍길동';
assert.ok(ruleCodes(Core.validatePublicSnapshot(v2Leak, [], ['홍길동', '김하늘'])).includes('PUBLIC_FULL_NAME_LEAK'));
assert.deepStrictEqual(ruleCodes(Core.assertNoFullNames(v2Leak, ['홍길동'])), ['PUBLIC_FULL_NAME_LEAK']);
assert.deepStrictEqual(Core.assertNoFullNames(validV2Snapshot(), ['홍길동']), []); // 마스킹된 표시명은 통과

// ── 내부 스냅샷 v1 검증 ──────────────────────────────────────────────────
function validInternalSnapshot() {
  const s = validV2Snapshot();
  s.schema_version = 'internal-snapshot/v1';
  s.groups[0].members[0].full_name = '홍길동';
  s.groups[0].members[1].full_name = '남궁민수';
  s.teachers = [{ participant_id: 'pt_t1', full_name: '이선생', campus: '임동', group_id: 'G01' }];
  s.staff = [{ participant_id: 'pt_s1', full_name: '박스탭', campus: '수완', group_id: null }];
  return s;
}
assert.deepStrictEqual(Core.validateInternalSnapshot(validInternalSnapshot(), []), []);
// 내부는 full_name(실명) 노출이 정상 → PUBLIC_FULL_NAME_LEAK 없음
assert.ok(!ruleCodes(Core.validateInternalSnapshot(validInternalSnapshot(), [])).includes('PUBLIC_FULL_NAME_LEAK'));
// teachers 누락 → 필수 필드 누락
const internalMissing = validInternalSnapshot(); delete internalMissing.teachers;
assert.ok(ruleCodes(Core.validateInternalSnapshot(internalMissing, [])).includes('PUBLIC_REQUIRED_FIELD_MISSING'));
// teachers 허용 외 필드 거부
const internalExtra = validInternalSnapshot(); internalExtra.teachers[0].note = '비고';
assert.ok(ruleCodes(Core.validateInternalSnapshot(internalExtra, [])).includes('PUBLIC_FIELD_NOT_ALLOWED'));
// 공개 검증기는 full_name/teachers를 거부(내부 전용 필드)
assert.ok(ruleCodes(Core.validatePublicSnapshot(validInternalSnapshot(), [])).includes('PUBLIC_FIELD_NOT_ALLOWED'));

// ── 방배정(Room) 검증 순수 로직 ──────────────────────────────────────────
const roomsBasic = [
  { room_id: 'R01', display_name: '101호', capacity: 2, gender_scope: 'male', active: true },
  { room_id: 'R02', display_name: '201호', capacity: 2, gender_scope: 'female', active: true },
  { room_id: 'R09', display_name: '창고', capacity: 4, gender_scope: 'mixed', active: false }
];
const partsBasic = [
  { participant_id: 'p1', gender: 'male', active: true },
  { participant_id: 'p2', gender: 'female', active: true },
  { participant_id: 'p3', gender: 'male', active: true }
];
// 정상 배정 + 미배정 경고(p3만)
const roomOk = Core.validateRoomAssignments(roomsBasic, [
  { room_id: 'R01', participant_id: 'p1' },
  { room_id: 'R02', participant_id: 'p2' }
], partsBasic);
assert.strictEqual(roomOk.summary.blocking, 0);
assert.deepStrictEqual(ruleCodes(roomOk.issues), ['ROOM_UNASSIGNED']);
assert.strictEqual(roomOk.summary.assignments, 2);
// 정원 초과(차단): R01 정원 2에 남 3명
const roomOver = Core.validateRoomAssignments(roomsBasic, [
  { room_id: 'R01', participant_id: 'p1' },
  { room_id: 'R01', participant_id: 'p3' },
  { room_id: 'R01', participant_id: 'pX' }
], partsBasic.concat([{ participant_id: 'pX', gender: 'male', active: true }]));
assert.ok(ruleCodes(roomOver.issues).includes('ROOM_OVER_CAPACITY'));
assert.ok(Core.blockingIssues(roomOver.issues).some((i) => i.rule_code === 'ROOM_OVER_CAPACITY'));
// 성별 불일치(차단): 남성 방에 여성 배정 / mixed는 제약 없음
const roomGender = Core.validateRoomAssignments(roomsBasic, [{ room_id: 'R01', participant_id: 'p2' }], partsBasic);
assert.ok(ruleCodes(roomGender.issues).includes('ROOM_GENDER_MISMATCH'));
const roomMixed = Core.validateRoomAssignments(
  [{ room_id: 'RM', capacity: 4, gender_scope: 'mixed', active: true }],
  [{ room_id: 'RM', participant_id: 'p1' }, { room_id: 'RM', participant_id: 'p2' }],
  partsBasic
);
assert.ok(!ruleCodes(roomMixed.issues).includes('ROOM_GENDER_MISMATCH'));
// 중복 배정(차단): p1이 두 방에
const roomDup = Core.validateRoomAssignments(roomsBasic, [
  { room_id: 'R01', participant_id: 'p1' },
  { room_id: 'R02', participant_id: 'p1' }
], partsBasic);
assert.ok(ruleCodes(roomDup.issues).includes('ROOM_DUPLICATE_ASSIGNMENT'));
// 알 수 없는 참조(차단): 없는 방/참가자 각각
const roomRef = Core.validateRoomAssignments(roomsBasic, [
  { room_id: 'R99', participant_id: 'p1' },
  { room_id: 'R01', participant_id: 'pZZZ' }
], partsBasic);
assert.strictEqual(ruleCodes(roomRef.issues).filter((c) => c === 'ROOM_UNKNOWN_REF').length, 2);
// 비활성 방 배정(경고)
const roomInactive = Core.validateRoomAssignments(roomsBasic, [
  { room_id: 'R09', participant_id: 'p1' },
  { room_id: 'R09', participant_id: 'p2' },
  { room_id: 'R09', participant_id: 'p3' }
], partsBasic);
const inactiveIssue = roomInactive.issues.find((i) => i.rule_code === 'ROOM_INACTIVE_TARGET');
assert.ok(inactiveIssue && inactiveIssue.blocking === false);
// 미배정(경고): 활성 참가자 전원 미배정, 모두 비차단
const roomUnassigned = Core.validateRoomAssignments(roomsBasic, [], partsBasic);
assert.strictEqual(ruleCodes(roomUnassigned.issues).filter((c) => c === 'ROOM_UNASSIGNED').length, 3);
roomUnassigned.issues.forEach((i) => assert.strictEqual(i.blocking, false));

// ── 공개 스냅샷 v3 검증(rooms 수용/거부) ─────────────────────────────────
function validV3Snapshot() {
  const s = validV2Snapshot();
  s.schema_version = 'public-snapshot/v3';
  s.rooms = [
    { room_id: 'R01', display_name: '101호', floor: '1', gender_scope: 'male', capacity: 4, occupancy: 1,
      members: [{ public_id: 'P-ABC234', public_name: '김○○', person_type: 'student', campus: '임동' }] },
    { room_id: 'R02', display_name: '201호', floor: '2', gender_scope: 'mixed', capacity: 4, occupancy: 0, members: [] }
  ];
  return s;
}
// v1/v2 하위호환 유지 + v3 정본 통과
assert.deepStrictEqual(Core.validatePublicSnapshot(validSnapshot(), []), []);
assert.deepStrictEqual(Core.validatePublicSnapshot(validV2Snapshot(), []), []);
assert.deepStrictEqual(Core.validatePublicSnapshot(validV3Snapshot(), []), []);
// v3인데 rooms 누락 → 필수 필드 누락
const v3NoRooms = validV3Snapshot(); delete v3NoRooms.rooms;
assert.ok(ruleCodes(Core.validatePublicSnapshot(v3NoRooms, [])).includes('PUBLIC_REQUIRED_FIELD_MISSING'));
// gender_scope enum 위반
const v3BadGender = validV3Snapshot(); v3BadGender.rooms[0].gender_scope = 'coed';
assert.ok(ruleCodes(Core.validatePublicSnapshot(v3BadGender, [])).includes('PUBLIC_ENUM_INVALID'));
// occupancy 불일치
const v3BadOcc = validV3Snapshot(); v3BadOcc.rooms[0].occupancy = 5;
assert.ok(ruleCodes(Core.validatePublicSnapshot(v3BadOcc, [])).includes('PUBLIC_OCCUPANCY_MISMATCH'));
// room person_type enum 위반
const v3BadType = validV3Snapshot(); v3BadType.rooms[0].members[0].person_type = 'volunteer';
assert.ok(ruleCodes(Core.validatePublicSnapshot(v3BadType, [])).includes('PUBLIC_ENUM_INVALID'));
// room 허용 외 필드 거부(내부 전용 private_note)
const v3RoomExtra = validV3Snapshot(); v3RoomExtra.rooms[0].private_note = '비고';
assert.ok(ruleCodes(Core.validatePublicSnapshot(v3RoomExtra, [])).includes('PUBLIC_FIELD_NOT_ALLOWED'));
// room member 실명 필드(full_name) 공개 유입 거부
const v3FullName = validV3Snapshot(); v3FullName.rooms[0].members[0].full_name = '실명';
assert.ok(ruleCodes(Core.validatePublicSnapshot(v3FullName, [])).includes('PUBLIC_FIELD_NOT_ALLOWED'));
// room_id 중복
const v3Dup = validV3Snapshot(); v3Dup.rooms[1].room_id = 'R01';
assert.ok(ruleCodes(Core.validatePublicSnapshot(v3Dup, [])).includes('PUBLIC_DUPLICATE_ID'));
// 공개 rooms 표시명이 전체 실명과 동일 → 성 마스킹 실패
const v3Leak = validV3Snapshot(); v3Leak.rooms[0].members[0].public_name = '홍길동';
assert.ok(ruleCodes(Core.validatePublicSnapshot(v3Leak, [], ['홍길동'])).includes('PUBLIC_FULL_NAME_LEAK'));
assert.deepStrictEqual(Core.assertNoFullNames(validV3Snapshot(), ['홍길동']), []); // 마스킹된 표시명은 통과

// ── 내부 스냅샷 v2 검증(rooms full_name 수용) ────────────────────────────
function validInternalV2Snapshot() {
  const s = validV3Snapshot();
  s.schema_version = 'internal-snapshot/v2';
  s.groups[0].members[0].full_name = '홍길동';
  s.groups[0].members[1].full_name = '남궁민수';
  s.teachers = [{ participant_id: 'pt_t1', full_name: '이선생', campus: '임동', group_id: 'G01' }];
  s.staff = [{ participant_id: 'pt_s1', full_name: '박스탭', campus: '수완', group_id: null }];
  s.rooms[0].members[0].full_name = '홍길동'; // 내부 뷰는 전체 이름 정상 노출
  return s;
}
assert.deepStrictEqual(Core.validateInternalSnapshot(validInternalV2Snapshot(), []), []);
// 내부는 rooms full_name(실명) 노출이 정상 → 유출/미허용 이슈 없음
assert.ok(!ruleCodes(Core.validateInternalSnapshot(validInternalV2Snapshot(), [])).includes('PUBLIC_FULL_NAME_LEAK'));
assert.ok(!ruleCodes(Core.validateInternalSnapshot(validInternalV2Snapshot(), [])).includes('PUBLIC_FIELD_NOT_ALLOWED'));
// 내부 v1 하위호환 유지
assert.deepStrictEqual(Core.validateInternalSnapshot(validInternalSnapshot(), []), []);
// v2 내부인데 rooms 누락 → 필수 필드 누락
const iv2NoRooms = validInternalV2Snapshot(); delete iv2NoRooms.rooms;
assert.ok(ruleCodes(Core.validateInternalSnapshot(iv2NoRooms, [])).includes('PUBLIC_REQUIRED_FIELD_MISSING'));
// 공개 검증기는 내부 v2(rooms full_name/teachers)를 거부
assert.ok(ruleCodes(Core.validatePublicSnapshot(validInternalV2Snapshot(), [])).includes('PUBLIC_FIELD_NOT_ALLOWED'));

// ── 차량 시간 버킷(tripTimeBucket) ───────────────────────────────────────
// 임계 경계: 00–11 morning, 12–17 afternoon, 18–23 night
assert.strictEqual(Core.tripTimeBucket('2026-07-23T11:59:00+09:00', 'Asia/Seoul'), 'morning');   // 11:59 → 오전
assert.strictEqual(Core.tripTimeBucket('2026-07-23T12:00:00+09:00', 'Asia/Seoul'), 'afternoon'); // 12:00 → 오후
assert.strictEqual(Core.tripTimeBucket('2026-07-23T17:59:00+09:00', 'Asia/Seoul'), 'afternoon'); // 17:59 → 오후
assert.strictEqual(Core.tripTimeBucket('2026-07-23T18:00:00+09:00', 'Asia/Seoul'), 'night');     // 18:00 → 밤
assert.strictEqual(Core.tripTimeBucket('2026-07-23T00:00:00+09:00', 'Asia/Seoul'), 'morning');   // 자정 경계
assert.strictEqual(Core.tripTimeBucket('2026-07-23T23:30:00+09:00', 'Asia/Seoul'), 'night');
// 오프셋 포함 ISO: 문자열에 적힌 로컬 시각 hour를 그대로 사용(오프셋이 다르면 그 오프셋 기준 벽시계)
assert.strictEqual(Core.tripTimeBucket('2026-07-23T09:00:00-05:00', 'Asia/Seoul'), 'morning');   // 09시(로컬) → 오전
assert.strictEqual(Core.tripTimeBucket('2026-07-23T20:00:00+00:00', 'Asia/Seoul'), 'night');     // 20시(로컬) → 밤
// 오프셋 없는 ISO: timezone(Asia/Seoul) 벽시계로 간주
assert.strictEqual(Core.tripTimeBucket('2026-07-23T13:30:00', 'Asia/Seoul'), 'afternoon');
assert.strictEqual(Core.tripTimeBucket('2026-07-23T13:30', 'Asia/Seoul'), 'afternoon');
// 파싱 불가/빈값 → 빈 버킷
assert.strictEqual(Core.tripTimeBucket('', 'Asia/Seoul'), '');
assert.strictEqual(Core.tripTimeBucket('not-a-date', 'Asia/Seoul'), '');
// 버킷 라벨은 세션과 동일 어휘(오전/오후/밤) 재사용
assert.strictEqual(Core.sessionPartLabel(Core.tripTimeBucket('2026-07-23T18:00:00+09:00', 'Asia/Seoul')), '밤');

// ── 공개 스냅샷 v4 검증(time_bucket 수용/거부 + 탑승자 마스킹) ────────────
function validV4Snapshot() {
  const s = validV3Snapshot();
  s.schema_version = 'public-snapshot/v4';
  s.trips[0].time_bucket = 'afternoon'; // 13:30 출발 → 오후
  return s;
}
// v1~v3 하위호환 유지 + v4 정본 통과
assert.deepStrictEqual(Core.validatePublicSnapshot(validSnapshot(), []), []);
assert.deepStrictEqual(Core.validatePublicSnapshot(validV2Snapshot(), []), []);
assert.deepStrictEqual(Core.validatePublicSnapshot(validV3Snapshot(), []), []);
assert.deepStrictEqual(Core.validatePublicSnapshot(validV4Snapshot(), []), []);
// v4인데 time_bucket 누락 → 필수 필드 누락
const v4NoBucket = validV4Snapshot(); delete v4NoBucket.trips[0].time_bucket;
assert.ok(ruleCodes(Core.validatePublicSnapshot(v4NoBucket, [])).includes('PUBLIC_REQUIRED_FIELD_MISSING'));
// time_bucket enum 위반
const v4BadBucket = validV4Snapshot(); v4BadBucket.trips[0].time_bucket = 'evening';
assert.ok(ruleCodes(Core.validatePublicSnapshot(v4BadBucket, [])).includes('PUBLIC_ENUM_INVALID'));
// 탑승자 실명 필드(full_name) 공개 유입 거부
const v4PaxFull = validV4Snapshot(); v4PaxFull.trips[0].passengers[0].full_name = '실명';
assert.ok(ruleCodes(Core.validatePublicSnapshot(v4PaxFull, [])).includes('PUBLIC_FIELD_NOT_ALLOWED'));
// 마스킹된 탑승자 표시명은 통과, 전체 실명이 표시명이면 성 마스킹 실패
const v4PaxMasked = validV4Snapshot(); v4PaxMasked.trips[0].passengers[0].public_name = '김○○';
assert.deepStrictEqual(Core.validatePublicSnapshot(v4PaxMasked, [], ['홍길동']), []);
const v4PaxLeak = validV4Snapshot(); v4PaxLeak.trips[0].passengers[0].public_name = '홍길동';
assert.ok(ruleCodes(Core.validatePublicSnapshot(v4PaxLeak, [], ['홍길동'])).includes('PUBLIC_FULL_NAME_LEAK'));
assert.deepStrictEqual(ruleCodes(Core.assertNoFullNames(v4PaxLeak, ['홍길동'])), ['PUBLIC_FULL_NAME_LEAK']);
assert.deepStrictEqual(Core.assertNoFullNames(validV4Snapshot(), ['홍길동']), []); // 마스킹된 탑승자는 통과

// ── 내부 스냅샷 v3 검증(trips passengers full_name 수용) ──────────────────
function validInternalV3Snapshot() {
  const s = validV4Snapshot();
  s.schema_version = 'internal-snapshot/v3';
  s.groups[0].members[0].full_name = '홍길동';
  s.groups[0].members[1].full_name = '남궁민수';
  s.teachers = [{ participant_id: 'pt_t1', full_name: '이선생', campus: '임동', group_id: 'G01' }];
  s.staff = [{ participant_id: 'pt_s1', full_name: '박스탭', campus: '수완', group_id: null }];
  s.rooms[0].members[0].full_name = '홍길동';
  s.trips[0].passengers[0].full_name = '홍길동'; // 내부 차량 뷰는 전체 이름 정상 노출
  return s;
}
assert.deepStrictEqual(Core.validateInternalSnapshot(validInternalV3Snapshot(), []), []);
// 내부는 탑승자 full_name(실명) 노출이 정상 → 유출/미허용 이슈 없음
assert.ok(!ruleCodes(Core.validateInternalSnapshot(validInternalV3Snapshot(), [])).includes('PUBLIC_FULL_NAME_LEAK'));
assert.ok(!ruleCodes(Core.validateInternalSnapshot(validInternalV3Snapshot(), [])).includes('PUBLIC_FIELD_NOT_ALLOWED'));
// 내부 v1·v2 하위호환 유지
assert.deepStrictEqual(Core.validateInternalSnapshot(validInternalSnapshot(), []), []);
assert.deepStrictEqual(Core.validateInternalSnapshot(validInternalV2Snapshot(), []), []);
// 내부 v3인데 time_bucket 누락 → 필수 필드 누락
const iv3NoBucket = validInternalV3Snapshot(); delete iv3NoBucket.trips[0].time_bucket;
assert.ok(ruleCodes(Core.validateInternalSnapshot(iv3NoBucket, [])).includes('PUBLIC_REQUIRED_FIELD_MISSING'));
// 공개 검증기는 내부 v3(탑승자 full_name/teachers)를 거부
assert.ok(ruleCodes(Core.validatePublicSnapshot(validInternalV3Snapshot(), [])).includes('PUBLIC_FIELD_NOT_ALLOWED'));

// ── 내부 식별자(pt_ UUID) 오탐 방지 vs 진짜 PII 차단 유지 ──────────────────
// 내부 스냅샷은 teachers/staff participant_id에 pt_+UUID를 정당하게 가진다 → PUBLIC_FIELD_LEAK 오탐 금지.
function internalWithRealIds() {
  const s = validInternalV3Snapshot();
  s.teachers = [{ participant_id: 'pt_9f3c1a2b4d5e6f7a8b9c0d1e', full_name: '이선생', campus: '임동', group_id: 'G01' }];
  s.staff = [{ participant_id: 'pt_00112233445566778899aabb', full_name: '박스탭', campus: '수완', group_id: null }];
  return s;
}
// 내부 검증기는 pt_ 내부 ID를 유출로 보지 않는다
assert.ok(!ruleCodes(Core.validateInternalSnapshot(internalWithRealIds(), [])).includes('PUBLIC_FIELD_LEAK'));
assert.deepStrictEqual(Core.validateInternalSnapshot(internalWithRealIds(), []), []);
// 그러나 공개 검증기는 동일 pt_ 패턴을 여전히 유출로 차단(가드는 공개 전용으로 유지)
const publicPtLeak = validV4Snapshot(); publicPtLeak.notices.push({ notice_id: 'N9', title: '안내', message: '문의: pt_9f3c1a2b4d5e6f7a8b9c0d1e', severity: 'info' });
assert.ok(ruleCodes(Core.validatePublicSnapshot(publicPtLeak, [])).includes('PUBLIC_FIELD_LEAK'));
// 진짜 PII(전화번호)는 내부 스냅샷에서도 여전히 차단
const internalPhone = internalWithRealIds(); internalPhone.notices.push({ notice_id: 'N8', title: '연락', message: '010-1234-5678', severity: 'info' });
assert.ok(ruleCodes(Core.validateInternalSnapshot(internalPhone, [])).includes('PUBLIC_FIELD_LEAK'));
// 진짜 PII(이메일)도 내부에서 차단
const internalEmail = internalWithRealIds(); internalEmail.notices.push({ notice_id: 'N7', title: '메일', message: 'a@b.com', severity: 'info' });
assert.ok(ruleCodes(Core.validateInternalSnapshot(internalEmail, [])).includes('PUBLIC_FIELD_LEAK'));
// sensitiveValues(주입 비밀값) 스캔은 내부에서도 유지
const internalCanary = internalWithRealIds(); internalCanary.notices.push({ notice_id: 'N6', title: '안내', message: 'PRIVATE-CANARY', severity: 'info' });
assert.ok(ruleCodes(Core.validateInternalSnapshot(internalCanary, ['PRIVATE-CANARY'])).includes('PUBLIC_FIELD_LEAK'));

// ── 참석 여부(자유텍스트) → 세션 present/absent 순수 로직 ──────────────────
// parseAttendanceSpec: 전일/Full, 단일, 복수, 빈값, 미인식, 중복 제거
assert.deepStrictEqual(Core.parseAttendanceSpec('전일 참석(Full)'), { full: true, days: [] });
assert.deepStrictEqual(Core.parseAttendanceSpec('전일'), { full: true, days: [] });
assert.deepStrictEqual(Core.parseAttendanceSpec('Full attendance'), { full: true, days: [] }); // 대소문자 무관
assert.deepStrictEqual(Core.parseAttendanceSpec('부분 참석 (3일)'), { full: false, days: [3] });
assert.deepStrictEqual(Core.parseAttendanceSpec('부분 참석 (3일), 부분 참석 (4일)'), { full: false, days: [3, 4] });
assert.deepStrictEqual(Core.parseAttendanceSpec('부분 참석 (4일), 부분 참석 (5일)'), { full: false, days: [4, 5] });
assert.deepStrictEqual(Core.parseAttendanceSpec('부분 참석 (4일), 부분 참석 (4일)'), { full: false, days: [4] }); // 중복 제거
assert.deepStrictEqual(Core.parseAttendanceSpec(''), { full: false, days: [] });
assert.deepStrictEqual(Core.parseAttendanceSpec('미정'), { full: false, days: [] });
assert.deepStrictEqual(Core.parseAttendanceSpec(null), { full: false, days: [] });

// buildDayIndexByDayOfMonth: 기본 구간, ISO 시각 포함, 월 경계, 무효 입력
assert.deepStrictEqual(Core.buildDayIndexByDayOfMonth('2026-08-03', '2026-08-05'), { 3: 1, 4: 2, 5: 3 });
assert.deepStrictEqual(Core.buildDayIndexByDayOfMonth('2026-08-03T00:00:00+09:00', '2026-08-05T18:00:00+09:00'), { 3: 1, 4: 2, 5: 3 });
assert.deepStrictEqual(Core.buildDayIndexByDayOfMonth('2026-07-31', '2026-08-02'), { 31: 1, 1: 2, 2: 3 }); // 월 경계
assert.deepStrictEqual(Core.buildDayIndexByDayOfMonth('2026-08-03', '2026-08-03'), { 3: 1 });              // 단일 일
assert.deepStrictEqual(Core.buildDayIndexByDayOfMonth('', ''), {});                                        // 빈값
assert.deepStrictEqual(Core.buildDayIndexByDayOfMonth('2026-08-05', '2026-08-03'), {});                    // 시작>종료 무효

// attendanceSlotIds: full=7개, 부분=해당 일차 슬롯, 미매핑 날짜=빈 배열
const attSlots = Core.buildStandardTimeSlots('2026-summer'); // 7슬롯, day_index 1..3
const dayMap = Core.buildDayIndexByDayOfMonth('2026-08-03', '2026-08-05'); // {3:1,4:2,5:3}
assert.strictEqual(Core.attendanceSlotIds({ full: true, days: [] }, attSlots, dayMap).length, 7);
assert.deepStrictEqual(
  Core.attendanceSlotIds({ full: false, days: [3] }, attSlots, dayMap), // 3일 → day_index 1 → 1일차 3슬롯
  ['S_D1_MORNING', 'S_D1_AFTERNOON', 'S_D1_NIGHT']
);
assert.deepStrictEqual(
  Core.attendanceSlotIds({ full: false, days: [5] }, attSlots, dayMap), // 5일 → day_index 3 → 3일차 1슬롯
  ['S_D3_MORNING']
);
assert.deepStrictEqual(
  Core.attendanceSlotIds({ full: false, days: [3, 4] }, attSlots, dayMap).sort(),
  ['S_D1_AFTERNOON', 'S_D1_MORNING', 'S_D1_NIGHT', 'S_D2_AFTERNOON', 'S_D2_MORNING', 'S_D2_NIGHT']
);
assert.deepStrictEqual(Core.attendanceSlotIds({ full: false, days: [9] }, attSlots, dayMap), []); // 매핑 없는 날짜

// reconcileAttendance: present/absent 전환, locked 보존, 멱등, 참가자 필터
const allIds = attSlots.map((s) => s.slot_id);
// 신규 참가자(기존 행 없음): 1일차만 present → present 3 + absent 4(모두 신규)
const rec1 = Core.reconcileAttendance([], 'p1', ['S_D1_MORNING', 'S_D1_AFTERNOON', 'S_D1_NIGHT'], allIds);
assert.strictEqual(rec1.toSetPresent.length, 3);
assert.strictEqual(rec1.toSetAbsent.length, 4);
assert.ok(rec1.toSetPresent.concat(rec1.toSetAbsent).every((i) => i.isNew));
// 멱등: 목표와 동일한 기존 행이면 unchanged 7, 변경 0
const existingAtt = allIds.map((id, i) => ({
  _row: i + 2, participant_id: 'p1', slot_id: id,
  presence_status: ['S_D1_MORNING', 'S_D1_AFTERNOON', 'S_D1_NIGHT'].includes(id) ? 'present' : 'absent',
  locked: false
}));
const rec2 = Core.reconcileAttendance(existingAtt, 'p1', ['S_D1_MORNING', 'S_D1_AFTERNOON', 'S_D1_NIGHT'], allIds);
assert.strictEqual(rec2.unchanged.length, 7);
assert.strictEqual(rec2.toSetPresent.length, 0);
assert.strictEqual(rec2.toSetAbsent.length, 0);
// present↔absent 전환: 이제 2일차 오전만 present
const rec3 = Core.reconcileAttendance(existingAtt, 'p1', ['S_D2_MORNING'], allIds);
assert.deepStrictEqual(rec3.toSetPresent.map((i) => i.slot_id), ['S_D2_MORNING']);
assert.deepStrictEqual(rec3.toSetAbsent.map((i) => i.slot_id).sort(), ['S_D1_AFTERNOON', 'S_D1_MORNING', 'S_D1_NIGHT']);
rec3.toSetPresent.concat(rec3.toSetAbsent).forEach((i) => assert.strictEqual(i.isNew, false)); // 기존 행 갱신
// locked 보존: S_D1_MORNING이 locked면 전부 absent 목표라도 건드리지 않음
const lockedAtt = existingAtt.map((r) => r.slot_id === 'S_D1_MORNING' ? Object.assign({}, r, { locked: true }) : r);
const rec4 = Core.reconcileAttendance(lockedAtt, 'p1', [], allIds);
assert.deepStrictEqual(rec4.lockedSkipped, ['S_D1_MORNING']);
assert.ok(!rec4.toSetPresent.concat(rec4.toSetAbsent).some((i) => i.slot_id === 'S_D1_MORNING'));
// 다른 참가자 행은 무시(p1 신규로 처리)
const rec5 = Core.reconcileAttendance(
  [{ _row: 2, participant_id: 'pX', slot_id: 'S_D1_MORNING', presence_status: 'present', locked: false }],
  'p1', ['S_D1_MORNING'], ['S_D1_MORNING']
);
assert.strictEqual(rec5.toSetPresent.length, 1);
assert.strictEqual(rec5.toSetPresent[0].isNew, true);

// 통합: parse → slotIds → reconcile(멱등) 파이프라인
const specFull = Core.parseAttendanceSpec('전일 참석(Full)');
const fullIds = Core.attendanceSlotIds(specFull, attSlots, dayMap);
const recFull = Core.reconcileAttendance([], 'p2', fullIds, allIds);
assert.strictEqual(recFull.toSetPresent.length, 7);
assert.strictEqual(recFull.toSetAbsent.length, 0);

// ── 만료 토큰(issueAuthToken/verifyAuthToken, HMAC 주입) ─────────────────
function hmacHex(secret, message) {
  return crypto.createHmac('sha256', String(secret)).update(String(message)).digest('hex');
}
const TOKEN_SECRET = 'super-long-random-secret-for-tests';
const T0 = 1_800_000_000_000; // 임의 기준 시각(ms)
const TTL = 60 * 60 * 1000;   // 1시간

// 왕복 성공: 발급 → 만료 전 검증 → ok/user 일치
const goodToken = Core.issueAuthToken('camp', T0, TTL, TOKEN_SECRET, hmacHex);
const verified = Core.verifyAuthToken(goodToken, T0 + 1000, TOKEN_SECRET, hmacHex);
assert.deepStrictEqual(verified, { ok: true, user: 'camp', reason: 'ok' });
// 한글/비ASCII user도 base64url 왕복
const hangulToken = Core.issueAuthToken('관리자', T0, TTL, TOKEN_SECRET, hmacHex);
assert.strictEqual(Core.verifyAuthToken(hangulToken, T0 + 1, TOKEN_SECRET, hmacHex).user, '관리자');

// 만료: nowMs > exp → reason 'expired'
const expired = Core.verifyAuthToken(goodToken, T0 + TTL + 1, TOKEN_SECRET, hmacHex);
assert.strictEqual(expired.ok, false);
assert.strictEqual(expired.reason, 'expired');
// 경계: nowMs === exp 는 만료로 간주(exp > now 필요)
assert.strictEqual(Core.verifyAuthToken(goodToken, T0 + TTL, TOKEN_SECRET, hmacHex).reason, 'expired');

// 서명 변조: 마지막 문자만 바꿔도 bad_signature
const tamperedSig = goodToken.slice(0, -1) + (goodToken.slice(-1) === 'a' ? 'b' : 'a');
const badSig = Core.verifyAuthToken(tamperedSig, T0 + 1000, TOKEN_SECRET, hmacHex);
assert.strictEqual(badSig.ok, false);
assert.strictEqual(badSig.reason, 'bad_signature');

// payload 변조: base64url payload를 다른 값으로 교체하면 서명 불일치
const forgedPayload = Buffer.from('intruder|' + (T0 + TTL), 'utf8').toString('base64url');
const forgedToken = forgedPayload + '.' + goodToken.split('.')[1];
const forged = Core.verifyAuthToken(forgedToken, T0 + 1000, TOKEN_SECRET, hmacHex);
assert.strictEqual(forged.ok, false);
assert.strictEqual(forged.reason, 'bad_signature');

// 형식 오류: 점 없음/빈 조각 → malformed
assert.strictEqual(Core.verifyAuthToken('no-dot-token', T0, TOKEN_SECRET, hmacHex).reason, 'malformed');
assert.strictEqual(Core.verifyAuthToken('.sig', T0, TOKEN_SECRET, hmacHex).reason, 'malformed');
assert.strictEqual(Core.verifyAuthToken('payload.', T0, TOKEN_SECRET, hmacHex).reason, 'malformed');

// 비밀키 빈값: ok:false, reason 'bad_signature'(쓰기 안전 기본값 잠금)
assert.deepStrictEqual(Core.verifyAuthToken(goodToken, T0 + 1000, '', hmacHex), { ok: false, user: null, reason: 'bad_signature' });
// 다른 비밀키로 검증 → bad_signature
assert.strictEqual(Core.verifyAuthToken(goodToken, T0 + 1000, 'other-secret', hmacHex).reason, 'bad_signature');
// hex 대소문자 무관(주입 함수가 대문자 hex를 반환해도 통과)
function hmacHexUpper(secret, message) { return hmacHex(secret, message).toUpperCase(); }
assert.strictEqual(Core.verifyAuthToken(
  Core.issueAuthToken('camp', T0, TTL, TOKEN_SECRET, hmacHexUpper), T0 + 1, TOKEN_SECRET, hmacHex
).ok, true);

// ── 입력 검증: validateSettingsInput ─────────────────────────────────────
const settingsOk = Core.validateSettingsInput({
  EVENT_NAME: '2026 여름수련회', EVENT_START_DATE: '2026-07-23', EVENT_END_DATE: '2026-07-25',
  GROUP_COUNT: '6', ROOM_COUNT: 8, ATTENDANCE_SOURCE_HEADER: '참석 여부'
});
assert.strictEqual(settingsOk.ok, true);
assert.strictEqual(settingsOk.sanitized.GROUP_COUNT, '6');
assert.strictEqual(settingsOk.sanitized.ROOM_COUNT, '8');
assert.strictEqual(settingsOk.sanitized.EVENT_START_DATE, '2026-07-23');
// 빈 날짜는 '미정'으로 허용
assert.strictEqual(Core.validateSettingsInput({ EVENT_START_DATE: '' }).sanitized.EVENT_START_DATE, '');
// 허용 외 키 거부(커서/상태키 편집 차단)
const settingsForbidden = Core.validateSettingsInput({ LAST_PUBLISH_ID: 'x', LAST_SYNC_ROW_STUDENTS: '99', EVENT_ID: 'hack' });
assert.strictEqual(settingsForbidden.ok, false);
assert.strictEqual(ruleCodes(settingsForbidden.issues).filter((c) => c === 'SETTINGS_KEY_NOT_EDITABLE').length, 3);
assert.deepStrictEqual(settingsForbidden.sanitized, {});
// 잘못된 날짜 형식/비존재 날짜 거부
assert.ok(ruleCodes(Core.validateSettingsInput({ EVENT_START_DATE: '2026/07/23' }).issues).includes('SETTINGS_DATE_INVALID'));
assert.ok(ruleCodes(Core.validateSettingsInput({ EVENT_END_DATE: '2026-13-40' }).issues).includes('SETTINGS_DATE_INVALID'));
// 개수: 0/음수/비정수/상한초과 거부
['0', '-1', '2.5', '51'].forEach((v) => assert.ok(ruleCodes(Core.validateSettingsInput({ GROUP_COUNT: v }).issues).includes('SETTINGS_COUNT_INVALID'), 'GROUP_COUNT=' + v));

// ── 입력 검증: validateFieldMapInput ─────────────────────────────────────
const fieldMapOk = Core.validateFieldMapInput([
  { source_sheet: 'Form_Raw_Students', source_header: '이름', normalized_field: 'legal_name', required: true, active: true },
  { source_sheet: 'Roster_Import', source_header: '연락처', normalized_field: 'phone', required: false, active: 'yes' }
]);
assert.strictEqual(fieldMapOk.ok, true);
assert.strictEqual(fieldMapOk.sanitized.length, 2);
assert.strictEqual(fieldMapOk.sanitized[0].required, true);
assert.strictEqual(fieldMapOk.sanitized[1].active, true);
// source_header 빈값 → 경고(비차단)
const fieldMapWarn = Core.validateFieldMapInput([{ source_sheet: 'Form_Raw_Staff', source_header: '', normalized_field: 'campus' }]);
assert.strictEqual(fieldMapWarn.ok, true);
assert.ok(ruleCodes(fieldMapWarn.issues).includes('FIELD_MAP_HEADER_BLANK'));
// 허용 외 source_sheet 거부
assert.ok(ruleCodes(Core.validateFieldMapInput([{ source_sheet: 'Random_Sheet', normalized_field: 'campus' }]).issues).includes('FIELD_MAP_SOURCE_INVALID'));
// 어휘 밖 normalized_field 거부
const fieldMapBadField = Core.validateFieldMapInput([{ source_sheet: 'Form_Raw_Students', normalized_field: 'nickname' }]);
assert.strictEqual(fieldMapBadField.ok, false);
assert.ok(ruleCodes(fieldMapBadField.issues).includes('FIELD_MAP_FIELD_INVALID'));

// ── 입력 검증: validateGroupsInput ───────────────────────────────────────
const groupsOk = Core.validateGroupsInput([
  { group_id: 'G01', display_name: '1조', target_size: 8, min_size: 6, max_size: 10, active: true },
  { display_name: '신규조', active: 'true' } // 신규(id 없음), 크기 미지정 허용
]);
assert.strictEqual(groupsOk.ok, true);
assert.strictEqual(groupsOk.sanitized[0].group_id, 'G01'); // 기존 id 보존
assert.strictEqual(groupsOk.sanitized[0].target_size, 8);
assert.strictEqual(groupsOk.sanitized[1].group_id, undefined); // 신규는 id 없음
// display_name 필수
assert.ok(ruleCodes(Core.validateGroupsInput([{ group_id: 'G01', display_name: '' }]).issues).includes('GROUP_NAME_REQUIRED'));
// 음수 크기 거부(차단)
const groupsNeg = Core.validateGroupsInput([{ display_name: '조', target_size: -1 }]);
assert.strictEqual(groupsNeg.ok, false);
assert.ok(ruleCodes(groupsNeg.issues).includes('SIZE_FIELD_INVALID'));
// min>target>max 순서 위반은 경고(비차단)
const groupsOrder = Core.validateGroupsInput([{ display_name: '조', target_size: 5, min_size: 8, max_size: 6 }]);
assert.strictEqual(groupsOrder.ok, true);
assert.ok(ruleCodes(groupsOrder.issues).includes('GROUP_SIZE_ORDER'));

// ── 입력 검증: validateRoomsInput ────────────────────────────────────────
const roomsInputOk = Core.validateRoomsInput([
  { room_id: 'R01', display_name: '101호', capacity: 4, gender_scope: 'MALE', floor: '1', active: true }
]);
assert.strictEqual(roomsInputOk.ok, true);
assert.strictEqual(roomsInputOk.sanitized[0].room_id, 'R01'); // 보존
assert.strictEqual(roomsInputOk.sanitized[0].gender_scope, 'male'); // 소문자 정규화
assert.strictEqual(roomsInputOk.sanitized[0].capacity, 4);
// display_name 필수 / capacity>0 / gender_scope enum
assert.ok(ruleCodes(Core.validateRoomsInput([{ display_name: '', capacity: 4, gender_scope: 'male' }]).issues).includes('ROOM_NAME_REQUIRED'));
assert.ok(ruleCodes(Core.validateRoomsInput([{ display_name: '방', capacity: 0, gender_scope: 'male' }]).issues).includes('ROOM_CAPACITY_INVALID'));
assert.ok(ruleCodes(Core.validateRoomsInput([{ display_name: '방', capacity: -3, gender_scope: 'male' }]).issues).includes('ROOM_CAPACITY_INVALID'));
const roomsBadScope = Core.validateRoomsInput([{ display_name: '방', capacity: 4, gender_scope: 'coed' }]);
assert.strictEqual(roomsBadScope.ok, false);
assert.ok(ruleCodes(roomsBadScope.issues).includes('ROOM_GENDER_SCOPE_INVALID'));

// ── 입력 검증: validateVehiclesInput ─────────────────────────────────────
const vehiclesOk = Core.validateVehiclesInput([
  { vehicle_id: 'V01', public_label: '교회 차량 1', capacity_total: 10, accessible: false, active: true },
  { public_label: '카풀', capacity_total: '4', accessible: 'yes' } // 신규
]);
assert.strictEqual(vehiclesOk.ok, true);
assert.strictEqual(vehiclesOk.sanitized[0].vehicle_id, 'V01'); // 보존
assert.strictEqual(vehiclesOk.sanitized[1].vehicle_id, undefined); // 신규
assert.strictEqual(vehiclesOk.sanitized[1].capacity_total, 4);
assert.strictEqual(vehiclesOk.sanitized[1].accessible, true);
// public_label 필수(공개표시) / capacity_total ≥ 2
assert.ok(ruleCodes(Core.validateVehiclesInput([{ public_label: '', capacity_total: 5 }]).issues).includes('VEHICLE_LABEL_REQUIRED'));
const vehiclesSmall = Core.validateVehiclesInput([{ public_label: '차', capacity_total: 1 }]);
assert.strictEqual(vehiclesSmall.ok, false);
assert.ok(ruleCodes(vehiclesSmall.issues).includes('VEHICLE_CAPACITY_INVALID'));

// EDITABLE_SETTINGS_KEYS 화이트리스트에 커서/상태키가 없음을 확인
['LAST_SYNC_ROW_STUDENTS', 'PUBLISH_STATUS', 'LAST_PUBLISH_ID', 'ROSTER_MAX_ROWS', 'EVENT_ID'].forEach((k) => assert.ok(Core.EDITABLE_SETTINGS_KEYS.indexOf(k) < 0, k + '는 편집 불가여야 함'));

console.log('Core tests passed');
