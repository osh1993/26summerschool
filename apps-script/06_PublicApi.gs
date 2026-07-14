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

function buildPublicSnapshot_(data, publishId, preIssues) {
  var participants = CampCore.indexBy(data.participants, 'participant_id');
  var vehicles = CampCore.indexBy(data.vehicles, 'vehicle_id');
  var locations = CampCore.indexBy(data.locations, 'location_id');
  var assignmentsByGroup = CampCore.groupBy(data.groupAssignments, 'group_id');
  var passengersByTrip = CampCore.groupBy((data.tripPassengers || []).filter(function (row) {
    return ['cancelled', 'no_show'].indexOf(String(row.boarding_status)) < 0;
  }), 'trip_id');
  var updatedValues = [];
  (data.groupAssignments || []).concat(data.trips || []).concat(data.tripPassengers || []).forEach(function (row) { if (row.updated_at) updatedValues.push(dateToIso_(row.updated_at)); });
  updatedValues.sort();
  var generatedAt = nowIso_();
  var groups = (data.groups || []).filter(function (row) { return CampCore.bool(row.active); }).map(function (group) {
    return {
      group_id: String(group.group_id),
      display_name: String(group.display_name),
      color: group.color ? String(group.color) : undefined,
      members: (assignmentsByGroup[String(group.group_id)] || []).map(function (assignment) {
        var person = participants[String(assignment.participant_id)];
        return { public_id: String(person.public_id), public_name: String(person.public_name), role: String(assignment.role || 'member') };
      })
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
    schema_version: CAMP.SCHEMA_VERSION,
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
    groups: groups,
    vehicles: publicVehicles,
    trips: publicTrips,
    unassigned_summary: Object.keys(unassignedBuckets).sort().map(function (key) { return unassignedBuckets[key]; }),
    validation: { status: warningCount > 0 ? 'warning' : 'ok', blocking_error_count: 0, warning_count: warningCount, warnings: publicWarnings }
  });
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

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
