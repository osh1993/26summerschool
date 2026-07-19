function publishPublicSnapshot() {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var data = readOperationalData_();
    var preIssues = validateAllForPublish_(data, null);
    if (CampCore.blockingIssues(preIssues).length) {
      replaceValidationIssues_(preIssues);
      SpreadsheetApp.getUi().alert('검증 오류로 게시하지 않았습니다. 이전 정상 스냅샷은 유지됩니다.');
      return;
    }
    var publishId = 'pub-' + Utilities.formatDate(new Date(), CAMP.TIMEZONE, 'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 6);
    var snapshot = buildPublicSnapshot_(data, publishId, preIssues);
    var issues = validateAllForPublish_(data, snapshot);
    replaceValidationIssues_(issues);
    if (CampCore.blockingIssues(issues).length) {
      SpreadsheetApp.getUi().alert('공개 JSON 검증 오류로 게시하지 않았습니다. 이전 정상 스냅샷은 유지됩니다.');
      return;
    }
    CampCore.runPublicationTransaction(snapshot, {
      stage: stagePublicSnapshot_,
      read: loadPublicSnapshotById_,
      switchPointer: function (id) {
        // Document Property의 단일 값 쓰기가 공개본 활성화의 유일한 포인터 전환이다.
        PropertiesService.getDocumentProperties().setProperty('ACTIVE_PUBLIC_PUBLISH_ID', id);
      }
    }, collectSensitiveCanaries_(data));
    // 아래 Settings 값은 운영자용 감사 정보이며 doGet 활성 포인터로 사용하지 않는다.
    try { setSetting_('LAST_PUBLISH_ID', publishId); setSetting_('PUBLISH_STATUS', 'published'); } catch (auditError) { /* 공개 포인터에는 영향 없음 */ }
    SpreadsheetApp.getUi().alert('공개 스냅샷 게시 완료: ' + publishId);
  } finally {
    lock.releaseLock();
  }
}

// 캠퍼스 코드 → 공개 표시 라벨. 알 수 없는 코드는 원문을 그대로 표시(민감정보 아님).
var PUBLIC_CAMPUS_LABELS = { imd: '임동', suwan: '수완', other: '기타' };
function publicCampusLabel_(code) {
  var key = String(code == null ? '' : code).trim();
  if (!key) return '';
  return PUBLIC_CAMPUS_LABELS[key] || key;
}

// 세션 정렬용 part 우선순위(오전<오후<밤).
var SESSION_PART_ORDER = { morning: 0, afternoon: 1, night: 2 };

// data.timeSlots(활성 행) → 공개 time_slots[] ({slot_id,label,day_index,part}).
function buildPublicTimeSlots_(data) {
  return (data.timeSlots || [])
    .filter(function (row) { return String(row.slot_id == null ? '' : row.slot_id).trim(); })
    .map(function (row) {
      return {
        slot_id: String(row.slot_id),
        label: String(row.label == null ? '' : row.label),
        day_index: CampCore.number(row.day_index, 0),
        part: String(row.part == null ? '' : row.part)
      };
    })
    .sort(function (a, b) {
      if (a.day_index !== b.day_index) return a.day_index - b.day_index;
      return (SESSION_PART_ORDER[a.part] == null ? 9 : SESSION_PART_ORDER[a.part]) - (SESSION_PART_ORDER[b.part] == null ? 9 : SESSION_PART_ORDER[b.part]);
    });
}

// 참가자 person_type을 방배정 표시용 enum(student/teacher/staff)으로 정규화한다. 알 수 없는 값은 student로 본다.
var ROOM_PERSON_TYPES = ['student', 'teacher', 'staff'];
function roomPersonType_(value) {
  var key = String(value == null ? '' : value).trim().toLowerCase();
  return ROOM_PERSON_TYPES.indexOf(key) >= 0 ? key : 'student';
}

// Rooms 탭 + Room_Assignments 조인으로 공개/내부 rooms[]를 조립한다.
// - 공개 뷰: public_name은 성 마스킹, 동의하지 않은 '학생'은 제외(교사/스탭은 방 대상이면 표시).
// - 내부 뷰(internal=true): 각 member에 full_name(legal_name) 추가, 동의 여부 무관 전원 포함.
// - occupancy는 실제 노출 members 수와 정확히 일치시킨다(검증기 PUBLIC_OCCUPANCY_MISMATCH 방지).
// - active=false 방은 공개/내부 모두에서 표시하지 않는다(창고 등 운영 전용 방 숨김).
function buildPublicRooms_(data, participants, internal) {
  var assignmentsByRoom = CampCore.groupBy(data.roomAssignments || [], 'room_id');
  return (data.rooms || []).filter(function (row) { return CampCore.bool(row.active); }).map(function (room) {
    var members = (assignmentsByRoom[String(room.room_id)] || []).map(function (assignment) {
      var person = participants[String(assignment.participant_id)];
      if (!person) return null;
      var personType = roomPersonType_(person.person_type);
      // 공개 뷰에만 동의 게이트를 적용하고, 대상은 학생으로 한정한다(교사/스탭은 person_type과 함께 표시).
      if (!internal && personType === 'student' && !CampCore.bool(person.public_consent)) return null;
      var member = {
        public_id: String(person.public_id),
        public_name: CampCore.maskSurname(person.legal_name),
        person_type: personType,
        campus: publicCampusLabel_(person.campus)
      };
      if (internal) member.full_name = String(person.legal_name == null ? '' : person.legal_name);
      return member;
    }).filter(function (member) { return member; });
    return {
      room_id: String(room.room_id),
      display_name: String(room.display_name),
      floor: String(room.floor == null ? '' : room.floor),
      gender_scope: String(room.gender_scope),
      capacity: CampCore.number(room.capacity, 0),
      occupancy: members.length,
      members: members
    };
  });
}

// person_type별 교사/스탭 디렉터리(내부 스냅샷 전용). 실명 포함이므로 공개 스냅샷에는 절대 넣지 않는다.
function buildPersonDirectory_(data, groupIdByParticipant, personType) {
  return (data.participants || [])
    .filter(function (p) { return String(p.person_type) === personType && CampCore.bool(p.active); })
    .map(function (p) {
      return {
        participant_id: String(p.participant_id),
        full_name: String(p.legal_name == null ? '' : p.legal_name),
        campus: publicCampusLabel_(p.campus),
        group_id: groupIdByParticipant[String(p.participant_id)] || null
      };
    });
}

// internal=true면 각 member에 full_name(legal_name)과 최상위 teachers[]/staff[], rooms[]·trips[] 탑승자의 full_name을 덧붙인 internal-snapshot/v3를 만든다.
function buildPublicSnapshot_(data, publishId, preIssues, internal) {
  var participants = CampCore.indexBy(data.participants, 'participant_id');
  var vehicles = CampCore.indexBy(data.vehicles, 'vehicle_id');
  var locations = CampCore.indexBy(data.locations, 'location_id');
  var assignmentsByGroup = CampCore.groupBy(data.groupAssignments, 'group_id');
  var attendanceRows = data.attendance || [];
  var groupIdByParticipant = {};
  (data.groupAssignments || []).forEach(function (a) { groupIdByParticipant[String(a.participant_id)] = String(a.group_id); });
  var passengersByTrip = CampCore.groupBy((data.tripPassengers || []).filter(function (row) {
    return ['cancelled', 'no_show'].indexOf(String(row.boarding_status)) < 0;
  }), 'trip_id');
  var updatedValues = [];
  (data.groupAssignments || []).concat(data.trips || []).concat(data.tripPassengers || []).forEach(function (row) { if (row.updated_at) updatedValues.push(dateToIso_(row.updated_at)); });
  updatedValues.sort();
  var generatedAt = nowIso_();
  var timeSlots = buildPublicTimeSlots_(data);
  // Phase 2: 최상위 rooms[](Rooms 탭 + Room_Assignments 조인). SCHEMA_VERSION이 v3/v2이므로 반드시 함께 조립해야 게시 검증을 통과한다.
  var rooms = buildPublicRooms_(data, participants, internal);
  var groups = (data.groups || []).filter(function (row) { return CampCore.bool(row.active); }).map(function (group) {
    return {
      group_id: String(group.group_id),
      display_name: String(group.display_name),
      color: group.color ? String(group.color) : undefined,
      // public_consent=false 참가자는 공개 명단에서만 제외한다(내부 뷰는 전원 포함). 표시명은 항상 성 마스킹으로 파생한다.
      members: (assignmentsByGroup[String(group.group_id)] || []).map(function (assignment) {
        var person = participants[String(assignment.participant_id)];
        if (!person) return null;
        // 공개 뷰에만 동의 게이트를 적용한다. 내부(인증) 뷰는 운영자·교사용이므로 비동의자도 전원 포함한다.
        if (!internal && !CampCore.bool(person.public_consent)) return null;
        var member = {
          public_id: String(person.public_id),
          public_name: CampCore.maskSurname(person.legal_name),
          role: String(assignment.role || 'member'),
          campus: publicCampusLabel_(person.campus),
          session_slots: CampCore.presentSlotIds(attendanceRows, person.participant_id)
        };
        if (internal) member.full_name = String(person.legal_name == null ? '' : person.legal_name);
        return member;
      }).filter(function (member) { return member; })
    };
  });
  var publicVehicles = (data.vehicles || []).filter(function (row) { return CampCore.bool(row.active); }).map(function (vehicle) {
    return { vehicle_id: String(vehicle.vehicle_id), label: String(vehicle.public_label), capacity: CampCore.number(vehicle.capacity_total, 0), accessibility: CampCore.bool(vehicle.accessible) };
  });
  var publicTrips = (data.trips || []).filter(function (trip) {
    return ['open', 'confirmed', 'departed', 'arrived', 'cancelled'].indexOf(String(trip.trip_status)) >= 0;
  }).map(function (trip) {
    var passengerRows = String(trip.trip_status) === 'cancelled' ? [] : (passengersByTrip[String(trip.trip_id)] || []);
    var publicPassengers = passengerRows.map(function (row) {
      var person = participants[String(row.participant_id)];
      var status = String(row.boarding_status || 'planned');
      if (status === 'no_show') status = 'cancelled';
      // Phase 3: 공개 탑승자 표시명은 항상 성 마스킹으로 파생한다(원본 public_name 사용 금지). 내부 뷰에만 full_name(실명) 추가.
      var passenger = { public_id: String(person.public_id), public_name: CampCore.maskSurname(person.legal_name), boarding_status: status };
      if (internal) passenger.full_name = String(person.legal_name == null ? '' : person.legal_name);
      return passenger;
    });
    var departIso = dateToIso_(trip.depart_at);
    var vehicle = vehicles[String(trip.vehicle_id)];
    var capacity = CampCore.number(vehicle.capacity_total, 0);
    return {
      trip_id: String(trip.trip_id),
      date: departIso.slice(0, 10),
      time: departIso.slice(11, 16),
      // Phase 3: 공개 표시용 시간 버킷(오전/오후/밤) 파생. 내부 정밀 ISO(depart_at)는 변경하지 않고 date/time과 병행 유지.
      time_bucket: CampCore.tripTimeBucket(departIso, CAMP.TIMEZONE),
      direction: String(trip.direction),
      origin: String(locations[String(trip.origin_location_id)].public_label),
      destination: String(locations[String(trip.destination_location_id)].public_label),
      meeting_point: String(locations[String(trip.meeting_location_id)].public_label),
      status: String(trip.trip_status),
      vehicle_id: String(trip.vehicle_id),
      driver_label: String(vehicle.public_label) + ' 담당',
      capacity: capacity,
      passenger_count: publicPassengers.length,
      remaining_seats: capacity - 1 - publicPassengers.length,
      passengers: publicPassengers,
      updated_at: dateToIso_(trip.updated_at || trip.depart_at)
    };
  });
  var unassignedBuckets = {};
  (data.travelDemands || []).filter(function (row) { return String(row.demand_status) === 'unassigned'; }).forEach(function (demand) {
    var departIso = dateToIso_(demand.earliest_depart_at);
    var key = departIso.slice(0, 16) + '|' + String(demand.direction);
    if (!unassignedBuckets[key]) unassignedBuckets[key] = { trip_window_id: departIso.slice(0, 16), direction: String(demand.direction), count: 0, reason_code: 'UNASSIGNED' };
    unassignedBuckets[key].count += 1;
  });
  var notices = (data.notices || []).filter(function (row) { return CampCore.bool(row.active); }).map(function (row) {
    var notice = { notice_id: String(row.notice_id), title: String(row.title), message: String(row.message), severity: String(row.severity || 'info') };
    if (row.starts_at) notice.starts_at = dateToIso_(row.starts_at);
    if (row.ends_at) notice.ends_at = dateToIso_(row.ends_at);
    return notice;
  });
  var publicWarnings = CampCore.aggregatePublicWarnings(preIssues || []);
  var warningCount = publicWarnings.reduce(function (sum, row) { return sum + row.count; }, 0);
  return removeUndefined_({
    schema_version: internal ? CAMP.INTERNAL_SCHEMA_VERSION : CAMP.SCHEMA_VERSION,
    event: {
      event_id: String(data.settings.EVENT_ID),
      name: String(data.settings.EVENT_NAME),
      starts_on: String(data.settings.EVENT_START_DATE),
      ends_on: String(data.settings.EVENT_END_DATE),
      timezone: CAMP.TIMEZONE
    },
    generated_at: generatedAt,
    updated_at: updatedValues.length ? updatedValues[updatedValues.length - 1] : generatedAt,
    publish_id: publishId,
    notices: notices,
    time_slots: timeSlots,
    rooms: rooms,
    groups: groups,
    vehicles: publicVehicles,
    trips: publicTrips,
    unassigned_summary: Object.keys(unassignedBuckets).sort().map(function (key) { return unassignedBuckets[key]; }),
    validation: { status: warningCount > 0 ? 'warning' : 'ok', blocking_error_count: 0, warning_count: warningCount, warnings: publicWarnings },
    teachers: internal ? buildPersonDirectory_(data, groupIdByParticipant, 'teacher') : undefined,
    staff: internal ? buildPersonDirectory_(data, groupIdByParticipant, 'staff') : undefined
  });
}

// 내부 스냅샷(internal-snapshot/v3)을 조립한다. 정적 파일로 저장하지 않고 doPost 응답으로만 반환한다.
function buildInternalSnapshot_(data) {
  var publishId = 'internal-' + Utilities.formatDate(new Date(), CAMP.TIMEZONE, 'yyyyMMdd-HHmmss');
  return buildPublicSnapshot_(data, publishId, [], true);
}

function removeUndefined_(value) {
  if (Array.isArray(value)) return value.map(removeUndefined_);
  if (value && typeof value === 'object') return Object.keys(value).reduce(function (result, key) {
    if (value[key] !== undefined) result[key] = removeUndefined_(value[key]);
    return result;
  }, {});
  return value;
}

function stagePublicSnapshot_(snapshot) {
  var sheet = getSheetRequired_(CAMP.SHEETS.PUBLIC_EXPORT);
  var json = JSON.stringify(snapshot);
  var encoded = Utilities.base64EncodeWebSafe(json, Utilities.Charset.UTF_8);
  var hash = sha256Hex_(json);
  var chunks = [];
  for (var index = 0; index < encoded.length; index += CAMP.PUBLIC_EXPORT_CHUNK_SIZE) chunks.push(encoded.slice(index, index + CAMP.PUBLIC_EXPORT_CHUNK_SIZE));
  var rows = chunks.map(function (chunk, chunkIndex) {
    return { publish_id: snapshot.publish_id, chunk_index: chunkIndex, chunk_count: chunks.length, sha256: hash, json_chunk: chunk, generated_at: snapshot.generated_at, active: false };
  });
  appendObjects_(CAMP.SHEETS.PUBLIC_EXPORT, rows);
}

function loadPublicSnapshotById_(publishId) {
  var rows = tableRows_(getSheetRequired_(CAMP.SHEETS.PUBLIC_EXPORT)).filter(function (row) { return String(row.publish_id) === String(publishId); });
  if (!rows.length) return null;
  rows.sort(function (a, b) { return Number(a.chunk_index) - Number(b.chunk_index); });
  var expectedCount = Number(rows[0].chunk_count);
  var expectedHash = String(rows[0].sha256);
  if (rows.length !== expectedCount || rows.some(function (row, index) {
    return Number(row.chunk_index) !== index || Number(row.chunk_count) !== expectedCount || String(row.sha256) !== expectedHash;
  })) throw new Error('staged snapshot chunks invalid');
  var encoded = rows.map(function (row) { return String(row.json_chunk); }).join('');
  var json = Utilities.newBlob(Utilities.base64DecodeWebSafe(encoded)).getDataAsString('UTF-8');
  if (sha256Hex_(json) !== expectedHash) throw new Error('staged snapshot hash mismatch');
  return JSON.parse(json);
}

function loadActivePublicSnapshot_() {
  var publishId = PropertiesService.getDocumentProperties().getProperty('ACTIVE_PUBLIC_PUBLISH_ID');
  return publishId ? loadPublicSnapshotById_(publishId) : null;
}

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8).map(function (byte) {
    var value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function doGet(e) {
  try {
    if (!e || !e.parameter || e.parameter.view !== 'public') return jsonResponse_({ error: 'not_found' });
    var snapshot = loadActivePublicSnapshot_();
    if (!snapshot) return jsonResponse_({ error: 'not_published' });
    return jsonResponse_(snapshot);
  } catch (error) {
    // 공개 응답에는 스택, 시트명, 셀 범위, 내부 ID를 포함하지 않는다.
    return jsonResponse_({ error: 'temporarily_unavailable' });
  }
}

// ── 웹 관리자 쓰기 인증 유틸(Phase A) ─────────────────────────────────
// 쓰기 토큰(issueAuthToken/verifyAuthToken)의 HMAC 서명은 Script Property CAMP_INTERNAL_TOKEN_SECRET을 주입해 계산한다.
// 미설정이면 verifyAuthToken이 bad_signature로 전부 거부하므로 쓰기가 안전 기본값(비활성)으로 잠긴다.
var INTERNAL_TOKEN_TTL_MS = 30 * 60 * 1000; // 발급 후 30분 유효(PII 노출창 축소). 만료 시 재로그인.

// 토큰 세대(무효화 스위치). Script Property CAMP_INTERNAL_TOKEN_VERSION을 바꾸면 이전 세대 토큰이 전부 즉시 거부된다.
// 미설정이면 '1'(Core.normalizeTokenVersion_ 기본과 동일)로 간주한다.
function internalTokenVersion_() {
  return PropertiesService.getScriptProperties().getProperty('CAMP_INTERNAL_TOKEN_VERSION') || '';
}

// Core.issueAuthToken/verifyAuthToken에 주입할 HMAC-SHA256 hex 래퍼(sha256Hex_ 바이트→hex 패턴과 동일).
function hmacHex_(secret, message) {
  var raw = Utilities.computeHmacSha256Signature(message, secret); // byte[]
  return raw.map(function (b) {
    var value = b < 0 ? b + 256 : b;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function internalTokenSecret_() {
  return PropertiesService.getScriptProperties().getProperty('CAMP_INTERNAL_TOKEN_SECRET') || '';
}

function isBlankSecret_(secret) {
  return !secret || String(secret).trim() === '';
}

// 쓰기 액션 공통 잠금 래퍼. 문서 잠금이 불가하면 스크립트 잠금으로 대체한다. 반환값을 JSON 응답으로 감싼다.
function withDocumentLock_(fn) {
  var lock;
  try { lock = LockService.getDocumentLock(); } catch (docLockError) { lock = null; }
  if (!lock) lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// 이슈(issue) 객체를 인증 운영자에게 돌려줄 안전한 형태로 축약한다(스택·시트·셀 없음, PII 없음).
function mapAdminIssue_(row) {
  return { code: row.rule_code, entity_type: row.entity_type, ref: row.entity_id, message: row.message_private };
}
function adminBlockingIssues_(issues) {
  return (issues || []).filter(function (row) { return row.blocking !== false; }).map(mapAdminIssue_);
}
function adminWarnings_(issues) {
  return (issues || []).filter(function (row) { return row.blocking === false; }).map(mapAdminIssue_);
}

// 로그인 브루트포스 경량 완화: 글로벌 실패 카운트를 CacheService로 10분 윈도우에 유지한다.
var LOGIN_FAIL_CACHE_KEY = 'camp_internal_login_fail';
var LOGIN_FAIL_MAX = 10;
var LOGIN_FAIL_WINDOW_SEC = 600;
function loginFailCache_() {
  try { return CacheService.getScriptCache(); } catch (cacheError) { return null; }
}
function isLoginThrottled_() {
  var cache = loginFailCache_();
  if (!cache) return false;
  return Number(cache.get(LOGIN_FAIL_CACHE_KEY) || 0) >= LOGIN_FAIL_MAX;
}
function registerLoginFailure_() {
  var cache = loginFailCache_();
  if (!cache) return;
  var count = Number(cache.get(LOGIN_FAIL_CACHE_KEY) || 0) + 1;
  cache.put(LOGIN_FAIL_CACHE_KEY, String(count), LOGIN_FAIL_WINDOW_SEC);
}
function resetLoginFailures_() {
  var cache = loginFailCache_();
  if (cache) cache.remove(LOGIN_FAIL_CACHE_KEY);
}

// 인증 내부 뷰 + 웹 관리자 쓰기 라우팅.
// - action 없음/'login': {user,password} 서버 검증 → 내부 스냅샷(+비밀키 있으면 쓰기 토큰) 반환.
// - 그 외 액션: 토큰 검증 후 구성 조회/저장. 비밀키 미설정이면 쓰기 액션은 writes_disabled로 거부.
// 성공해도 정적 파일로 저장하지 않는다. 실패/미설정/오류 시에는 힌트 없는 오류만 반환한다.
function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents) || {}; } catch (parseError) { body = {}; }
    }
    var action = String(body.action == null ? '' : body.action).trim() || 'login';
    var secret = internalTokenSecret_();

    if (action === 'login') return handleLogin_(body, secret);

    // 로그인 외 모든 액션은 쓰기/구성 조회 — 비밀키가 없으면 토큰을 발급한 적이 없으므로 쓰기 비활성.
    if (isBlankSecret_(secret)) return jsonResponse_({ error: 'writes_disabled' });
    // 토큰 검증: 만료·무효화(세대 변경)는 token_expired(재로그인 유도), 변조/누락/빈서명은 unauthorized(힌트 없는 코드).
    var verdict = CampCore.verifyAuthToken(body.token, Date.now(), secret, hmacHex_, internalTokenVersion_());
    if (!verdict.ok) return jsonResponse_({ error: (verdict.reason === 'expired' || verdict.reason === 'revoked') ? 'token_expired' : 'unauthorized' });

    switch (action) {
      case 'get_config': return handleGetConfig_();
      case 'save_settings': return withDocumentLock_(function () { return handleSaveSettings_(body); });
      case 'save_field_map': return withDocumentLock_(function () { return handleSaveFieldMap_(body); });
      case 'save_groups': return withDocumentLock_(function () { return handleSaveGroups_(body); });
      case 'save_rooms': return withDocumentLock_(function () { return handleSaveRooms_(body); });
      case 'save_vehicles': return withDocumentLock_(function () { return handleSaveVehicles_(body); });
      // ── 참석자 CRUD(Phase B): 실명·연락처(PII)를 인증 관리자에게만 노출/편집한다. 정적 저장 금지. ──
      case 'get_participants': return handleGetParticipants_();
      case 'save_participant': return withDocumentLock_(function () { return handleSaveParticipant_(body, verdict.user); });
      case 'deactivate_participant': return withDocumentLock_(function () { return handleDeactivateParticipant_(body, verdict.user); });
      // ── 배정 편집(Phase C): 참가자를 조/방/차량(운행)에 배정·이동·해제한다. 저장 시 Core 검증으로 위반을 차단한다. ──
      // get_assignments는 Participant_Private를 읽지 않는다(phone/birth 등 민감필드 미포함, legal_name까지만).
      case 'get_assignments': return handleGetAssignments_();
      case 'save_group_assignment': return withDocumentLock_(function () { return handleSaveGroupAssignment_(body, verdict.user); });
      case 'save_room_assignment': return withDocumentLock_(function () { return handleSaveRoomAssignment_(body, verdict.user); });
      case 'save_trip_passenger': return withDocumentLock_(function () { return handleSaveTripPassenger_(body, verdict.user); });
      case 'ensure_group_count': return runMenuMutation_(ensureGroupCountFromSettings);
      case 'ensure_room_count': return runMenuMutation_(ensureRoomCountFromSettings);
      default: return jsonResponse_({ error: 'not_found' });
    }
  } catch (error) {
    // 응답 오류에도 스택, 시트명, 셀 범위, 내부 ID를 포함하지 않는다.
    return jsonResponse_({ error: 'temporarily_unavailable' });
  }
}

// ensure*CountFromSettings는 스스로 문서 잠금을 잡고 마지막에 SpreadsheetApp.getUi().alert()를 호출한다.
// 웹앱(doPost) 컨텍스트에는 UI가 없어 alert 지점에서 예외가 나지만, 행 개수 조정은 그 이전에 이미 커밋된다.
// 따라서 getUi 관련 예외만 성공으로 간주하고, 그 외 예외는 그대로 전파해 temporarily_unavailable이 되게 한다.
function runMenuMutation_(fn) {
  try {
    fn();
    return jsonResponse_({ ok: true });
  } catch (err) {
    var msg = String(err && err.message ? err.message : err);
    if (/getUi/i.test(msg)) return jsonResponse_({ ok: true });
    throw err;
  }
}

function handleLogin_(body, secret) {
  var props = PropertiesService.getScriptProperties();
  var storedUser = props.getProperty('CAMP_INTERNAL_USER');
  var storedPwHash = props.getProperty('CAMP_INTERNAL_PW_HASH');
  // 연속 실패가 임계치를 넘으면 잠시 거부한다(정답이어도 거부되지만 윈도우가 짧다). 힌트는 남기지 않는다.
  if (isLoginThrottled_()) return jsonResponse_({ error: 'unauthorized' });
  // Script Property 미설정이면 verifyInternalCredential이 false를 반환하므로 자연히 unauthorized가 된다.
  var authorized = CampCore.verifyInternalCredential(body.user, body.password, storedUser, storedPwHash, sha256Hex_);
  if (!authorized) {
    registerLoginFailure_();
    return jsonResponse_({ error: 'unauthorized' });
  }
  resetLoginFailures_();
  var data = readOperationalData_();
  var snapshot = buildInternalSnapshot_(data);
  // 내부 스냅샷 구조를 점검하되, 개인 민감 원문(전화/생년월일 등)만 유출 카나리로 검사한다(실명·내부ID는 내부뷰 정상 노출).
  var structural = CampCore.validateInternalSnapshot(snapshot, collectPrivateCanaries_(data));
  if (CampCore.blockingIssues(structural).length) return jsonResponse_({ error: 'temporarily_unavailable' });
  // 비밀키가 있으면 만료 쓰기 토큰(TTL=INTERNAL_TOKEN_TTL_MS, 현재 30분)을 함께 반환한다(구조 검증 이후에 붙여 검증 대상에서 제외).
  if (!isBlankSecret_(secret)) {
    snapshot.token = CampCore.issueAuthToken(String(body.user == null ? '' : body.user).trim(), Date.now(), INTERNAL_TOKEN_TTL_MS, secret, hmacHex_, internalTokenVersion_());
  }
  return jsonResponse_(snapshot);
}

// 시트 헤더 1행만 읽어 배열로 반환(원본 응답 탭의 질문 헤더 노출용, 값·개인정보 없음). 시트가 없으면 빈 배열.
function readSheetHeaderRow_(sheetName) {
  var name = String(sheetName == null ? '' : sheetName).trim();
  if (!name) return [];
  var sheet = campSpreadsheet_().getSheetByName(name);
  if (!sheet || sheet.getLastColumn() < 1) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
    .map(function (h) { return String(h == null ? '' : h).trim(); })
    .filter(function (h) { return h !== ''; });
}

// 특정 참조 시트의 key 열에 등장하는 id 집합(배정 보존 판정용).
function referencedIdSet_(sheetName, key) {
  var set = {};
  tableRows_(getSheetRequired_(sheetName)).forEach(function (row) {
    var value = String(row[key] == null ? '' : row[key]).trim();
    if (value) set[value] = true;
  });
  return set;
}

// 여러 참조 시트를 합쳐 id 집합을 만든다.
function referencedIdSetMulti_(refs) {
  var set = {};
  refs.forEach(function (ref) {
    var one = referencedIdSet_(ref.sheet, ref.key);
    Object.keys(one).forEach(function (id) { set[id] = true; });
  });
  return set;
}

function handleGetConfig_() {
  var settingsAll = getSettings_();
  var settings = {};
  EDITABLE_SETTINGS_KEYS.forEach(function (key) {
    settings[key] = settingsAll[key] == null ? '' : String(settingsAll[key]);
  });

  var fieldMap = tableRows_(getSheetRequired_(CAMP.SHEETS.FIELD_MAP)).map(function (row) {
    return {
      source_sheet: String(row.source_sheet == null ? '' : row.source_sheet),
      source_header: String(row.source_header == null ? '' : row.source_header),
      normalized_field: String(row.normalized_field == null ? '' : row.normalized_field),
      required: CampCore.bool(row.required),
      active: CampCore.bool(row.active)
    };
  });

  var groupRefs = referencedIdSet_(CAMP.SHEETS.GROUP_ASSIGNMENTS, 'group_id');
  var groups = tableRows_(getSheetRequired_(CAMP.SHEETS.GROUPS)).map(function (row) {
    var id = String(row.group_id == null ? '' : row.group_id);
    return {
      group_id: id,
      display_name: String(row.display_name == null ? '' : row.display_name),
      color: String(row.color == null ? '' : row.color),
      target_size: numOrBlank_(row.target_size),
      min_size: numOrBlank_(row.min_size),
      max_size: numOrBlank_(row.max_size),
      active: CampCore.bool(row.active),
      has_assignments: !!groupRefs[id]
    };
  });

  var roomRefs = referencedIdSet_(CAMP.SHEETS.ROOM_ASSIGNMENTS, 'room_id');
  var rooms = tableRows_(getSheetRequired_(CAMP.SHEETS.ROOMS)).map(function (row) {
    var id = String(row.room_id == null ? '' : row.room_id);
    return {
      room_id: id,
      display_name: String(row.display_name == null ? '' : row.display_name),
      capacity: numOrBlank_(row.capacity),
      gender_scope: String(row.gender_scope == null ? '' : row.gender_scope),
      floor: String(row.floor == null ? '' : row.floor),
      active: CampCore.bool(row.active),
      has_assignments: !!roomRefs[id]
    };
  });

  var vehicleRefs = referencedIdSetMulti_([
    { sheet: CAMP.SHEETS.TRIPS, key: 'vehicle_id' },
    { sheet: CAMP.SHEETS.VEHICLE_AVAILABILITY, key: 'vehicle_id' }
  ]);
  var vehicles = tableRows_(getSheetRequired_(CAMP.SHEETS.VEHICLES)).map(function (row) {
    var id = String(row.vehicle_id == null ? '' : row.vehicle_id);
    return {
      vehicle_id: id,
      public_label: String(row.public_label == null ? '' : row.public_label),
      capacity_total: numOrBlank_(row.capacity_total),
      accessible: CampCore.bool(row.accessible),
      active: CampCore.bool(row.active),
      has_assignments: !!vehicleRefs[id]
    };
  });

  var lookups = tableRows_(getSheetRequired_(CAMP.SHEETS.LOOKUPS)).map(function (row) {
    return {
      category: String(row.category == null ? '' : row.category),
      value: String(row.value == null ? '' : row.value),
      label: String(row.label == null ? '' : row.label),
      active: CampCore.bool(row.active)
    };
  });

  return jsonResponse_({
    ok: true,
    settings: settings,
    field_map: fieldMap,
    groups: groups,
    rooms: rooms,
    vehicles: vehicles,
    lookups: lookups,
    form_headers: {
      students: readSheetHeaderRow_(settingsAll.RAW_STUDENT_SHEET || CAMP.SHEETS.RAW_STUDENTS),
      staff: readSheetHeaderRow_(settingsAll.RAW_STAFF_SHEET || CAMP.SHEETS.RAW_STAFF)
    }
  });
}

// 숫자 값이면 문자열로, 비었으면 ''로 정규화(폼 편집용).
function numOrBlank_(value) {
  if (value == null || String(value).trim() === '') return '';
  var n = Number(value);
  return Number.isFinite(n) ? String(n) : String(value).trim();
}

function handleSaveSettings_(body) {
  var result = CampCore.validateSettingsInput(body.payload);
  if (!result.ok) return jsonResponse_({ error: 'invalid_input', issues: adminBlockingIssues_(result.issues) });
  Object.keys(result.sanitized).forEach(function (key) { setSetting_(key, result.sanitized[key]); });
  return jsonResponse_({ ok: true, warnings: adminWarnings_(result.issues) });
}

function clearDataRows_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
}

// 유효 rows 가드: payload가 배열이 아니거나 비었으면 시트를 건드리지 않는다.
// (빈/누락 payload로 전면 삭제·전면 비활성화되는 대량 소실 방지 — 정상 목록은 최소 1행 존재)
function hasRows_(payload) {
  return Array.isArray(payload) && payload.length > 0;
}

function handleSaveFieldMap_(body) {
  // 인증·잠금 통과 이후, 시트 변경(clear/append) 이전 가드.
  if (!hasRows_(body.payload)) return jsonResponse_({ error: 'invalid_input' });
  var result = CampCore.validateFieldMapInput(body.payload);
  if (!result.ok) return jsonResponse_({ error: 'invalid_input', issues: adminBlockingIssues_(result.issues) });
  // 매핑은 외부(배정) 참조가 없어 전체 교체가 안전하다.
  var sheet = getSheetRequired_(CAMP.SHEETS.FIELD_MAP);
  clearDataRows_(sheet);
  appendObjects_(CAMP.SHEETS.FIELD_MAP, result.sanitized.map(function (row) {
    return {
      source_sheet: row.source_sheet,
      source_header: row.source_header,
      normalized_field: row.normalized_field,
      required: row.required,
      active: row.active
    };
  }));
  return jsonResponse_({ ok: true, warnings: adminWarnings_(result.issues) });
}

// idx[field] 열이 있으면 해당 셀만 수정한다(운영자 추가 열·미관리 필드는 건드리지 않음).
function setCellIf_(sheet, rowNumber, idx, field, value) {
  if (idx[field] == null) return;
  sheet.getRange(rowNumber, idx[field] + 1).setValue(value == null ? '' : value);
}

function handleSaveGroups_(body) {
  // 빈/누락 payload는 시트를 건드리지 않는다(전체 비활성화 방지). 정상 조 목록은 최소 1행 존재.
  if (!hasRows_(body.payload)) return jsonResponse_({ error: 'invalid_input' });
  var result = CampCore.validateGroupsInput(body.payload);
  if (!result.ok) return jsonResponse_({ error: 'invalid_input', issues: adminBlockingIssues_(result.issues) });
  var sheet = getSheetRequired_(CAMP.SHEETS.GROUPS);
  var idx = headerIndex_(sheet);
  var existing = tableRows_(sheet);
  var byId = indexRowsById_(existing, 'group_id');
  var refs = referencedIdSet_(CAMP.SHEETS.GROUP_ASSIGNMENTS, 'group_id');
  var eventId = (getSettings_().EVENT_ID) || CAMP.DEFAULT_SETTINGS.EVENT_ID;
  var warnings = [];
  var seen = {};
  var newObjects = [];

  result.sanitized.forEach(function (clean) {
    var id = (!isBlankValue_(clean.group_id) && byId[String(clean.group_id)]) ? String(clean.group_id) : '';
    if (id) {
      seen[id] = true;
      var row = byId[id];
      var wantActive = clean.active;
      if (!wantActive && refs[id]) { wantActive = true; warnings.push({ code: 'GROUP_HAS_ASSIGNMENTS', entity_type: 'group', ref: id, message: '배정이 있어 비활성화하지 않았습니다.' }); }
      setCellIf_(sheet, row._row, idx, 'display_name', clean.display_name);
      setCellIf_(sheet, row._row, idx, 'color', clean.color == null ? '' : clean.color);
      setCellIf_(sheet, row._row, idx, 'target_size', clean.target_size == null ? '' : clean.target_size);
      setCellIf_(sheet, row._row, idx, 'min_size', clean.min_size == null ? '' : clean.min_size);
      setCellIf_(sheet, row._row, idx, 'max_size', clean.max_size == null ? '' : clean.max_size);
      setCellIf_(sheet, row._row, idx, 'active', wantActive);
    } else {
      // 신규: 충돌 없는 새 id를 발급한 뒤 사용자 값을 병합한다(id 재발급 금지 대상은 기존 행뿐).
      var template = buildNewGroupRows_(existing.concat(newObjects), 1, eventId)[0];
      seen[template.group_id] = true;
      newObjects.push({
        group_id: template.group_id,
        event_id: eventId,
        display_name: clean.display_name,
        color: clean.color == null ? template.color : clean.color,
        target_size: clean.target_size == null ? '' : clean.target_size,
        min_size: clean.min_size == null ? '' : clean.min_size,
        max_size: clean.max_size == null ? '' : clean.max_size,
        active: clean.active
      });
    }
  });

  deactivateMissingRows_(sheet, idx, existing, 'group_id', seen, refs, warnings, 'GROUP_HAS_ASSIGNMENTS', 'group');
  if (newObjects.length) appendObjects_(CAMP.SHEETS.GROUPS, newObjects);
  return jsonResponse_({ ok: true, warnings: warnings.concat(adminWarnings_(result.issues)) });
}

function handleSaveRooms_(body) {
  // 빈/누락 payload는 시트를 건드리지 않는다(전체 비활성화 방지). 정상 방 목록은 최소 1행 존재.
  if (!hasRows_(body.payload)) return jsonResponse_({ error: 'invalid_input' });
  var result = CampCore.validateRoomsInput(body.payload);
  if (!result.ok) return jsonResponse_({ error: 'invalid_input', issues: adminBlockingIssues_(result.issues) });
  var sheet = getSheetRequired_(CAMP.SHEETS.ROOMS);
  var idx = headerIndex_(sheet);
  var existing = tableRows_(sheet);
  var byId = indexRowsById_(existing, 'room_id');
  var refs = referencedIdSet_(CAMP.SHEETS.ROOM_ASSIGNMENTS, 'room_id');
  var eventId = (getSettings_().EVENT_ID) || CAMP.DEFAULT_SETTINGS.EVENT_ID;
  var warnings = [];
  var seen = {};
  var newObjects = [];

  result.sanitized.forEach(function (clean) {
    var id = (!isBlankValue_(clean.room_id) && byId[String(clean.room_id)]) ? String(clean.room_id) : '';
    if (id) {
      seen[id] = true;
      var row = byId[id];
      var wantActive = clean.active;
      if (!wantActive && refs[id]) { wantActive = true; warnings.push({ code: 'ROOM_HAS_ASSIGNMENTS', entity_type: 'room', ref: id, message: '배정이 있어 비활성화하지 않았습니다.' }); }
      setCellIf_(sheet, row._row, idx, 'display_name', clean.display_name);
      setCellIf_(sheet, row._row, idx, 'capacity', clean.capacity);
      setCellIf_(sheet, row._row, idx, 'gender_scope', clean.gender_scope);
      setCellIf_(sheet, row._row, idx, 'floor', clean.floor == null ? '' : clean.floor);
      setCellIf_(sheet, row._row, idx, 'active', wantActive);
    } else {
      var template = buildNewRoomRows_(existing.concat(newObjects), 1, eventId)[0];
      seen[template.room_id] = true;
      newObjects.push({
        room_id: template.room_id,
        event_id: eventId,
        display_name: clean.display_name,
        capacity: clean.capacity,
        floor: clean.floor == null ? '' : clean.floor,
        gender_scope: clean.gender_scope,
        active: clean.active,
        private_note: ''
      });
    }
  });

  deactivateMissingRows_(sheet, idx, existing, 'room_id', seen, refs, warnings, 'ROOM_HAS_ASSIGNMENTS', 'room');
  if (newObjects.length) appendObjects_(CAMP.SHEETS.ROOMS, newObjects);
  return jsonResponse_({ ok: true, warnings: warnings.concat(adminWarnings_(result.issues)) });
}

function handleSaveVehicles_(body) {
  // 빈/누락 payload는 시트를 건드리지 않는다(전체 비활성화 방지). 정상 차량 목록은 최소 1행 존재.
  if (!hasRows_(body.payload)) return jsonResponse_({ error: 'invalid_input' });
  var result = CampCore.validateVehiclesInput(body.payload);
  if (!result.ok) return jsonResponse_({ error: 'invalid_input', issues: adminBlockingIssues_(result.issues) });
  var sheet = getSheetRequired_(CAMP.SHEETS.VEHICLES);
  var idx = headerIndex_(sheet);
  var existing = tableRows_(sheet);
  var byId = indexRowsById_(existing, 'vehicle_id');
  var refs = referencedIdSetMulti_([
    { sheet: CAMP.SHEETS.TRIPS, key: 'vehicle_id' },
    { sheet: CAMP.SHEETS.VEHICLE_AVAILABILITY, key: 'vehicle_id' }
  ]);
  var eventId = (getSettings_().EVENT_ID) || CAMP.DEFAULT_SETTINGS.EVENT_ID;
  var warnings = [];
  var seen = {};
  var newObjects = [];

  result.sanitized.forEach(function (clean) {
    var id = (!isBlankValue_(clean.vehicle_id) && byId[String(clean.vehicle_id)]) ? String(clean.vehicle_id) : '';
    if (id) {
      seen[id] = true;
      var row = byId[id];
      var wantActive = clean.active;
      if (!wantActive && refs[id]) { wantActive = true; warnings.push({ code: 'VEHICLE_HAS_ASSIGNMENTS', entity_type: 'vehicle', ref: id, message: '배정이 있어 비활성화하지 않았습니다.' }); }
      setCellIf_(sheet, row._row, idx, 'public_label', clean.public_label);
      setCellIf_(sheet, row._row, idx, 'capacity_total', clean.capacity_total);
      setCellIf_(sheet, row._row, idx, 'accessible', clean.accessible);
      setCellIf_(sheet, row._row, idx, 'active', wantActive);
    } else {
      var template = buildNewVehicleRows_(existing.concat(newObjects), 1, eventId)[0];
      seen[template.vehicle_id] = true;
      newObjects.push({
        vehicle_id: template.vehicle_id,
        event_id: eventId,
        internal_label: '',
        public_label: clean.public_label,
        capacity_total: clean.capacity_total,
        accessible: clean.accessible,
        route_scope: '',
        active: clean.active,
        private_note: ''
      });
    }
  });

  deactivateMissingRows_(sheet, idx, existing, 'vehicle_id', seen, refs, warnings, 'VEHICLE_HAS_ASSIGNMENTS', 'vehicle');
  if (newObjects.length) appendObjects_(CAMP.SHEETS.VEHICLES, newObjects);
  return jsonResponse_({ ok: true, warnings: warnings.concat(adminWarnings_(result.issues)) });
}

// 기존 행을 id로 색인(빈 id는 제외). 첫 등장 행만 보존(중복 id 방어).
function indexRowsById_(rows, idField) {
  var map = {};
  rows.forEach(function (row) {
    var id = String(row[idField] == null ? '' : row[idField]).trim();
    if (id && !map[id]) map[id] = row;
  });
  return map;
}

// payload에서 빠진 기존 행: 배정 참조가 있으면 보존+경고, 없으면 active=false(물리 삭제·id 재발급 없음).
function deactivateMissingRows_(sheet, idx, existing, idField, seen, refs, warnings, warnCode, entityType) {
  existing.forEach(function (row) {
    var id = String(row[idField] == null ? '' : row[idField]).trim();
    if (!id || seen[id]) return;
    if (refs[id]) {
      warnings.push({ code: warnCode, entity_type: entityType, ref: id, message: '목록에서 빠졌지만 배정이 있어 보존했습니다.' });
    } else if (CampCore.bool(row.active) && idx.active != null) {
      sheet.getRange(row._row, idx.active + 1).setValue(false);
    }
  });
}

// 기존 차량 번호와 겹치지 않는 신규 차량 행을 생성한다. 기본 공개표시명은 'N호차', 정원은 사용자가 채운다.
function buildNewVehicleRows_(existingRows, count, eventId) {
  var maxNumber = 0;
  existingRows.forEach(function (row) {
    var match = String(row.vehicle_id || '').match(/(\d+)/);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
    var labelMatch = String(row.public_label || '').match(/(\d+)/);
    if (labelMatch) maxNumber = Math.max(maxNumber, Number(labelMatch[1]));
  });
  var rows = [];
  for (var i = 1; i <= count; i += 1) {
    var n = maxNumber + i;
    rows.push({
      vehicle_id: 'V' + String(n).padStart(2, '0'),
      event_id: eventId,
      internal_label: '',
      public_label: n + '호차',
      capacity_total: '',
      accessible: false,
      route_scope: '',
      active: true,
      private_note: ''
    });
  }
  return rows;
}

// ── 참석자 CRUD(Phase B) 웹 핸들러 ─────────────────────────────────
// PII(실명·전화·생년월일·보호자연락처·보험·비공개메모)를 인증 관리자에게만 노출/편집한다.
// 순수 검증·감사행 계획은 Core.js(validateParticipantInput/buildParticipantChangeRows)가, id 보존·발급·시트 upsert는 여기서 담당한다.

// 웹 편집이 가능한 공개모델 필드(Core.PARTICIPANT_PUBLIC_FIELDS와 동일 집합).
// participant_id/public_id/source_response_id는 여기에 없어 절대 덮어쓰지 않는다(id 불변).
var PARTICIPANT_WRITABLE_FIELDS = ['person_type', 'legal_name', 'public_name', 'public_consent', 'campus', 'grade_band', 'gender', 'engagement_score', 'extraversion_score', 'newcomer', 'leader_candidate'];

// Participant_Private 민감필드(라우팅·조회 대상). Change_Log에는 [REDACTED]로만 남는다.
var PARTICIPANT_PRIVATE_FIELDS = ['birth_date', 'phone', 'guardian_phone', 'insurance_status', 'private_note'];

// Change_Log 감사행에 change_id(UUID)·changed_at(now)를 발급해 시트 스키마에 맞춘다(빌더는 이 두 컬럼을 넣지 않는다).
function stampChangeRows_(rows) {
  return (rows || []).map(function (row) {
    return {
      change_id: 'chg_' + Utilities.getUuid().replace(/-/g, ''),
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      field_name: row.field_name,
      old_value: row.old_value,
      new_value: row.new_value,
      changed_at: nowIso_(),
      changed_by: row.changed_by,
      reason: row.reason
    };
  });
}

// 참석자 목록(편집용) 반환: 공개모델 + legal_name + active, 그리고 민감필드는 private 맵으로 분리.
// PII 포함 — 토큰 인증자 전용이며 정적 파일로 저장하지 않는다.
function handleGetParticipants_() {
  var participantRows = tableRows_(getSheetRequired_(CAMP.SHEETS.PARTICIPANTS));
  var privateRows = tableRows_(getSheetRequired_(CAMP.SHEETS.PRIVATE));

  var privateById = {};
  privateRows.forEach(function (row) {
    var id = String(row.participant_id == null ? '' : row.participant_id).trim();
    if (!id) return;
    var entry = {};
    PARTICIPANT_PRIVATE_FIELDS.forEach(function (field) {
      entry[field] = String(row[field] == null ? '' : row[field]);
    });
    privateById[id] = entry;
  });

  var participants = [];
  var privateMap = {};
  participantRows.forEach(function (row) {
    var id = String(row.participant_id == null ? '' : row.participant_id).trim();
    if (!id) return;
    participants.push({
      participant_id: id,
      public_id: String(row.public_id == null ? '' : row.public_id),
      person_type: String(row.person_type == null ? '' : row.person_type),
      legal_name: String(row.legal_name == null ? '' : row.legal_name),
      public_name: String(row.public_name == null ? '' : row.public_name),
      public_consent: CampCore.bool(row.public_consent),
      campus: String(row.campus == null ? '' : row.campus),
      grade_band: String(row.grade_band == null ? '' : row.grade_band),
      gender: String(row.gender == null ? '' : row.gender),
      engagement_score: numOrBlank_(row.engagement_score),
      extraversion_score: numOrBlank_(row.extraversion_score),
      newcomer: CampCore.bool(row.newcomer),
      leader_candidate: CampCore.bool(row.leader_candidate),
      active: CampCore.bool(row.active)
    });
    // 민감필드는 존재하는 참석자에 한해서만 노출한다(고아 private 행 미노출).
    privateMap[id] = privateById[id] || { birth_date: '', phone: '', guardian_phone: '', insurance_status: '', private_note: '' };
  });

  return jsonResponse_({ ok: true, participants: participants, private: privateMap });
}

// 참석자 신규/수정(upsert). participant_id가 기존 행에 있으면 in-place 수정(id 불변), 없으면 신규 발급.
function handleSaveParticipant_(body, changedBy) {
  var payload = body.payload;
  // 빈 payload 가드(Phase A F1 패턴): participant 객체가 없으면 시트를 건드리지 않는다.
  if (!payload || typeof payload !== 'object' || !payload.participant || typeof payload.participant !== 'object') {
    return jsonResponse_({ error: 'invalid_input' });
  }
  var inputPrivate = (payload.private && typeof payload.private === 'object') ? payload.private : {};

  // (a) 순수 검증: enum·점수·PII 누수 차단. 실패면 시트 변경 없이 중단.
  var result = CampCore.validateParticipantInput(payload.participant, inputPrivate);
  if (!result.ok) return jsonResponse_({ error: 'invalid_input', issues: adminBlockingIssues_(result.issues) });
  var sanitized = result.sanitizedParticipant;
  var sanitizedPrivate = result.sanitizedPrivate;

  var participantSheet = getSheetRequired_(CAMP.SHEETS.PARTICIPANTS);
  var privateSheet = getSheetRequired_(CAMP.SHEETS.PRIVATE);
  var participantIdx = headerIndex_(participantSheet);
  var privateIdx = headerIndex_(privateSheet);
  var existingParticipants = tableRows_(participantSheet);
  var byId = indexRowsById_(existingParticipants, 'participant_id');
  var privById = indexRowsById_(tableRows_(privateSheet), 'participant_id');

  // 편집 payload의 participant_id는 기존 행에 존재할 때만 수정 대상으로 신뢰한다(id 재발급·주입 방지).
  var requestedId = String(payload.participant.participant_id == null ? '' : payload.participant.participant_id).trim();
  var existingRow = (requestedId && byId[requestedId]) ? byId[requestedId] : null;

  var participantId;
  var changeRows;

  if (existingRow) {
    // (수정) 기존 행의 id를 신뢰한다. participant_id/public_id/source_response_id는 절대 쓰지 않는다.
    participantId = String(existingRow.participant_id);
    var oldPrivateRow = privById[participantId] || {};

    PARTICIPANT_WRITABLE_FIELDS.forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(sanitized, field)) {
        setCellIf_(participantSheet, existingRow._row, participantIdx, field, sanitized[field]);
      }
    });
    if (participantIdx.updated_at != null) participantSheet.getRange(existingRow._row, participantIdx.updated_at + 1).setValue(nowIso_());

    var privateFields = Object.keys(sanitizedPrivate);
    if (privateFields.length) {
      if (privById[participantId]) {
        privateFields.forEach(function (field) { setCellIf_(privateSheet, privById[participantId]._row, privateIdx, field, sanitizedPrivate[field]); });
      } else {
        var newPriv = { participant_id: participantId };
        privateFields.forEach(function (field) { newPriv[field] = sanitizedPrivate[field]; });
        appendObjects_(CAMP.SHEETS.PRIVATE, [newPriv]);
      }
    }

    changeRows = CampCore.buildParticipantChangeRows(existingRow, sanitized, oldPrivateRow, sanitizedPrivate, participantId, changedBy);
  } else {
    // (신규) pt_+UUID / generatePublicId_. public_consent 기본 false·public_name 기본 ''는 sanitized에 이미 정규화되어 있다.
    participantId = 'pt_' + Utilities.getUuid().replace(/-/g, '');
    var publicIds = existingParticipants.reduce(function (map, row) { if (row.public_id) map[String(row.public_id)] = true; return map; }, {});
    var publicId = generatePublicId_(publicIds);
    var eventId = (getSettings_().EVENT_ID) || CAMP.DEFAULT_SETTINGS.EVENT_ID;

    appendObjects_(CAMP.SHEETS.PARTICIPANTS, [{
      participant_id: participantId,
      event_id: eventId,
      person_type: sanitized.person_type == null ? 'student' : sanitized.person_type,
      legal_name: sanitized.legal_name == null ? '' : sanitized.legal_name,
      public_id: publicId,
      public_name: sanitized.public_name == null ? '' : sanitized.public_name,
      public_consent: sanitized.public_consent,
      campus: sanitized.campus == null ? '' : sanitized.campus,
      grade_band: sanitized.grade_band == null ? '' : sanitized.grade_band,
      gender: sanitized.gender == null ? '' : sanitized.gender,
      engagement_score: sanitized.engagement_score,
      newcomer: sanitized.newcomer,
      leader_candidate: sanitized.leader_candidate,
      active: true,
      source_response_id: '',
      updated_at: nowIso_(),
      extraversion_score: sanitized.extraversion_score
    }]);

    var newPrivateRow = { participant_id: participantId };
    Object.keys(sanitizedPrivate).forEach(function (field) { newPrivateRow[field] = sanitizedPrivate[field]; });
    appendObjects_(CAMP.SHEETS.PRIVATE, [newPrivateRow]);

    changeRows = CampCore.buildParticipantChangeRows({}, sanitized, {}, sanitizedPrivate, participantId, changedBy);
  }

  var changeLog = stampChangeRows_(changeRows);
  if (changeLog.length) appendObjects_(CAMP.SHEETS.CHANGE_LOG, changeLog);
  return jsonResponse_({ ok: true, participant_id: participantId, warnings: adminWarnings_(result.issues) });
}

// 참석자 비활성(삭제 금지). active=false만 setValue하고 배정은 건드리지 않는다. Change_Log에 감사 기록.
function handleDeactivateParticipant_(body, changedBy) {
  var payload = body.payload;
  var participantId = String((payload && payload.participant_id) == null ? '' : payload.participant_id).trim();
  if (!participantId) return jsonResponse_({ error: 'invalid_input' });

  var participantSheet = getSheetRequired_(CAMP.SHEETS.PARTICIPANTS);
  var idx = headerIndex_(participantSheet);
  var row = indexRowsById_(tableRows_(participantSheet), 'participant_id')[participantId];
  if (!row) return jsonResponse_({ error: 'invalid_input' });
  if (idx.active == null) return jsonResponse_({ error: 'temporarily_unavailable' });

  var wasActive = CampCore.bool(row.active);
  participantSheet.getRange(row._row, idx.active + 1).setValue(false);
  if (idx.updated_at != null) participantSheet.getRange(row._row, idx.updated_at + 1).setValue(nowIso_());

  // active는 공개필드 집합(PARTICIPANT_PUBLIC_FIELDS)에 없어 빌더가 기록하지 않으므로 여기서 직접 감사행을 남긴다.
  if (wasActive) {
    appendObjects_(CAMP.SHEETS.CHANGE_LOG, stampChangeRows_([{
      entity_type: 'participant',
      entity_id: participantId,
      field_name: 'active',
      old_value: 'TRUE',
      new_value: 'FALSE',
      changed_by: changedBy == null ? '' : String(changedBy),
      reason: 'admin_web'
    }]));
  }
  return jsonResponse_({ ok: true, participant_id: participantId });
}

// ── 배정 편집(Phase C) 웹 핸들러 ─────────────────────────────────
// 참가자를 조/방/차량(운행)에 배정·이동·해제한다. 순수 검증·plan·감사행은 Core.js가,
// 시트 upsert/remove·id 발급·Change_Log 스탬프는 여기서 담당한다. get_assignments는 PII(전화·생년월일 등)를 절대 반환하지 않는다.

// 배정 편집 화면용 참가자 공개모델(민감필드 없음). Participant_Private는 읽지 않으며 legal_name까지만 노출한다.
function assignmentParticipant_(row) {
  return {
    participant_id: String(row.participant_id == null ? '' : row.participant_id),
    public_id: String(row.public_id == null ? '' : row.public_id),
    person_type: String(row.person_type == null ? '' : row.person_type),
    campus: String(row.campus == null ? '' : row.campus),
    grade_band: String(row.grade_band == null ? '' : row.grade_band),
    gender: String(row.gender == null ? '' : row.gender),
    legal_name: String(row.legal_name == null ? '' : row.legal_name),
    engagement_score: numOrBlank_(row.engagement_score),
    extraversion_score: numOrBlank_(row.extraversion_score),
    newcomer: CampCore.bool(row.newcomer),
    leader_candidate: CampCore.bool(row.leader_candidate),
    active: CampCore.bool(row.active)
  };
}

// 배정 편집에 필요한 데이터만 반환한다. Participant_Private는 읽지 않으므로 phone/birth/guardian/insurance/note가 응답에 존재할 수 없다.
function handleGetAssignments_() {
  var participantRows = tableRows_(getSheetRequired_(CAMP.SHEETS.PARTICIPANTS));
  var genderById = {};
  participantRows.forEach(function (row) {
    var id = String(row.participant_id == null ? '' : row.participant_id).trim();
    if (id) genderById[id] = String(row.gender == null ? '' : row.gender);
  });

  var participants = participantRows
    .filter(function (row) { return String(row.participant_id == null ? '' : row.participant_id).trim(); })
    .map(assignmentParticipant_);

  var groups = tableRows_(getSheetRequired_(CAMP.SHEETS.GROUPS)).map(function (row) {
    return {
      group_id: String(row.group_id == null ? '' : row.group_id),
      display_name: String(row.display_name == null ? '' : row.display_name),
      color: String(row.color == null ? '' : row.color),
      target_size: numOrBlank_(row.target_size),
      min_size: numOrBlank_(row.min_size),
      max_size: numOrBlank_(row.max_size),
      active: CampCore.bool(row.active)
    };
  });

  // private_note는 제외한다(방 배정 화면에 비공개 메모 노출 금지).
  var rooms = tableRows_(getSheetRequired_(CAMP.SHEETS.ROOMS)).map(function (row) {
    return {
      room_id: String(row.room_id == null ? '' : row.room_id),
      display_name: String(row.display_name == null ? '' : row.display_name),
      capacity: numOrBlank_(row.capacity),
      gender_scope: String(row.gender_scope == null ? '' : row.gender_scope),
      floor: String(row.floor == null ? '' : row.floor),
      active: CampCore.bool(row.active)
    };
  });

  var vehicleRows = tableRows_(getSheetRequired_(CAMP.SHEETS.VEHICLES));
  var vehicleCapacityById = {};
  var vehicles = vehicleRows.map(function (row) {
    var id = String(row.vehicle_id == null ? '' : row.vehicle_id);
    vehicleCapacityById[id] = CampCore.number(row.capacity_total, 0);
    return {
      vehicle_id: id,
      public_label: String(row.public_label == null ? '' : row.public_label),
      capacity_total: numOrBlank_(row.capacity_total),
      accessible: CampCore.bool(row.accessible),
      active: CampCore.bool(row.active)
    };
  });

  var trips = tableRows_(getSheetRequired_(CAMP.SHEETS.TRIPS)).map(function (row) {
    var vehicleId = String(row.vehicle_id == null ? '' : row.vehicle_id);
    return {
      trip_id: String(row.trip_id == null ? '' : row.trip_id),
      direction: String(row.direction == null ? '' : row.direction),
      depart_at: dateToIso_(row.depart_at),
      vehicle_id: vehicleId,
      driver_participant_id: String(row.driver_participant_id == null ? '' : row.driver_participant_id),
      trip_status: String(row.trip_status == null ? '' : row.trip_status),
      locked: CampCore.bool(row.locked),
      capacity: vehicleCapacityById[vehicleId] == null ? 0 : vehicleCapacityById[vehicleId]
    };
  });

  // 조 배정 조회 시 gender를 실어 성별 과편중 경고를 활성화한다(없으면 미상 처리).
  var groupAssignments = tableRows_(getSheetRequired_(CAMP.SHEETS.GROUP_ASSIGNMENTS))
    .filter(function (row) { return String(row.participant_id == null ? '' : row.participant_id).trim(); })
    .map(function (row) {
      var pid = String(row.participant_id);
      return {
        assignment_id: String(row.assignment_id == null ? '' : row.assignment_id),
        participant_id: pid,
        group_id: String(row.group_id == null ? '' : row.group_id),
        role: String(row.role == null ? '' : row.role),
        locked: CampCore.bool(row.locked),
        gender: genderById[pid] || ''
      };
    });

  var roomAssignments = tableRows_(getSheetRequired_(CAMP.SHEETS.ROOM_ASSIGNMENTS))
    .filter(function (row) { return String(row.participant_id == null ? '' : row.participant_id).trim(); })
    .map(function (row) {
      return {
        room_id: String(row.room_id == null ? '' : row.room_id),
        participant_id: String(row.participant_id),
        locked: CampCore.bool(row.locked)
      };
    });

  var tripPassengers = tableRows_(getSheetRequired_(CAMP.SHEETS.TRIP_PASSENGERS))
    .filter(function (row) { return String(row.participant_id == null ? '' : row.participant_id).trim(); })
    .map(function (row) {
      return {
        trip_passenger_id: String(row.trip_passenger_id == null ? '' : row.trip_passenger_id),
        trip_id: String(row.trip_id == null ? '' : row.trip_id),
        participant_id: String(row.participant_id),
        demand_id: String(row.demand_id == null ? '' : row.demand_id),
        boarding_status: String(row.boarding_status == null ? '' : row.boarding_status),
        seat_count: numOrBlank_(row.seat_count),
        locked: CampCore.bool(row.locked)
      };
    });

  return jsonResponse_({
    ok: true,
    participants: participants,
    groups: groups,
    rooms: rooms,
    vehicles: vehicles,
    trips: trips,
    groupAssignments: groupAssignments,
    roomAssignments: roomAssignments,
    tripPassengers: tripPassengers
  });
}

// payload에서 참가자 id를 뽑고, 참가자 정의 행을 찾는다. 없으면 null(호출부에서 invalid_input).
function assignmentTargetParticipant_(payload) {
  if (!payload || typeof payload !== 'object') return null;
  var participantId = String(payload.participant_id == null ? '' : payload.participant_id).trim();
  if (!participantId) return null;
  var row = indexRowsById_(tableRows_(getSheetRequired_(CAMP.SHEETS.PARTICIPANTS)), 'participant_id')[participantId];
  return row ? { id: participantId, row: row } : null;
}

// slot 값(group_id/room_id/trip_id)을 정규화한다. 빈문자/null이면 null(해제).
function assignmentSlot_(value) {
  var text = String(value == null ? '' : value).trim();
  return text === '' ? null : text;
}

// 조 배정 저장: payload {participant_id, group_id|null, role?, locked?}. group_id=null이면 해제. 참가자당 조 1행 보장.
function handleSaveGroupAssignment_(body, changedBy) {
  var target = assignmentTargetParticipant_(body.payload);
  if (!target) return jsonResponse_({ error: 'invalid_input' });
  var participantId = target.id;
  var payload = body.payload;

  var groups = tableRows_(getSheetRequired_(CAMP.SHEETS.GROUPS));
  var participantRows = tableRows_(getSheetRequired_(CAMP.SHEETS.PARTICIPANTS));
  var genderById = {};
  participantRows.forEach(function (p) { genderById[String(p.participant_id)] = String(p.gender == null ? '' : p.gender); });

  var assignSheet = getSheetRequired_(CAMP.SHEETS.GROUP_ASSIGNMENTS);
  var rawAssign = tableRows_(assignSheet);
  var byAssignId = indexRowsById_(rawAssign, 'assignment_id');
  var currentAssignments = rawAssign.map(function (row) {
    var pid = String(row.participant_id);
    return {
      assignment_id: String(row.assignment_id == null ? '' : row.assignment_id) || null,
      participant_id: pid,
      group_id: String(row.group_id == null ? '' : row.group_id),
      role: row.role,
      locked: row.locked,
      gender: genderById[pid] || ''
    };
  });

  // 희망값(role·locked)을 participant 레코드에 병합해 Core에 넘긴다.
  var participant = {
    participant_id: participantId,
    gender: String(target.row.gender == null ? '' : target.row.gender),
    role: payload.role,
    locked: payload.locked
  };
  var result = CampCore.validateGroupAssignmentChange(participant, assignmentSlot_(payload.group_id), groups, currentAssignments);
  if (!result.ok) return jsonResponse_({ error: 'validation_blocked', issues: adminBlockingIssues_(result.issues) });

  var plan = result.plan;
  var idx = headerIndex_(assignSheet);
  var changeRows = [];

  if (plan.op === 'upsert') {
    var existing = plan.assignmentId ? byAssignId[String(plan.assignmentId)] : null;
    var newSlot = { group_id: plan.groupId, role: plan.role, locked: plan.locked };
    if (existing) {
      var oldSlot = { group_id: existing.group_id, role: existing.role, locked: existing.locked };
      setCellIf_(assignSheet, existing._row, idx, 'group_id', plan.groupId);
      setCellIf_(assignSheet, existing._row, idx, 'role', plan.role);
      setCellIf_(assignSheet, existing._row, idx, 'locked', plan.locked);
      setCellIf_(assignSheet, existing._row, idx, 'assignment_source', 'manual');
      setCellIf_(assignSheet, existing._row, idx, 'updated_at', nowIso_());
      setCellIf_(assignSheet, existing._row, idx, 'updated_by', changedBy == null ? '' : String(changedBy));
      changeRows = CampCore.buildAssignmentChangeRows('group_assignment', participantId, oldSlot, newSlot, changedBy);
    } else {
      appendObjects_(CAMP.SHEETS.GROUP_ASSIGNMENTS, [{
        assignment_id: 'ga_' + Utilities.getUuid().replace(/-/g, ''),
        participant_id: participantId,
        group_id: plan.groupId,
        role: plan.role,
        locked: plan.locked,
        assignment_source: 'manual',
        score_delta: '',
        reason_codes: '',
        revision: 1,
        updated_at: nowIso_(),
        updated_by: changedBy == null ? '' : String(changedBy)
      }]);
      changeRows = CampCore.buildAssignmentChangeRows('group_assignment', participantId, {}, newSlot, changedBy);
    }
  } else if (plan.op === 'remove') {
    var removeRow = plan.assignmentId ? byAssignId[String(plan.assignmentId)] : null;
    if (removeRow) {
      var oldSlotR = { group_id: removeRow.group_id, role: removeRow.role, locked: removeRow.locked };
      assignSheet.deleteRow(removeRow._row);
      changeRows = CampCore.buildAssignmentChangeRows('group_assignment', participantId, oldSlotR, {}, changedBy);
    }
  }

  appendChangeLog_(changeRows);
  return jsonResponse_({ ok: true, warnings: adminWarnings_(result.issues), summary: { entity: 'group_assignment', op: plan.op, participant_id: participantId, group_id: plan.groupId } });
}

// 방 배정 저장: payload {participant_id, room_id|null, locked?}. null이면 해제. 참가자당 방 1행 보장.
// Room_Assignments는 배정 id 컬럼이 없어 참가자 id로 행을 찾아 upsert/remove 한다.
function handleSaveRoomAssignment_(body, changedBy) {
  var target = assignmentTargetParticipant_(body.payload);
  if (!target) return jsonResponse_({ error: 'invalid_input' });
  var participantId = target.id;
  var payload = body.payload;

  var rooms = tableRows_(getSheetRequired_(CAMP.SHEETS.ROOMS));
  var participants = tableRows_(getSheetRequired_(CAMP.SHEETS.PARTICIPANTS));
  var roomSheet = getSheetRequired_(CAMP.SHEETS.ROOM_ASSIGNMENTS);
  var rawAssign = tableRows_(roomSheet);
  var currentAssignments = rawAssign.map(function (row) {
    return { room_id: String(row.room_id == null ? '' : row.room_id), participant_id: String(row.participant_id), locked: row.locked };
  });

  var participant = {
    participant_id: participantId,
    gender: String(target.row.gender == null ? '' : target.row.gender),
    person_type: String(target.row.person_type == null ? '' : target.row.person_type),
    active: CampCore.bool(target.row.active),
    locked: payload.locked
  };
  var result = CampCore.validateRoomAssignmentChange(participant, assignmentSlot_(payload.room_id), rooms, currentAssignments, participants);
  if (!result.ok) return jsonResponse_({ error: 'validation_blocked', issues: adminBlockingIssues_(result.issues) });

  var plan = result.plan;
  var existingRows = rawAssign.filter(function (row) { return String(row.participant_id) === participantId; });
  var oldSlot = existingRows.length ? { room_id: existingRows[0].room_id, locked: existingRows[0].locked } : {};
  var changeRows = [];

  if (plan.op === 'upsert') {
    // 참가자당 방 1행 보장: 기존 방 배정 행을 모두 제거하고 대상 방으로 재작성한다(정의 행이 아닌 배정 행만).
    deleteRowsDesc_(roomSheet, existingRows);
    appendObjects_(CAMP.SHEETS.ROOM_ASSIGNMENTS, [{
      room_id: plan.roomId,
      participant_id: participantId,
      locked: plan.locked,
      assignment_source: 'manual'
    }]);
    changeRows = CampCore.buildAssignmentChangeRows('room_assignment', participantId, oldSlot, { room_id: plan.roomId, locked: plan.locked }, changedBy);
  } else if (plan.op === 'remove') {
    deleteRowsDesc_(roomSheet, existingRows);
    changeRows = CampCore.buildAssignmentChangeRows('room_assignment', participantId, oldSlot, {}, changedBy);
  }

  appendChangeLog_(changeRows);
  return jsonResponse_({ ok: true, warnings: adminWarnings_(result.issues), summary: { entity: 'room_assignment', op: plan.op, participant_id: participantId, room_id: plan.roomId } });
}

// 차량(운행) 탑승 저장: payload {participant_id, trip_id|null, direction, demand_id?, seat_count?, boarding_status?, locked?}.
// trip_id=null이면 해당 direction 배정 해제. 같은 direction 1건 보장. 정원(운전자 좌석 포함) 검증.
function handleSaveTripPassenger_(body, changedBy) {
  var target = assignmentTargetParticipant_(body.payload);
  if (!target) return jsonResponse_({ error: 'invalid_input' });
  var participantId = target.id;
  var payload = body.payload;

  var trips = tableRows_(getSheetRequired_(CAMP.SHEETS.TRIPS));
  var tripsById = CampCore.indexBy(trips, 'trip_id');
  var vehiclesById = {};
  tableRows_(getSheetRequired_(CAMP.SHEETS.VEHICLES)).forEach(function (v) {
    vehiclesById[String(v.vehicle_id)] = { capacity_total: CampCore.number(v.capacity_total, 0) };
  });

  var passengerSheet = getSheetRequired_(CAMP.SHEETS.TRIP_PASSENGERS);
  var rawPassengers = tableRows_(passengerSheet);
  var byPassengerId = indexRowsById_(rawPassengers, 'trip_passenger_id');
  var currentPassengers = rawPassengers.map(function (row) {
    return {
      trip_passenger_id: String(row.trip_passenger_id == null ? '' : row.trip_passenger_id) || null,
      trip_id: String(row.trip_id == null ? '' : row.trip_id),
      participant_id: String(row.participant_id),
      boarding_status: String(row.boarding_status == null ? '' : row.boarding_status),
      seat_count: row.seat_count
    };
  });

  // demand_id가 주어지면 Travel_Demands에서 시간창·좌석 기본값을 조인한다.
  var demand = null;
  var demandId = String(payload.demand_id == null ? '' : payload.demand_id).trim();
  if (demandId) {
    demand = indexRowsById_(tableRows_(getSheetRequired_(CAMP.SHEETS.TRAVEL_DEMANDS)), 'demand_id')[demandId] || null;
  }

  // 희망값(seat_count·boarding_status·locked)을 participant 레코드에 병합한다. seat_count는 빈값이면 넘기지 않아 demand/1로 폴백되게 한다.
  var participant = { participant_id: participantId, boarding_status: payload.boarding_status, locked: payload.locked };
  if (payload.seat_count != null && String(payload.seat_count).trim() !== '') participant.seat_count = payload.seat_count;

  var result = CampCore.validateTripPassengerChange(participant, assignmentSlot_(payload.trip_id), payload.direction, trips, vehiclesById, currentPassengers, demand);
  if (!result.ok) return jsonResponse_({ error: 'validation_blocked', issues: adminBlockingIssues_(result.issues) });

  var plan = result.plan;
  var idx = headerIndex_(passengerSheet);
  var changeRows = [];

  function tripDirection_(tripId) {
    var t = tripsById[String(tripId)];
    return t ? String(t.direction == null ? '' : t.direction).toUpperCase() : '';
  }

  if (plan.op === 'upsert') {
    var existing = plan.assignmentId ? byPassengerId[String(plan.assignmentId)] : null;
    var newSlot = { trip_id: plan.tripId, direction: plan.direction, seat_count: plan.seatCount, boarding_status: plan.boardingStatus, locked: plan.locked };
    if (existing) {
      var oldSlot = { trip_id: existing.trip_id, direction: tripDirection_(existing.trip_id), seat_count: existing.seat_count, boarding_status: existing.boarding_status, locked: existing.locked };
      setCellIf_(passengerSheet, existing._row, idx, 'trip_id', plan.tripId);
      setCellIf_(passengerSheet, existing._row, idx, 'boarding_status', plan.boardingStatus);
      setCellIf_(passengerSheet, existing._row, idx, 'seat_count', plan.seatCount);
      setCellIf_(passengerSheet, existing._row, idx, 'locked', plan.locked);
      setCellIf_(passengerSheet, existing._row, idx, 'assignment_source', 'manual');
      if (demandId) setCellIf_(passengerSheet, existing._row, idx, 'demand_id', demandId);
      setCellIf_(passengerSheet, existing._row, idx, 'updated_at', nowIso_());
      changeRows = CampCore.buildAssignmentChangeRows('trip_passenger', participantId, oldSlot, newSlot, changedBy);
    } else {
      appendObjects_(CAMP.SHEETS.TRIP_PASSENGERS, [{
        trip_passenger_id: 'tp_' + Utilities.getUuid().replace(/-/g, ''),
        trip_id: plan.tripId,
        participant_id: participantId,
        demand_id: demandId,
        boarding_status: plan.boardingStatus,
        seat_count: plan.seatCount,
        assignment_source: 'manual',
        locked: plan.locked,
        updated_at: nowIso_()
      }]);
      changeRows = CampCore.buildAssignmentChangeRows('trip_passenger', participantId, {}, newSlot, changedBy);
    }
  } else if (plan.op === 'remove') {
    var removeRow = plan.assignmentId ? byPassengerId[String(plan.assignmentId)] : null;
    if (removeRow) {
      var oldSlotR = { trip_id: removeRow.trip_id, direction: tripDirection_(removeRow.trip_id), seat_count: removeRow.seat_count, boarding_status: removeRow.boarding_status, locked: removeRow.locked };
      passengerSheet.deleteRow(removeRow._row);
      changeRows = CampCore.buildAssignmentChangeRows('trip_passenger', participantId, oldSlotR, {}, changedBy);
    }
  }

  appendChangeLog_(changeRows);
  return jsonResponse_({ ok: true, warnings: adminWarnings_(result.issues), summary: { entity: 'trip_passenger', op: plan.op, participant_id: participantId, trip_id: plan.tripId, direction: plan.direction } });
}

// 배정 감사행을 change_id/changed_at 스탬프 후 Change_Log에 append 한다(빈 배열이면 아무것도 하지 않음).
function appendChangeLog_(changeRows) {
  var changeLog = stampChangeRows_(changeRows);
  if (changeLog.length) appendObjects_(CAMP.SHEETS.CHANGE_LOG, changeLog);
}

// 주어진 배정 행들을 행번호 내림차순으로 물리 삭제한다(배정 행만 — 참가자/조/방/차량 정의 행은 호출부가 넘기지 않는다).
function deleteRowsDesc_(sheet, rows) {
  (rows || []).slice().sort(function (a, b) { return b._row - a._row; }).forEach(function (row) { sheet.deleteRow(row._row); });
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
