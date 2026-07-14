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
  if (snapshot) issues = issues.concat(CampCore.validatePublicSnapshot(snapshot, collectSensitiveCanaries_(data)));
  return issues;
}

function validatePublishEligibility_(data) {
  var issues = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.settings.EVENT_START_DATE || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.settings.EVENT_END_DATE || ''))) {
    issues.push(CampCore.issue('EVENT_DATE_INVALID', 'event', data.settings.EVENT_ID || '', '행사 시작일/종료일을 YYYY-MM-DD로 입력하세요.'));
  }
  var participants = CampCore.indexBy(data.participants, 'participant_id');
  var used = {};
  (data.groupAssignments || []).forEach(function (row) { used[String(row.participant_id)] = true; });
  (data.tripPassengers || []).filter(function (row) { return ['cancelled', 'no_show'].indexOf(String(row.boarding_status)) < 0; })
    .forEach(function (row) { used[String(row.participant_id)] = true; });
  Object.keys(used).forEach(function (id) {
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
  (data.participants || []).forEach(function (row) {
    if (!(CampCore.bool(row.public_consent) && String(row.public_name || '') === String(row.legal_name || ''))) values.push(row.legal_name);
    values.push(row.participant_id, row.source_response_id);
  });
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
