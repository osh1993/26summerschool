function readOperationalData_() {
  return {
    settings: getSettings_(),
    participants: tableRows_(getSheetRequired_(CAMP.SHEETS.PARTICIPANTS)),
    participantPrivate: tableRows_(getSheetRequired_(CAMP.SHEETS.PRIVATE)),
    timeSlots: tableRows_(getSheetRequired_(CAMP.SHEETS.TIME_SLOTS)),
    attendance: tableRows_(getSheetRequired_(CAMP.SHEETS.ATTENDANCE)),
    relations: tableRows_(getSheetRequired_(CAMP.SHEETS.RELATIONS)),
    groups: tableRows_(getSheetRequired_(CAMP.SHEETS.GROUPS)),
    groupAssignments: tableRows_(getSheetRequired_(CAMP.SHEETS.GROUP_ASSIGNMENTS)),
    locations: tableRows_(getSheetRequired_(CAMP.SHEETS.LOCATIONS)),
    travelDemands: tableRows_(getSheetRequired_(CAMP.SHEETS.TRAVEL_DEMANDS)),
    vehicles: tableRows_(getSheetRequired_(CAMP.SHEETS.VEHICLES)),
    vehicleAvailability: tableRows_(getSheetRequired_(CAMP.SHEETS.VEHICLE_AVAILABILITY)),
    trips: tableRows_(getSheetRequired_(CAMP.SHEETS.TRIPS)),
    tripPassengers: tableRows_(getSheetRequired_(CAMP.SHEETS.TRIP_PASSENGERS)),
    notices: tableRows_(getSheetRequired_(CAMP.SHEETS.NOTICES))
  };
}

function validateBeforePublish() {
  var data = readOperationalData_();
  var issues = validateAllForPublish_(data, null);
  replaceValidationIssues_(issues);
  var blocking = CampCore.blockingIssues(issues).length;
  SpreadsheetApp.getUi().alert(blocking ? '게시 차단 오류 ' + blocking + '건입니다. Validation 탭을 확인하세요.' : '게시 차단 오류가 없습니다. 경고 ' + (issues.length - blocking) + '건입니다.');
  return issues;
}

function validateAllForPublish_(data, snapshot) {
  var issues = CampCore.validateInternalModel(data).concat(validatePublishEligibility_(data));
  // legalNames를 함께 전달하면 validatePublicSnapshot이 assertNoFullNames(공개 불변조건 #1)를 실행해 실명 유입을 게시 전에 차단한다.
  if (snapshot) issues = issues.concat(CampCore.validatePublicSnapshot(snapshot, collectSensitiveCanaries_(data), collectLegalNames_(data)));
  return issues;
}

function validatePublishEligibility_(data) {
  var issues = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.settings.EVENT_START_DATE || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.settings.EVENT_END_DATE || ''))) {
    issues.push(CampCore.issue('EVENT_DATE_INVALID', 'event', data.settings.EVENT_ID || '', '행사 시작일/종료일을 YYYY-MM-DD로 입력하세요.'));
  }
  var participants = CampCore.indexBy(data.participants, 'participant_id');
  // 조 배정: 동의 없는 대상(교사 등)은 공개 명단에서 제외되므로 차단하지 않는다.
  // 동의한 참가자는 공개 코드(public_id)가 있어야 공개 명단에 코드가 표시된다. 공개 표시명은 성 마스킹으로 자동 파생하므로 public_name 컬럼은 요구하지 않는다.
  (data.groupAssignments || []).forEach(function (row) {
    var participant = participants[String(row.participant_id)];
    if (participant && CampCore.bool(participant.public_consent) && !String(participant.public_id || '').trim()) {
      issues.push(CampCore.issue('MISSING_PUBLIC_ID', 'participant', row.participant_id, '공개 동의 참가자에게 공개 코드(public_id)가 없습니다.'));
    }
  });
  // 차량 탑승자: 기존 공개 동의 요건 유지(차량 표현은 Phase 3에서 재검토).
  var tripUsed = {};
  (data.tripPassengers || []).filter(function (row) { return ['cancelled', 'no_show'].indexOf(String(row.boarding_status)) < 0; })
    .forEach(function (row) { tripUsed[String(row.participant_id)] = true; });
  Object.keys(tripUsed).forEach(function (id) {
    var participant = participants[id];
    if (!participant || !CampCore.bool(participant.public_consent) || !String(participant.public_id || '').trim() || !String(participant.public_name || '').trim()) {
      issues.push(CampCore.issue('MISSING_PUBLIC_CONSENT', 'participant', id, '공개 배정 대상의 동의 또는 승인 게시명이 없습니다.'));
    }
  });
  (data.trips || []).filter(function (trip) { return ['open', 'confirmed', 'departed', 'arrived', 'cancelled'].indexOf(String(trip.trip_status)) >= 0; }).forEach(function (trip) {
    ['origin_location_id', 'destination_location_id', 'meeting_location_id'].forEach(function (field) {
      var location = (data.locations || []).find(function (row) { return String(row.location_id) === String(trip[field]); });
      if (!location || !CampCore.bool(location.public_allowed) || !String(location.public_label || '').trim()) {
        issues.push(CampCore.issue('LOCATION_NOT_PUBLIC', 'trip', trip.trip_id, field + '에 공개 허용 장소 라벨이 없습니다.'));
      }
    });
  });
  (data.vehicles || []).filter(function (vehicle) { return CampCore.bool(vehicle.active); }).forEach(function (vehicle) {
    if (!String(vehicle.public_label || '').trim() || CampCore.number(vehicle.capacity_total, 0) < 2) {
      issues.push(CampCore.issue('VEHICLE_PUBLIC_DATA_INVALID', 'vehicle', vehicle.vehicle_id, '공개 차량 라벨 또는 운전자 포함 정원이 올바르지 않습니다.'));
    }
  });
  (data.travelDemands || []).filter(function (demand) { return String(demand.demand_status) === 'unassigned'; }).forEach(function (demand) {
    issues.push(CampCore.issue('UNASSIGNED_DEMAND', 'demand', demand.demand_id, '배정되지 않은 이동 수요가 있습니다.', false, 'warning'));
  });
  return issues;
}

function collectSensitiveCanaries_(data) {
  var values = [];
  // v2 불변조건: 공개 스냅샷에는 전체 실명이 절대 없어야 한다(동의 여부와 무관하게 legal_name은 항상 민감값).
  (data.participants || []).forEach(function (row) {
    values.push(row.legal_name, row.participant_id, row.source_response_id);
  });
  (data.participantPrivate || []).forEach(function (row) { values.push(row.birth_date, row.phone, row.guardian_phone, row.private_note); });
  return values.filter(function (value) { return value != null && String(value).length >= 4; }).map(String);
}

// 공개 표시명(성 마스킹)이 전체 실명과 정확히 일치하는지 검사하기 위한 실명 목록.
function collectLegalNames_(data) {
  return (data.participants || [])
    .map(function (row) { return String(row.legal_name == null ? '' : row.legal_name).trim(); })
    .filter(function (name) { return name; });
}

// 내부 스냅샷 검증용 카나리: 실명·내부ID는 내부뷰에서 정상 노출되므로 제외하고, 개인 민감 원문만 유출 검사한다.
function collectPrivateCanaries_(data) {
  var values = [];
  (data.participantPrivate || []).forEach(function (row) { values.push(row.birth_date, row.phone, row.guardian_phone, row.private_note); });
  return values.filter(function (value) { return value != null && String(value).length >= 4; }).map(String);
}

function appendValidationIssues_(issues) {
  if (!issues || !issues.length) return;
  appendObjects_(CAMP.SHEETS.VALIDATION, issues.map(function (row) {
    return {
      severity: row.severity,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      rule_code: row.rule_code,
      message_private: row.message_private,
      blocking: row.blocking,
      detected_at: nowIso_(),
      resolved_at: ''
    };
  }));
}

function replaceValidationIssues_(issues) {
  var sheet = getSheetRequired_(CAMP.SHEETS.VALIDATION);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  appendValidationIssues_(issues);
}
