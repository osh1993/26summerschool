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

// internal=true면 각 member에 full_name(legal_name)과 최상위 teachers[]/staff[], rooms[].members[].full_name을 덧붙인 internal-snapshot/v2를 만든다.
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
      return { public_id: String(person.public_id), public_name: String(person.public_name), boarding_status: status };
    });
    var departIso = dateToIso_(trip.depart_at);
    var vehicle = vehicles[String(trip.vehicle_id)];
    var capacity = CampCore.number(vehicle.capacity_total, 0);
    return {
      trip_id: String(trip.trip_id),
      date: departIso.slice(0, 10),
      time: departIso.slice(11, 16),
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

// 내부 스냅샷(internal-snapshot/v2)을 조립한다. 정적 파일로 저장하지 않고 doPost 응답으로만 반환한다.
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

// 인증 내부 뷰: {user, password}를 받아 Script Property의 공용 자격증명으로 검증한 뒤에만 실명 포함 내부 스냅샷을 반환한다.
// 성공해도 정적 파일로 저장하지 않는다. 실패/미설정/오류 시에는 힌트 없는 오류만 반환한다.
function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents) || {}; } catch (parseError) { body = {}; }
    }
    var props = PropertiesService.getScriptProperties();
    var storedUser = props.getProperty('CAMP_INTERNAL_USER');
    var storedPwHash = props.getProperty('CAMP_INTERNAL_PW_HASH');
    // Script Property 미설정이면 verifyInternalCredential이 false를 반환하므로 자연히 unauthorized가 된다.
    var authorized = CampCore.verifyInternalCredential(body.user, body.password, storedUser, storedPwHash, sha256Hex_);
    if (!authorized) return jsonResponse_({ error: 'unauthorized' });
    var data = readOperationalData_();
    var snapshot = buildInternalSnapshot_(data);
    // 내부 스냅샷 구조를 점검하되, 개인 민감 원문(전화/생년월일 등)만 유출 카나리로 검사한다(실명·내부ID는 내부뷰 정상 노출).
    var structural = CampCore.validateInternalSnapshot(snapshot, collectPrivateCanaries_(data));
    if (CampCore.blockingIssues(structural).length) return jsonResponse_({ error: 'temporarily_unavailable' });
    return jsonResponse_(snapshot);
  } catch (error) {
    // 내부 응답 오류에도 스택, 시트명, 셀 범위, 내부 ID를 포함하지 않는다.
    return jsonResponse_({ error: 'temporarily_unavailable' });
  }
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
