/*
 * Apps Script와 Node 테스트가 함께 사용하는 순수 로직.
 * SpreadsheetApp, Utilities 등 Apps Script 전역에 의존하지 않는다.
 */
var CampCore = (function () {
  'use strict';

  function issue(ruleCode, entityType, entityId, message, blocking, severity) {
    return {
      severity: severity || (blocking === false ? 'warning' : 'error'),
      entity_type: entityType || 'system',
      entity_id: entityId == null ? '' : String(entityId),
      rule_code: ruleCode,
      message_private: message || ruleCode,
      blocking: blocking !== false
    };
  }

  function bool(value) {
    if (value === true || value === 1) return true;
    return ['true', '1', 'y', 'yes', '예', '동의', '참석'].indexOf(String(value == null ? '' : value).trim().toLowerCase()) >= 0;
  }

  function number(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function activeRow(row) {
    return row && row.active !== false && String(row.active).toLowerCase() !== 'false' && row.active !== 0;
  }

  function indexBy(rows, key) {
    return (rows || []).reduce(function (map, row) {
      if (row && row[key] !== '' && row[key] != null) map[String(row[key])] = row;
      return map;
    }, {});
  }

  function groupBy(rows, key) {
    return (rows || []).reduce(function (map, row) {
      var value = String(row[key] == null ? '' : row[key]);
      if (!map[value]) map[value] = [];
      map[value].push(row);
      return map;
    }, {});
  }

  function parseMillis(value) {
    if (value instanceof Date) return value.getTime();
    var millis = Date.parse(value);
    return Number.isFinite(millis) ? millis : NaN;
  }

  // 운행 구간은 [출발, 도착) 반개구간이다. 끝 시각과 다음 시작이 같으면 겹치지 않는다.
  function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
    var as = parseMillis(aStart), ae = parseMillis(aEnd), bs = parseMillis(bStart), be = parseMillis(bEnd);
    if (![as, ae, bs, be].every(Number.isFinite)) return false;
    return as < be && bs < ae;
  }

  function validateInternalModel(data) {
    data = data || {};
    var issues = [];
    var participants = indexBy(data.participants, 'participant_id');
    var groups = indexBy((data.groups || []).filter(activeRow), 'group_id');
    var vehicles = indexBy((data.vehicles || []).filter(activeRow), 'vehicle_id');
    var trips = indexBy(data.trips, 'trip_id');
    var locations = indexBy(data.locations, 'location_id');
    var assignments = data.groupAssignments || [];
    var tripPassengers = data.tripPassengers || [];
    var demands = indexBy(data.travelDemands, 'demand_id');
    var availabilityByVehicle = groupBy(data.vehicleAvailability || [], 'vehicle_id');

    var participantGroups = groupBy(assignments, 'participant_id');
    assignments.forEach(function (row) {
      if (!participants[String(row.participant_id)]) {
        issues.push(issue('PARTICIPANT_REFERENCE_BROKEN', 'group_assignment', row.assignment_id, '조 배정이 존재하지 않는 참가자를 참조합니다.'));
      }
    });
    Object.keys(participantGroups).forEach(function (participantId) {
      var rows = participantGroups[participantId].filter(function (row) { return String(row.assignment_status || 'active') !== 'cancelled'; });
      if (rows.length > 1) issues.push(issue('MULTIPLE_ACTIVE_GROUPS', 'participant', participantId, '활성 조 배정이 두 개 이상입니다.'));
      if (participants[participantId] && !activeRow(participants[participantId])) {
        issues.push(issue('INACTIVE_PARTICIPANT_ASSIGNED', 'participant', participantId, '비활성 참가자가 조에 배정되었습니다.'));
      }
    });

    var assignmentsByGroup = groupBy(assignments, 'group_id');
    Object.keys(groups).forEach(function (groupId) {
      var count = (assignmentsByGroup[groupId] || []).length;
      var max = number(groups[groupId].max_size, Infinity);
      var min = number(groups[groupId].min_size, 0);
      if (count > max) issues.push(issue('GROUP_SIZE_EXCEEDED', 'group', groupId, '조 최대 인원을 초과했습니다.'));
      if (count < min) issues.push(issue('GROUP_SIZE_BELOW_MIN', 'group', groupId, '조 최소 인원보다 적습니다.'));
    });

    (data.relations || []).filter(activeRow).forEach(function (relation) {
      var aRows = participantGroups[String(relation.participant_a_id)] || [];
      var bRows = participantGroups[String(relation.participant_b_id)] || [];
      if (!aRows.length || !bRows.length) return;
      var same = String(aRows[0].group_id) === String(bRows[0].group_id);
      if ((relation.relation_type === 'must_together' && !same) || (relation.relation_type === 'must_separate' && same)) {
        issues.push(issue('RELATION_CONFLICT', 'relation', relation.relation_id, '필수 관계 제약을 위반했습니다.'));
      }
    });

    var demandAssignments = groupBy(tripPassengers.filter(function (row) {
      return ['cancelled', 'no_show'].indexOf(String(row.boarding_status)) < 0;
    }), 'demand_id');
    tripPassengers.forEach(function (row) {
      if (!participants[String(row.participant_id)]) {
        issues.push(issue('PARTICIPANT_REFERENCE_BROKEN', 'trip_passenger', row.trip_passenger_id, '탑승 배정이 존재하지 않는 참가자를 참조합니다.'));
      }
    });
    Object.keys(demandAssignments).forEach(function (demandId) {
      if (demandAssignments[demandId].length > 1) {
        issues.push(issue('DUPLICATE_DEMAND_ASSIGNMENT', 'demand', demandId, '동일 이동 수요가 중복 배정되었습니다.'));
      }
    });

    var tripPassengersByTrip = groupBy(tripPassengers.filter(function (row) {
      return ['cancelled', 'no_show'].indexOf(String(row.boarding_status)) < 0;
    }), 'trip_id');
    Object.keys(trips).forEach(function (tripId) {
      var trip = trips[tripId];
      var passengers = tripPassengersByTrip[tripId] || [];
      var vehicle = vehicles[String(trip.vehicle_id)];
      if (!vehicle) {
        issues.push(issue('PUBLIC_REFERENCE_BROKEN', 'trip', tripId, '차량 참조가 없거나 비활성입니다.'));
        return;
      }
      var capacity = number(vehicle.capacity_total, 0);
      var seats = passengers.reduce(function (sum, row) { return sum + number(row.seat_count, 1); }, 0);
      if (seats + 1 > capacity) issues.push(issue('VEHICLE_OVER_CAPACITY', 'trip', tripId, '운전자를 포함한 차량 정원을 초과했습니다.'));
      if (String(trip.trip_status) === 'cancelled' && passengers.length) {
        issues.push(issue('CANCELLED_TRIP_HAS_PASSENGERS', 'trip', tripId, '취소 운행에 승객이 남아 있습니다.'));
      }
      var departMillis = parseMillis(trip.depart_at);
      var arrivalMillis = parseMillis(trip.arrival_estimate);
      if (!Number.isFinite(departMillis) || !Number.isFinite(arrivalMillis) || arrivalMillis <= departMillis) {
        issues.push(issue('TRIP_TIME_INVALID', 'trip', tripId, '운행 출발/도착 시각이 올바르지 않습니다.'));
      } else {
        var matchingWindow = (availabilityByVehicle[String(trip.vehicle_id)] || []).some(function (window) {
          return String(window.status || 'available') === 'available' &&
            parseMillis(window.available_from) <= departMillis && parseMillis(window.available_to) >= arrivalMillis &&
            (!window.driver_participant_id || String(window.driver_participant_id) === String(trip.driver_participant_id));
        });
        if (!matchingWindow) issues.push(issue('TRIP_OUTSIDE_AVAILABILITY', 'trip', tripId, '차량/운전자 가용시간 밖의 운행입니다.'));
      }
      if (passengers.some(function (row) { return String(row.participant_id) === String(trip.driver_participant_id); })) {
        issues.push(issue('DRIVER_DUPLICATED_AS_PASSENGER', 'trip', tripId, '운전자가 같은 운행의 승객으로도 등록되었습니다.'));
      }
      passengers.forEach(function (row) {
        var demand = demands[String(row.demand_id)];
        if (!demand) return;
        if (String(demand.direction) !== String(trip.direction) ||
            String(demand.origin_location_id) !== String(trip.origin_location_id) ||
            String(demand.destination_location_id) !== String(trip.destination_location_id)) {
          issues.push(issue('ROUTE_MISMATCH', 'demand', row.demand_id, '이동 수요와 운행 방향/경로가 다릅니다.'));
        }
        var depart = parseMillis(trip.depart_at);
        var earliest = parseMillis(demand.earliest_depart_at);
        var latest = parseMillis(demand.latest_depart_at);
        if ((Number.isFinite(earliest) && depart < earliest) || (Number.isFinite(latest) && depart > latest)) {
          issues.push(issue('NO_TIME_MATCH', 'demand', row.demand_id, '운행 출발이 요청 시간창 밖입니다.'));
        }
        if (String(demand.demand_status) === 'self_transport') {
          issues.push(issue('SELF_TRANSPORT_ASSIGNED', 'demand', row.demand_id, '자가이동 수요가 차량에 배정되었습니다.'));
        }
      });
    });

    var tripList = Object.keys(trips).map(function (id) { return trips[id]; }).filter(function (trip) {
      return String(trip.trip_status) !== 'cancelled';
    });
    for (var i = 0; i < tripList.length; i += 1) {
      for (var j = i + 1; j < tripList.length; j += 1) {
        var a = tripList[i], b = tripList[j];
        if (!intervalsOverlap(a.depart_at, a.arrival_estimate, b.depart_at, b.arrival_estimate)) continue;
        if (String(a.vehicle_id) === String(b.vehicle_id)) issues.push(issue('VEHICLE_TIME_CONFLICT', 'trip', a.trip_id + '|' + b.trip_id, '동일 차량의 운행시간이 겹칩니다.'));
        if (String(a.driver_participant_id) === String(b.driver_participant_id)) issues.push(issue('DRIVER_TIME_CONFLICT', 'trip', a.trip_id + '|' + b.trip_id, '동일 운전자의 운행시간이 겹칩니다.'));
        var aPeople = (tripPassengersByTrip[String(a.trip_id)] || []).map(function (row) { return String(row.participant_id); });
        var bPeople = (tripPassengersByTrip[String(b.trip_id)] || []).map(function (row) { return String(row.participant_id); });
        var duplicate = aPeople.find(function (id) { return bPeople.indexOf(id) >= 0; });
        if (duplicate) issues.push(issue('PASSENGER_TIME_CONFLICT', 'participant', duplicate, '동일 참가자의 운행시간이 겹칩니다.'));
      }
    }

    (data.locations || []).forEach(function (location) {
      if (bool(location.public_allowed) && !String(location.public_label || '').trim()) {
        issues.push(issue('LOCATION_NOT_PUBLIC', 'location', location.location_id, '공개 허용 장소에 공개 라벨이 없습니다.'));
      }
    });
    return issues;
  }

  var ALLOWED = Object.freeze({
    root: ['schema_version', 'event', 'generated_at', 'updated_at', 'publish_id', 'notices', 'groups', 'vehicles', 'trips', 'unassigned_summary', 'validation'],
    event: ['event_id', 'name', 'starts_on', 'ends_on', 'timezone'],
    notice: ['notice_id', 'title', 'message', 'severity', 'starts_at', 'ends_at'],
    group: ['group_id', 'display_name', 'color', 'members'],
    member: ['public_id', 'public_name', 'role'],
    vehicle: ['vehicle_id', 'label', 'capacity', 'accessibility'],
    trip: ['trip_id', 'date', 'time', 'direction', 'origin', 'destination', 'meeting_point', 'status', 'vehicle_id', 'driver_label', 'capacity', 'passenger_count', 'remaining_seats', 'passengers', 'updated_at'],
    passenger: ['public_id', 'public_name', 'boarding_status'],
    unassigned: ['trip_window_id', 'direction', 'count', 'reason_code'],
    validation: ['status', 'blocking_error_count', 'warning_count', 'warnings'],
    warning: ['rule_code', 'message', 'count']
  });

  function unknownKeys(object, allowed) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return ['<not-object>'];
    return Object.keys(object).filter(function (key) { return allowed.indexOf(key) < 0; });
  }

  function scanPublicStrings(value, path, sensitiveValues, issues) {
    if (typeof value === 'string') {
      var patterns = [
        /(?:\+82[\s-]?)?0?10[\s-]?\d{3,4}[\s-]?\d{4}/,
        /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
        /\bpt_[A-Za-z0-9_-]{5,}\b/,
        /\/spreadsheets\/d\/[A-Za-z0-9_-]+/,
        /\b\d{2,3}[가-힣]\s?\d{4}\b/
      ];
      if (patterns.some(function (pattern) { return pattern.test(value); })) {
        issues.push(issue('PUBLIC_FIELD_LEAK', 'public_json', path, '공개 문자열에서 민감정보 패턴이 탐지되었습니다.'));
      }
      (sensitiveValues || []).filter(Boolean).forEach(function (secret) {
        if (String(secret).length >= 4 && value.indexOf(String(secret)) >= 0) {
          issues.push(issue('PUBLIC_FIELD_LEAK', 'public_json', path, '내부 민감값이 공개 문자열에 포함되었습니다.'));
        }
      });
    } else if (Array.isArray(value)) {
      value.forEach(function (item, index) { scanPublicStrings(item, path + '[' + index + ']', sensitiveValues, issues); });
    } else if (value && typeof value === 'object') {
      Object.keys(value).forEach(function (key) { scanPublicStrings(value[key], path + '.' + key, sensitiveValues, issues); });
    }
  }

  function validatePublicSnapshot(snapshot, sensitiveValues) {
    var issues = [];
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [issue('PUBLIC_SCHEMA_INVALID', 'snapshot', '', '공개 스냅샷이 객체가 아닙니다.')];
    unknownKeys(snapshot, ALLOWED.root).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'snapshot', key, '허용되지 않은 최상위 키입니다.')); });
    ['schema_version', 'event', 'generated_at', 'updated_at', 'publish_id', 'notices', 'groups', 'vehicles', 'trips', 'unassigned_summary', 'validation'].forEach(function (key) {
      if (snapshot[key] == null) issues.push(issue('PUBLIC_REQUIRED_FIELD_MISSING', 'snapshot', key, '필수 공개 필드가 없습니다.'));
    });
    if (snapshot.schema_version !== 'public-snapshot/v1') issues.push(issue('PUBLIC_SCHEMA_VERSION_INVALID', 'snapshot', 'schema_version', '지원하지 않는 스키마 버전입니다.'));
    if (snapshot.event) unknownKeys(snapshot.event, ALLOWED.event).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'event', key)); });
    var arrays = ['notices', 'groups', 'vehicles', 'trips', 'unassigned_summary'];
    arrays.forEach(function (key) { if (!Array.isArray(snapshot[key])) issues.push(issue('PUBLIC_ARRAY_REQUIRED', 'snapshot', key)); });

    var publicGroups = {};
    var groupIds = {};
    (snapshot.groups || []).forEach(function (group) {
      unknownKeys(group, ALLOWED.group).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'group', key)); });
      if (groupIds[group.group_id]) issues.push(issue('PUBLIC_DUPLICATE_ID', 'group', group.group_id));
      groupIds[group.group_id] = true;
      (group.members || []).forEach(function (member) {
        unknownKeys(member, ALLOWED.member).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'member', key)); });
        if (publicGroups[member.public_id]) issues.push(issue('PUBLIC_MULTIPLE_GROUPS', 'participant', member.public_id));
        publicGroups[member.public_id] = group.group_id;
      });
    });

    var vehicleIds = {};
    (snapshot.vehicles || []).forEach(function (vehicle) {
      unknownKeys(vehicle, ALLOWED.vehicle).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'vehicle', key)); });
      if (vehicleIds[vehicle.vehicle_id]) issues.push(issue('PUBLIC_DUPLICATE_ID', 'vehicle', vehicle.vehicle_id));
      vehicleIds[vehicle.vehicle_id] = true;
    });
    var tripIds = {};
    var passengerTimes = {};
    (snapshot.trips || []).forEach(function (trip) {
      unknownKeys(trip, ALLOWED.trip).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'trip', key)); });
      if (tripIds[trip.trip_id]) issues.push(issue('PUBLIC_DUPLICATE_ID', 'trip', trip.trip_id));
      tripIds[trip.trip_id] = true;
      if (!vehicleIds[trip.vehicle_id]) issues.push(issue('PUBLIC_REFERENCE_BROKEN', 'trip', trip.trip_id));
      if (!Array.isArray(trip.passengers)) issues.push(issue('PUBLIC_ARRAY_REQUIRED', 'trip', trip.trip_id));
      var passengers = trip.passengers || [];
      passengers.forEach(function (passenger) {
        unknownKeys(passenger, ALLOWED.passenger).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'passenger', key)); });
        var timeKey = String(trip.date) + 'T' + String(trip.time);
        var personKey = String(passenger.public_id) + '|' + timeKey;
        if (passengerTimes[personKey]) issues.push(issue('PUBLIC_PASSENGER_TIME_CONFLICT', 'participant', passenger.public_id));
        passengerTimes[personKey] = true;
        if (['planned', 'confirmed', 'boarded', 'cancelled'].indexOf(passenger.boarding_status) < 0) issues.push(issue('PUBLIC_ENUM_INVALID', 'passenger', passenger.public_id));
      });
      if (number(trip.passenger_count, -1) !== passengers.length) issues.push(issue('PUBLIC_PASSENGER_COUNT_MISMATCH', 'trip', trip.trip_id));
      if (number(trip.remaining_seats, -1) !== number(trip.capacity, 0) - 1 - passengers.length || number(trip.remaining_seats, -1) < 0) {
        issues.push(issue('PUBLIC_REMAINING_SEATS_INVALID', 'trip', trip.trip_id));
      }
      if (trip.status === 'cancelled' && passengers.length) issues.push(issue('PUBLIC_CANCELLED_TRIP_HAS_PASSENGERS', 'trip', trip.trip_id));
      if (['IN', 'OUT'].indexOf(trip.direction) < 0) issues.push(issue('PUBLIC_ENUM_INVALID', 'trip', trip.trip_id));
      if (['open', 'confirmed', 'departed', 'arrived', 'cancelled'].indexOf(trip.status) < 0) issues.push(issue('PUBLIC_ENUM_INVALID', 'trip', trip.trip_id));
    });
    (snapshot.notices || []).forEach(function (row) { unknownKeys(row, ALLOWED.notice).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'notice', key)); }); });
    (snapshot.unassigned_summary || []).forEach(function (row) { unknownKeys(row, ALLOWED.unassigned).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'unassigned', key)); }); });
    if (snapshot.validation) {
      unknownKeys(snapshot.validation, ALLOWED.validation).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'validation', key)); });
      (snapshot.validation.warnings || []).forEach(function (row) { unknownKeys(row, ALLOWED.warning).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'warning', key)); }); });
      if (number(snapshot.validation.warning_count, -1) !== (snapshot.validation.warnings || []).reduce(function (sum, row) { return sum + number(row.count, 1); }, 0)) {
        issues.push(issue('PUBLIC_WARNING_COUNT_MISMATCH', 'validation', 'warning_count'));
      }
      if (snapshot.validation.status === 'ok' && number(snapshot.validation.blocking_error_count, 0) > 0) {
        issues.push(issue('PUBLIC_VALIDATION_STATUS_INVALID', 'validation', 'status'));
      }
      var warningCount = number(snapshot.validation.warning_count, 0);
      if (['ok', 'warning'].indexOf(snapshot.validation.status) < 0 ||
          (warningCount > 0 && snapshot.validation.status !== 'warning') ||
          (warningCount === 0 && snapshot.validation.status !== 'ok')) {
        issues.push(issue('PUBLIC_VALIDATION_STATUS_INVALID', 'validation', 'status'));
      }
    }
    scanPublicStrings(snapshot, '$', sensitiveValues || [], issues);
    return issues;
  }

  function blockingIssues(issues) {
    return (issues || []).filter(function (row) { return row.blocking !== false; });
  }

  function findBundleRelationConflicts(participants, relations) {
    var ids = {};
    (participants || []).forEach(function (row) { ids[String(row.participant_id)] = true; });
    var parent = {};
    Object.keys(ids).forEach(function (id) { parent[id] = id; });
    function find(id) { while (parent[id] !== id) { parent[id] = parent[parent[id]]; id = parent[id]; } return id; }
    function unite(a, b) { if (!parent[a] || !parent[b]) return; var ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; }
    (relations || []).filter(function (row) { return activeRow(row) && row.relation_type === 'must_together'; }).forEach(function (row) {
      unite(String(row.participant_a_id), String(row.participant_b_id));
    });
    return (relations || []).filter(function (row) {
      if (!activeRow(row) || row.relation_type !== 'must_separate') return false;
      var a = String(row.participant_a_id), b = String(row.participant_b_id);
      return parent[a] && parent[b] && find(a) === find(b);
    }).map(function (row) {
      return issue('RELATION_CONFLICT', 'relation', row.relation_id, 'must_together 묶음 내부에 must_separate 관계가 있습니다.');
    });
  }

  function runPublicationTransaction(candidate, adapter, sensitiveValues) {
    if (!candidate || !candidate.publish_id) throw new Error('candidate publish_id required');
    adapter.stage(candidate);
    var readback = adapter.read(candidate.publish_id);
    if (!readback || JSON.stringify(readback) !== JSON.stringify(candidate)) throw new Error('staged snapshot verification failed');
    var issues = validatePublicSnapshot(readback, sensitiveValues || []);
    if (blockingIssues(issues).length) throw new Error('staged snapshot validation failed');
    if (adapter.writeAudit) adapter.writeAudit(candidate.publish_id);
    adapter.switchPointer(candidate.publish_id); // 구현체는 단일 원자 쓰기여야 한다.
    return candidate.publish_id;
  }

  function aggregatePublicWarnings(issues) {
    var safeMessages = {
      UNASSIGNED_DEMAND: '배정되지 않은 이동 수요가 있습니다.',
      NO_COMPATIBLE_TRIP: '호환되는 운행을 찾지 못한 이동 수요가 있습니다.',
      ACCESSIBILITY_OR_CAPACITY_MISMATCH: '접근성 또는 좌석 조건을 확인해야 할 이동 수요가 있습니다.'
    };
    var counts = {};
    (issues || []).filter(function (row) { return row.blocking === false; }).forEach(function (row) {
      var code = safeMessages[row.rule_code] ? row.rule_code : 'OPERATION_REVIEW_REQUIRED';
      counts[code] = (counts[code] || 0) + 1;
    });
    return Object.keys(counts).sort().map(function (code) {
      return { rule_code: code, message: safeMessages[code] || '운영자 확인이 필요한 경고가 있습니다.', count: counts[code] };
    });
  }

  return {
    issue: issue,
    bool: bool,
    number: number,
    indexBy: indexBy,
    groupBy: groupBy,
    intervalsOverlap: intervalsOverlap,
    validateInternalModel: validateInternalModel,
    validatePublicSnapshot: validatePublicSnapshot,
    blockingIssues: blockingIssues,
    findBundleRelationConflicts: findBundleRelationConflicts,
    runPublicationTransaction: runPublicationTransaction,
    aggregatePublicWarnings: aggregatePublicWarnings
  };
}());

if (typeof module !== 'undefined' && module.exports) module.exports = CampCore;
