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
    // v1 최상위 + v2 신규 time_slots. teachers/staff는 내부 스냅샷에서만 추가 허용.
    root: ['schema_version', 'event', 'generated_at', 'updated_at', 'publish_id', 'notices', 'groups', 'vehicles', 'trips', 'unassigned_summary', 'validation', 'time_slots'],
    rootInternal: ['teachers', 'staff'],
    event: ['event_id', 'name', 'starts_on', 'ends_on', 'timezone'],
    notice: ['notice_id', 'title', 'message', 'severity', 'starts_at', 'ends_at'],
    group: ['group_id', 'display_name', 'color', 'members'],
    // v2: campus/session_slots 추가. full_name은 내부 스냅샷에서만 추가 허용.
    member: ['public_id', 'public_name', 'role', 'campus', 'session_slots'],
    memberInternal: ['full_name'],
    timeSlot: ['slot_id', 'label', 'day_index', 'part'],
    personDirectory: ['participant_id', 'full_name', 'campus', 'group_id'],
    vehicle: ['vehicle_id', 'label', 'capacity', 'accessibility'],
    trip: ['trip_id', 'date', 'time', 'direction', 'origin', 'destination', 'meeting_point', 'status', 'vehicle_id', 'driver_label', 'capacity', 'passenger_count', 'remaining_seats', 'passengers', 'updated_at'],
    passenger: ['public_id', 'public_name', 'boarding_status'],
    unassigned: ['trip_window_id', 'direction', 'count', 'reason_code'],
    validation: ['status', 'blocking_error_count', 'warning_count', 'warnings'],
    warning: ['rule_code', 'message', 'count']
  });

  var MEMBER_ROLES = ['member', 'leader', 'sub_leader', 'teacher'];
  var SESSION_PARTS = ['morning', 'afternoon', 'night'];
  var PUBLIC_SCHEMA_VERSIONS = ['public-snapshot/v1', 'public-snapshot/v2'];
  var INTERNAL_SCHEMA_VERSION = 'internal-snapshot/v1';

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

  // 공개 표시명이 전체 실명과 동일하면 성 마스킹 실패로 간주한다(계약 공개 불변조건 #1).
  // publisher의 05_Validation과 scripts/validate-public-data.mjs가 재사용한다.
  function assertNoFullNames(snapshot, legalNames) {
    var issues = [];
    var names = {};
    (legalNames || []).forEach(function (n) {
      var trimmed = String(n == null ? '' : n).trim();
      if (trimmed) names[trimmed] = true;
    });
    if (!snapshot || typeof snapshot !== 'object') return issues;
    (snapshot.groups || []).forEach(function (group) {
      ((group && group.members) || []).forEach(function (member) {
        var display = String(member.public_name == null ? '' : member.public_name).trim();
        if (display && names[display]) {
          issues.push(issue('PUBLIC_FULL_NAME_LEAK', 'member', member.public_id, '공개 표시명이 전체 실명과 동일합니다(성 마스킹 필요).'));
        }
      });
    });
    return issues;
  }

  function validatePublicSnapshot(snapshot, sensitiveValues, legalNames) {
    return validateSnapshot_(snapshot, sensitiveValues, 'public', legalNames);
  }

  // 내부 스냅샷(internal-snapshot/v1) 검증. 공개 v2 구조 + member.full_name + 최상위 teachers[]/staff[].
  function validateInternalSnapshot(snapshot, sensitiveValues) {
    return validateSnapshot_(snapshot, sensitiveValues, 'internal', []);
  }

  function validateSnapshot_(snapshot, sensitiveValues, mode, legalNames) {
    var issues = [];
    var isInternal = mode === 'internal';
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [issue('PUBLIC_SCHEMA_INVALID', 'snapshot', '', '스냅샷이 객체가 아닙니다.')];
    var version = snapshot.schema_version;
    var isPublicV2 = !isInternal && version === 'public-snapshot/v2';
    var rootAllowed = isInternal ? ALLOWED.root.concat(ALLOWED.rootInternal) : ALLOWED.root;
    var memberAllowed = isInternal ? ALLOWED.member.concat(ALLOWED.memberInternal) : ALLOWED.member;

    unknownKeys(snapshot, rootAllowed).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'snapshot', key, '허용되지 않은 최상위 키입니다.')); });

    var requiredRoot = ['schema_version', 'event', 'generated_at', 'updated_at', 'publish_id', 'notices', 'groups', 'vehicles', 'trips', 'unassigned_summary', 'validation'];
    if (isPublicV2 || isInternal) requiredRoot = requiredRoot.concat('time_slots'); // v2/내부는 세션 정의 필수
    if (isInternal) requiredRoot = requiredRoot.concat(['teachers', 'staff']);
    requiredRoot.forEach(function (key) {
      if (snapshot[key] == null) issues.push(issue('PUBLIC_REQUIRED_FIELD_MISSING', 'snapshot', key, '필수 스냅샷 필드가 없습니다.'));
    });

    var versionOk = isInternal ? version === INTERNAL_SCHEMA_VERSION : PUBLIC_SCHEMA_VERSIONS.indexOf(version) >= 0;
    if (!versionOk) issues.push(issue('PUBLIC_SCHEMA_VERSION_INVALID', 'snapshot', 'schema_version', '지원하지 않는 스키마 버전입니다.'));
    if (snapshot.event) unknownKeys(snapshot.event, ALLOWED.event).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'event', key)); });
    var arrays = ['notices', 'groups', 'vehicles', 'trips', 'unassigned_summary'];
    arrays.forEach(function (key) { if (!Array.isArray(snapshot[key])) issues.push(issue('PUBLIC_ARRAY_REQUIRED', 'snapshot', key)); });

    // ── time_slots[] (v2 신규 최상위) ──
    var slotIds = {};
    var expectSlots = isPublicV2 || isInternal || snapshot.time_slots != null;
    if (expectSlots) {
      if (!Array.isArray(snapshot.time_slots)) {
        issues.push(issue('PUBLIC_ARRAY_REQUIRED', 'snapshot', 'time_slots'));
      } else {
        snapshot.time_slots.forEach(function (slot) {
          unknownKeys(slot, ALLOWED.timeSlot).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'time_slot', key)); });
          if (slot && slotIds[slot.slot_id]) issues.push(issue('PUBLIC_DUPLICATE_ID', 'time_slot', slot.slot_id));
          if (slot) slotIds[slot.slot_id] = true;
          var day = number(slot && slot.day_index, 0);
          if (!(day >= 1 && day <= 3)) issues.push(issue('PUBLIC_ENUM_INVALID', 'time_slot', slot && slot.slot_id, 'day_index는 1~3이어야 합니다.'));
          if (SESSION_PARTS.indexOf(String(slot && slot.part)) < 0) issues.push(issue('PUBLIC_ENUM_INVALID', 'time_slot', slot && slot.slot_id, 'part 값이 올바르지 않습니다.'));
        });
      }
    }
    var hasSlotCatalog = Object.keys(slotIds).length > 0;

    var publicGroups = {};
    var groupIds = {};
    (snapshot.groups || []).forEach(function (group) {
      unknownKeys(group, ALLOWED.group).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'group', key)); });
      if (groupIds[group.group_id]) issues.push(issue('PUBLIC_DUPLICATE_ID', 'group', group.group_id));
      groupIds[group.group_id] = true;
      (group.members || []).forEach(function (member) {
        unknownKeys(member, memberAllowed).forEach(function (key) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', 'member', key)); });
        if (member.role != null && MEMBER_ROLES.indexOf(String(member.role)) < 0) issues.push(issue('PUBLIC_ENUM_INVALID', 'member', member.public_id, 'role 값이 올바르지 않습니다.'));
        if (member.session_slots != null) {
          if (!Array.isArray(member.session_slots)) {
            issues.push(issue('PUBLIC_ARRAY_REQUIRED', 'member', member.public_id));
          } else if (hasSlotCatalog) {
            member.session_slots.forEach(function (sid) {
              if (!slotIds[sid]) issues.push(issue('PUBLIC_REFERENCE_BROKEN', 'member', member.public_id, 'session_slots가 존재하지 않는 slot_id를 참조합니다.'));
            });
          }
        }
        if (publicGroups[member.public_id]) issues.push(issue('PUBLIC_MULTIPLE_GROUPS', 'participant', member.public_id));
        publicGroups[member.public_id] = group.group_id;
      });
    });

    // ── teachers[]/staff[] (내부 스냅샷 전용) ──
    if (isInternal) {
      ['teachers', 'staff'].forEach(function (key) {
        if (snapshot[key] != null && !Array.isArray(snapshot[key])) { issues.push(issue('PUBLIC_ARRAY_REQUIRED', 'snapshot', key)); return; }
        (snapshot[key] || []).forEach(function (person) {
          unknownKeys(person, ALLOWED.personDirectory).forEach(function (col) { issues.push(issue('PUBLIC_FIELD_NOT_ALLOWED', key, col)); });
        });
      });
    }

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
    // 공개 불변조건: 표시명이 전체 실명과 같으면 실패(내부 스냅샷은 full_name 정상 노출이므로 제외).
    if (!isInternal) issues = issues.concat(assertNoFullNames(snapshot, legalNames || []));
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

  // ── 명단 가져오기(Roster Import) 순수 로직 ──────────────────────────────
  // 소스(엑셀/구글시트) 열기·시트 쓰기는 어댑터가 담당하고, 여기서는 매칭·upsert 계획만 결정한다.
  var ROSTER_PRIVATE_FIELDS = ['birth_date', 'phone', 'guardian_phone', 'insurance_status', 'private_note'];
  var ROSTER_PARTICIPANT_FIELDS = ['legal_name', 'person_type', 'campus', 'grade_band', 'gender', 'engagement_score', 'extraversion_score', 'newcomer', 'leader_candidate'];
  var ROSTER_MANAGED_FIELDS = ['campus', 'grade_band', 'gender', 'engagement_score', 'extraversion_score', 'newcomer', 'leader_candidate']; // update로 조건부 변경 가능(legal_name/person_type는 매칭 키라 불변)
  var ROSTER_BOOL_FIELDS = ['newcomer', 'leader_candidate'];

  function isBlank_(value) {
    return value == null || String(value).trim() === '';
  }

  function normalizeRosterName(name) {
    var text = String(name == null ? '' : name);
    if (typeof text.normalize === 'function') text = text.normalize('NFC');
    return text.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  // 명단에는 source_response_id가 없으므로 이름+구분+캠퍼스로 안정적 매칭 키를 만든다.
  function normalizeRosterKey(name, personType, campus) {
    return normalizeRosterName(name) + '|' + String(personType == null ? '' : personType).trim() + '|' + String(campus == null ? '' : campus).trim();
  }

  // 민감 필드는 구조적으로 Participant_Private로만 라우팅해 공개 후보 테이블 유입을 원천 차단한다.
  function routePrivateFields(row) {
    row = row || {};
    var participantFields = {}, privateFields = {};
    Object.keys(row).forEach(function (key) {
      if (key === 'free_text') return; // 아래에서 private_note로 흡수
      if (ROSTER_PRIVATE_FIELDS.indexOf(key) >= 0) privateFields[key] = row[key];
      else if (ROSTER_PARTICIPANT_FIELDS.indexOf(key) >= 0) participantFields[key] = row[key];
      // 매핑되지 않은 자유 헤더는 무시한다.
    });
    if (!isBlank_(row.free_text) && isBlank_(privateFields.private_note)) privateFields.private_note = row.free_text;
    return { participantFields: participantFields, privateFields: privateFields };
  }

  // 방어적 불변조건: 민감 필드가 참가자(공개 후보) 대상으로 전달되면 차단한다.
  function findRosterPrivateLeak(participantFields) {
    var leaks = [];
    Object.keys(participantFields || {}).forEach(function (key) {
      if (ROSTER_PRIVATE_FIELDS.indexOf(key) >= 0 || key === 'free_text') {
        leaks.push(issue('ROSTER_PRIVATE_FIELD_IN_PUBLIC', 'participant', key, '민감 필드가 공개 후보 테이블 대상으로 전달되었습니다.'));
      }
    });
    return leaks;
  }

  function rosterKeyOfParticipant_(participant) {
    return normalizeRosterKey(participant.legal_name, participant.person_type, participant.campus);
  }

  function buildRosterInsert_(key, routed, eventId) {
    var pf = routed.participantFields;
    return {
      key: key,
      participant: {
        participant_id: null, // 어댑터가 UUID 발급
        event_id: eventId || '',
        person_type: isBlank_(pf.person_type) ? 'student' : pf.person_type,
        legal_name: isBlank_(pf.legal_name) ? '' : pf.legal_name,
        public_id: null, // 어댑터가 행사별 난수 발급
        public_name: '', // 운영자 승인 전용
        public_consent: false, // 자동 TRUE 금지
        campus: isBlank_(pf.campus) ? '' : pf.campus,
        grade_band: isBlank_(pf.grade_band) ? '' : pf.grade_band,
        gender: isBlank_(pf.gender) ? '' : pf.gender,
        engagement_score: isBlank_(pf.engagement_score) ? 3 : pf.engagement_score,
        extraversion_score: isBlank_(pf.extraversion_score) ? 3 : pf.extraversion_score,
        newcomer: bool(pf.newcomer),
        leader_candidate: bool(pf.leader_candidate),
        active: true,
        source_response_id: 'roster_import:' + key, // 재실행 idempotent 앵커
        updated_at: null // 어댑터가 기록
      },
      private: buildRosterPrivate_(routed.privateFields)
    };
  }

  function buildRosterPrivate_(pv) {
    pv = pv || {};
    var out = {};
    ROSTER_PRIVATE_FIELDS.forEach(function (field) { if (!isBlank_(pv[field])) out[field] = pv[field]; });
    return out;
  }

  function buildRosterUpdate_(target, targetPrivate, routed, mode) {
    targetPrivate = targetPrivate || {};
    var setParticipant = {}, setPrivate = {}, changeLog = [], conflicts = [];

    ROSTER_MANAGED_FIELDS.forEach(function (field) {
      applyRosterField_(field, target[field], routed.participantFields[field], false, ROSTER_BOOL_FIELDS.indexOf(field) >= 0);
    });
    ROSTER_PRIVATE_FIELDS.forEach(function (field) {
      applyRosterField_(field, targetPrivate[field], routed.privateFields[field], true, false);
    });

    return {
      participant_id: target.participant_id,
      row: target._row,
      private_row: targetPrivate._row || null,
      setParticipant: setParticipant,
      setPrivate: setPrivate,
      changeLog: changeLog,
      conflicts: conflicts,
      changed: Object.keys(setParticipant).length > 0 || Object.keys(setPrivate).length > 0
    };

    function applyRosterField_(field, oldValue, newValue, isPrivate, isBool) {
      if (isBlank_(newValue)) return; // 빈 명단 값으로 기존 값을 지우지 않는다.
      var destination = isPrivate ? setPrivate : setParticipant;
      var same = isBool ? (bool(oldValue) === bool(newValue)) : (String(oldValue == null ? '' : oldValue) === String(newValue));
      if (isBlank_(oldValue)) {
        destination[field] = newValue; // 빈 칸 채움
        changeLog.push(rosterChange_(isPrivate, field, oldValue, newValue, 'roster fill'));
      } else if (!same) {
        if (mode === 'commit-overwrite') {
          destination[field] = newValue;
          changeLog.push(rosterChange_(isPrivate, field, oldValue, newValue, 'roster overwrite'));
        } else {
          conflicts.push({ field: field }); // 기본 commit: 보존하고 보고만
        }
      }
    }
  }

  function rosterChange_(isPrivate, field, oldValue, newValue, reason) {
    return {
      entity_type: isPrivate ? 'participant_private' : 'participant',
      field_name: field,
      old_value: isPrivate ? '[REDACTED]' : (oldValue == null ? '' : oldValue), // 민감값 원문은 Change_Log에 남기지 않는다.
      new_value: isPrivate ? '[REDACTED]' : newValue,
      reason: reason
    };
  }

  function planRosterUpsert(existingParticipants, existingPrivate, rosterRows, mappings, options) {
    options = options || {};
    var mode = options.mode || 'preview';
    var eventId = options.eventId || '';
    var maxRows = number(options.maxRows, 2000);
    var issues = [];
    var inserts = [], updates = [], conflicts = [], ambiguous = [], skipped = [], missingExisting = [];

    var activeMappings = (mappings || []).filter(function (m) { return m && !isBlank_(m.normalized_field); });
    if (!activeMappings.length) {
      issues.push(issue('ROSTER_NO_MAPPING', 'import', '', 'Roster_Import 활성 매핑이 없습니다.'));
      return summarize_();
    }
    var requiredFields = activeMappings.filter(function (m) { return bool(m.required); }).map(function (m) { return String(m.normalized_field).trim(); });

    var privById = indexBy(existingPrivate, 'participant_id');
    var bySource = {};
    (existingParticipants || []).forEach(function (p) { if (!isBlank_(p.source_response_id)) bySource[String(p.source_response_id)] = p; });
    var byKeyActive = {};
    (existingParticipants || []).forEach(function (p) {
      if (!activeRow(p)) return;
      var key = rosterKeyOfParticipant_(p);
      (byKeyActive[key] = byKeyActive[key] || []).push(p);
    });

    var totalRows = (rosterRows || []).length;
    if (totalRows > maxRows) {
      issues.push(issue('ROSTER_TOO_MANY_ROWS', 'import', '', '명단 행이 상한(' + maxRows + ')을 초과했습니다. 상한까지만 처리합니다.', false, 'warning'));
    }
    var rows = (rosterRows || []).slice(0, maxRows);

    var seenKeys = {};
    var matchedExisting = {};

    rows.forEach(function (entry) {
      var index = entry && entry.index != null ? entry.index : '';
      var fields = (entry && entry.fields) || {};
      var keys = Object.keys(fields);
      if (!keys.length || keys.every(function (k) { return isBlank_(fields[k]); })) {
        skipped.push({ index: index, reason: 'ROSTER_EMPTY_ROW_SKIPPED' });
        issues.push(issue('ROSTER_EMPTY_ROW_SKIPPED', 'roster_row', index, '빈 행을 건너뜁니다.', false, 'warning'));
        return;
      }
      var missing = requiredFields.filter(function (f) { return isBlank_(fields[f]); });
      if (missing.length) {
        skipped.push({ index: index, reason: 'ROSTER_REQUIRED_FIELD_MISSING' });
        issues.push(issue('ROSTER_REQUIRED_FIELD_MISSING', 'roster_row', index, '필수 필드 누락: ' + missing.join(',')));
        return;
      }
      var key = normalizeRosterKey(fields.legal_name, isBlank_(fields.person_type) ? 'student' : fields.person_type, fields.campus);
      if (seenKeys[key]) {
        skipped.push({ index: index, reason: 'ROSTER_DUPLICATE_IN_FILE' });
        issues.push(issue('ROSTER_DUPLICATE_IN_FILE', 'roster_row', index, '파일 내 중복 행을 건너뜁니다.', false, 'warning'));
        return;
      }
      seenKeys[key] = true;

      var routed = routePrivateFields(fields);
      var leak = findRosterPrivateLeak(routed.participantFields);
      if (leak.length) leak.forEach(function (row) { issues.push(row); });

      var target = bySource['roster_import:' + key];
      if (!target) {
        var candidates = byKeyActive[key] || [];
        if (candidates.length > 1) {
          ambiguous.push({ index: index, key: key, count: candidates.length });
          issues.push(issue('ROSTER_AMBIGUOUS_MATCH', 'roster_row', index, '동일 매칭 키의 기존 참가자가 여러 명입니다. 병합하지 않고 건너뜁니다.'));
          return;
        }
        target = candidates[0] || null;
      }

      if (!target) {
        inserts.push(buildRosterInsert_(key, routed, eventId));
        return;
      }
      matchedExisting[String(target.participant_id)] = true;
      var update = buildRosterUpdate_(target, privById[String(target.participant_id)], routed, mode);
      if (update.conflicts.length) {
        conflicts.push({ index: index, participant_id: target.participant_id, fields: update.conflicts.map(function (c) { return c.field; }) });
        update.conflicts.forEach(function (c) {
          issues.push(issue('ROSTER_FIELD_CONFLICT', 'participant', target.participant_id, '기존 값과 다른 명단 값을 보존했습니다: ' + c.field, false, 'warning'));
        });
      }
      if (update.changed) updates.push(update);
    });

    (existingParticipants || []).forEach(function (p) {
      if (!activeRow(p)) return;
      if (!matchedExisting[String(p.participant_id)]) {
        missingExisting.push({ participant_id: p.participant_id });
        issues.push(issue('ROSTER_MISSING_EXISTING', 'participant', p.participant_id, '명단에 없는 기존 활성 참가자입니다. 자동 비활성화하지 않습니다.', false, 'warning'));
      }
    });

    return summarize_();

    function summarize_() {
      return {
        inserts: inserts, updates: updates, conflicts: conflicts, ambiguous: ambiguous,
        skipped: skipped, missingExisting: missingExisting, issues: issues,
        summary: {
          insert: inserts.length, update: updates.length, conflict: conflicts.length,
          ambiguous: ambiguous.length, skip: skipped.length, missing_existing: missingExisting.length
        }
      };
    }
  }

  // ── 조편성 순수 로직 ──────────────────────────────────────────────────
  // 시트 I/O는 03_Grouping.gs가 담당하고, 균형 계산·제약 판정은 여기서 결정한다.
  // 자동 균형 대상은 학생(person_type==='student')만이며, 교사/부조장 등 수동 배정은 보존한다.
  var GROUP_MANUAL_ROLES = ['teacher', 'sub_leader']; // 자동 배정이 덮어쓰지 않고 보존해야 하는 역할

  function isStudent_(row) {
    return String(row && row.person_type != null ? row.person_type : 'student') === 'student';
  }

  // 균형 지표(참여도·외향성·캠퍼스·학년)는 학생 기준으로만 집계한다.
  function computeDistributionStats(participants) {
    var campus = {}, grade = {}, engagement = 0, extraversion = 0;
    (participants || []).forEach(function (row) {
      campus[String(row.campus || 'unknown')] = (campus[String(row.campus || 'unknown')] || 0) + 1;
      grade[String(row.grade_band || 'unknown')] = (grade[String(row.grade_band || 'unknown')] || 0) + 1;
      engagement += number(row.engagement_score, 3);
      extraversion += number(row.extraversion_score, 3);
    });
    var count = Math.max(1, (participants || []).length);
    return {
      count: count,
      campus: campus,
      grade: grade,
      engagementMean: engagement / count,
      extraversionMean: extraversion / count
    };
  }

  // 후보 조에 묶음을 넣었을 때의 증분 페널티. 낮을수록 균형에 유리하다.
  function incrementalGroupPenalty(candidate, bundle, global) {
    var members = candidate.members.concat(bundle);
    var students = members.filter(isStudent_); // 교사/스탭 등 수동 배정 인원은 균형 계산에서 제외
    var denom = Math.max(1, students.length);
    var target = number(candidate.group.target_size, 0);
    if (target <= 0) target = Math.ceil(global.count / Math.max(1, global.groupCount));
    var score = Math.abs(students.length - target) * 30;
    var engagement = students.reduce(function (sum, row) { return sum + number(row.engagement_score, 3); }, 0) / denom;
    score += Math.abs(engagement - global.engagementMean) * 12;
    var extraversion = students.reduce(function (sum, row) { return sum + number(row.extraversion_score, 3); }, 0) / denom;
    score += Math.abs(extraversion - global.extraversionMean) * 12; // 외향성 균형 축(참여도와 동일 가중치)
    ['campus', 'grade_band'].forEach(function (field) {
      var globalCounts = field === 'campus' ? global.campus : global.grade;
      Object.keys(globalCounts).forEach(function (value) {
        var localRatio = students.filter(function (row) { return String(row[field] || 'unknown') === value; }).length / denom;
        score += Math.abs(localRatio - globalCounts[value] / global.count) * 9;
      });
    });
    if (!students.some(function (row) { return bool(row.leader_candidate); })) score += 20;
    var newcomerTarget = 1;
    score += Math.abs(students.filter(function (row) { return bool(row.newcomer); }).length - newcomerTarget) * 12;
    return score;
  }

  function computeGroupProposal(data, options) {
    data = data || {};
    options = options || {};
    var counter = 0;
    var idFactory = options.idFactory || function () { counter += 1; return 'ga_' + counter; };
    var now = options.now || '';
    var updatedBy = options.updatedBy || 'operator';
    var issues = [];

    var groups = (data.groups || []).filter(function (row) { return bool(row.active); });
    if (!groups.length) return { assignments: [], issues: [issue('NO_ACTIVE_GROUP', 'group', '', '활성 조가 없습니다.')] };

    var attendanceByPerson = groupBy(data.attendance || [], 'participant_id');
    var useAttendance = (data.attendance || []).length > 0;
    function isPresent_(row) {
      if (!useAttendance) return true;
      return (attendanceByPerson[String(row.participant_id)] || []).some(function (slot) { return String(slot.presence_status) === 'present'; });
    }
    var activeParticipants = (data.participants || []).filter(function (row) { return bool(row.active) && isPresent_(row); });
    var students = activeParticipants.filter(isStudent_); // 자동 균형 대상은 학생만

    issues = issues.concat(findBundleRelationConflicts(students, data.relations || []));
    if (blockingIssues(issues).length) return { assignments: [], issues: issues };

    var byId = indexBy(activeParticipants, 'participant_id'); // 교사 포함(정원·역할 보존)

    // 잠금/수동/역할(teacher·sub_leader) 배정은 자동 편성이 덮어쓰지 않고 보존한다.
    var preserved = (data.groupAssignments || []).filter(function (row) {
      return bool(row.locked) || String(row.assignment_source) === 'manual' || GROUP_MANUAL_ROLES.indexOf(String(row.role)) >= 0;
    }).filter(function (row) { return byId[String(row.participant_id)]; });

    var state = {};
    groups.forEach(function (group) { state[String(group.group_id)] = { group: group, members: [], roles: {} }; });
    preserved.forEach(function (row) {
      var st = state[String(row.group_id)];
      if (!st) { issues.push(issue('LOCK_CONFLICT', 'assignment', row.assignment_id, '잠금/수동 배정의 조가 비활성입니다.')); return; }
      st.members.push(byId[String(row.participant_id)]);
      if (row.role) st.roles[String(row.role)] = (st.roles[String(row.role)] || 0) + 1;
    });

    // must_together 묶음(학생 대상) 구성
    var parent = {};
    students.forEach(function (row) { parent[String(row.participant_id)] = String(row.participant_id); });
    function find(id) { while (parent[id] !== id) { parent[id] = parent[parent[id]]; id = parent[id]; } return id; }
    function unite(a, b) { if (!parent[a] || !parent[b]) return; var ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; }
    (data.relations || []).filter(function (row) { return bool(row.active) && row.relation_type === 'must_together'; })
      .forEach(function (row) { unite(String(row.participant_a_id), String(row.participant_b_id)); });
    var bundles = {};
    students.forEach(function (row) { var root = find(String(row.participant_id)); if (!bundles[root]) bundles[root] = []; bundles[root].push(row); });

    var preservedByPerson = indexBy(preserved, 'participant_id');
    var separatePairs = {};
    (data.relations || []).filter(function (row) { return bool(row.active) && row.relation_type === 'must_separate'; }).forEach(function (row) {
      separatePairs[String(row.participant_a_id) + '|' + String(row.participant_b_id)] = true;
      separatePairs[String(row.participant_b_id) + '|' + String(row.participant_a_id)] = true;
    });

    var unassignedBundles = Object.keys(bundles).map(function (key) { return bundles[key]; });
    // 큰 묶음과 희소한 리더/새친구를 먼저 배정한다. ID 정렬로 재실행 결과를 결정적으로 만든다.
    unassignedBundles.sort(function (a, b) {
      var aPriority = a.length * 100 + a.filter(function (p) { return bool(p.leader_candidate) || bool(p.newcomer); }).length * 10;
      var bPriority = b.length * 100 + b.filter(function (p) { return bool(p.leader_candidate) || bool(p.newcomer); }).length * 10;
      return bPriority - aPriority || String(a[0].participant_id).localeCompare(String(b[0].participant_id));
    });

    var generated = [];
    var global = computeDistributionStats(students);
    global.groupCount = groups.length;

    unassignedBundles.forEach(function (bundle) {
      var existingGroups = bundle.map(function (p) { return preservedByPerson[String(p.participant_id)]; }).filter(Boolean).map(function (row) { return String(row.group_id); });
      var uniqueExisting = existingGroups.filter(function (id, index, list) { return list.indexOf(id) === index; });
      if (uniqueExisting.length > 1) {
        issues.push(issue('LOCK_CONFLICT', 'participant_bundle', bundle[0].participant_id, 'must_together 묶음이 서로 다른 수동 조에 고정되었습니다.'));
        return;
      }
      if (uniqueExisting.length === 1) {
        var fixedState = state[uniqueExisting[0]];
        var toAdd = bundle.filter(function (p) { return !preservedByPerson[String(p.participant_id)]; });
        if (fixedState.members.length + toAdd.length > number(fixedState.group.max_size, 999)) {
          issues.push(issue('GROUP_SIZE_EXCEEDED', 'group', fixedState.group.group_id, '고정 묶음으로 조 최대 인원을 초과합니다.'));
          return;
        }
        toAdd.forEach(function (p) { addGeneratedAssignment_(fixedState, p, 'MUST_TOGETHER_FIXED'); });
        return;
      }
      var candidates = groups.map(function (group) { return state[String(group.group_id)]; }).filter(function (candidate) {
        if (candidate.members.length + bundle.length > number(candidate.group.max_size, 999)) return false;
        return !bundle.some(function (person) {
          return candidate.members.some(function (member) { return separatePairs[String(person.participant_id) + '|' + String(member.participant_id)]; });
        });
      }).map(function (candidate) {
        return { state: candidate, score: incrementalGroupPenalty(candidate, bundle, global) };
      }).sort(function (a, b) { return a.score - b.score || String(a.state.group.group_id).localeCompare(String(b.state.group.group_id)); });
      if (!candidates.length) {
        issues.push(issue('CONSTRAINT_CONFLICT', 'participant_bundle', bundle[0].participant_id, '배치 가능한 조가 없습니다.'));
        return;
      }
      bundle.forEach(function (person) { addGeneratedAssignment_(candidates[0].state, person, 'BALANCED_GREEDY'); });
    });

    // 조당 조장 1 + 부조장 1 확보 우대: 없으면 경고 이슈(수동 지정 우선, 자동은 leader/member만 부여)
    groups.forEach(function (group) {
      var st = state[String(group.group_id)];
      if (!(st.roles['leader'] > 0)) issues.push(issue('GROUP_MISSING_LEADER', 'group', group.group_id, '조에 조장(leader)이 없습니다. 수동 지정을 검토하세요.', false, 'warning'));
      if (!(st.roles['sub_leader'] > 0)) issues.push(issue('GROUP_MISSING_SUBLEADER', 'group', group.group_id, '조에 부조장(sub_leader)이 없습니다. 수동 지정을 검토하세요.', false, 'warning'));
    });

    return { assignments: generated, issues: issues };

    function addGeneratedAssignment_(candidate, person, reason) {
      // 자동 배정은 학생에게 leader/member만 부여한다(teacher/sub_leader는 수동 배정 전용).
      var hasLeaderRole = (candidate.roles['leader'] || 0) > 0;
      var role = bool(person.leader_candidate) && !hasLeaderRole ? 'leader' : 'member';
      candidate.members.push(person);
      candidate.roles[role] = (candidate.roles[role] || 0) + 1;
      generated.push({
        assignment_id: idFactory(),
        participant_id: person.participant_id,
        group_id: candidate.group.group_id,
        role: role,
        locked: false,
        assignment_source: 'auto',
        score_delta: '',
        reason_codes: reason,
        revision: 1,
        updated_at: now,
        updated_by: updatedBy
      });
    }
  }

  // ── 성 마스킹(공개 표시명) ────────────────────────────────────────────
  // 복성 예외목록: 첫 2글자를 성으로 본다.
  var COMPOUND_SURNAMES = ['남궁', '황보', '선우', '제갈', '독고', '사공', '서문', '동방', '어금', '망절'];

  function maskSurname(legalName) {
    var raw = String(legalName == null ? '' : legalName);
    if (typeof raw.normalize === 'function') raw = raw.normalize('NFC');
    var trimmed = raw.trim();
    var name = trimmed.replace(/\s+/g, '');
    if (!name) return '';
    // 비한글(영문 등)·공백 포함 이름: 첫 토큰 + '*' 폴백. 이름 전체 노출 금지.
    if (!/^[가-힣]+$/.test(name)) {
      var token = trimmed.split(/\s+/)[0] || '';
      return token ? token + '*' : '*';
    }
    var surnameLen = (name.length >= 3 && COMPOUND_SURNAMES.indexOf(name.slice(0, 2)) >= 0) ? 2 : 1;
    if (name.length <= surnameLen) return name + '*'; // 한 글자 이름 등
    var masked = '';
    for (var i = surnameLen; i < name.length; i += 1) masked += '○';
    return name.slice(0, surnameLen) + masked;
  }

  // ── 내부 인증 검증(순수) ──────────────────────────────────────────────
  // password를 주입된 해시함수로 해시 후 저장 해시와 상수시간 비교하고, user 일치까지 확인한다.
  function constantTimeEquals_(a, b) {
    a = String(a == null ? '' : a);
    b = String(b == null ? '' : b);
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i += 1) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
    return diff === 0;
  }

  function verifyInternalCredential(user, password, storedUser, storedPwHash, sha256hex) {
    if (typeof sha256hex !== 'function') return false;
    if (isBlank_(storedUser) || isBlank_(storedPwHash)) return false;
    if (isBlank_(user) || password == null) return false;
    var computed = String(sha256hex(String(password)) || '').trim().toLowerCase();
    var stored = String(storedPwHash).trim().toLowerCase();
    // 상수시간 비교 두 항목을 모두 계산한 뒤 AND(단락 평가로 인한 타이밍 누출 완화).
    var userOk = constantTimeEquals_(String(user), String(storedUser));
    var pwOk = constantTimeEquals_(computed, stored);
    return userOk && pwOk;
  }

  // ── 세션(프로그램 시간대) 표시 헬퍼 ───────────────────────────────────
  var SESSION_PART_LABELS = { morning: '오전', afternoon: '오후', night: '밤' };
  var STANDARD_SESSION_DEFS = [
    { day_index: 1, part: 'morning' }, { day_index: 1, part: 'afternoon' }, { day_index: 1, part: 'night' },
    { day_index: 2, part: 'morning' }, { day_index: 2, part: 'afternoon' }, { day_index: 2, part: 'night' },
    { day_index: 3, part: 'morning' }
  ];

  function sessionPartLabel(part) {
    return SESSION_PART_LABELS[String(part)] || '';
  }

  // 참가자의 present 세션 slot_id 배열을 산출한다. participantId가 주어지면 해당 참가자만 필터한다.
  function presentSlotIds(attendanceRows, participantId) {
    return (attendanceRows || []).filter(function (row) {
      if (participantId != null && String(row.participant_id) !== String(participantId)) return false;
      return String(row.presence_status) === 'present';
    }).map(function (row) { return String(row.slot_id); });
  }

  // 표준 7세션 시드(첫날 오전/오후/밤, 2일 오전/오후/밤, 3일 오전). 시트 헤더 키와 일치하는 객체 배열.
  function buildStandardTimeSlots(eventId) {
    return STANDARD_SESSION_DEFS.map(function (def) {
      return {
        slot_id: 'S_D' + def.day_index + '_' + def.part.toUpperCase(),
        event_id: eventId || '',
        label: def.day_index + '일차 ' + sessionPartLabel(def.part),
        starts_at: '',
        ends_at: '',
        core_program: true,
        day_index: def.day_index,
        part: def.part
      };
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
    validateInternalSnapshot: validateInternalSnapshot,
    assertNoFullNames: assertNoFullNames,
    blockingIssues: blockingIssues,
    findBundleRelationConflicts: findBundleRelationConflicts,
    runPublicationTransaction: runPublicationTransaction,
    aggregatePublicWarnings: aggregatePublicWarnings,
    normalizeRosterKey: normalizeRosterKey,
    routePrivateFields: routePrivateFields,
    findRosterPrivateLeak: findRosterPrivateLeak,
    planRosterUpsert: planRosterUpsert,
    computeDistributionStats: computeDistributionStats,
    incrementalGroupPenalty: incrementalGroupPenalty,
    computeGroupProposal: computeGroupProposal,
    maskSurname: maskSurname,
    verifyInternalCredential: verifyInternalCredential,
    sessionPartLabel: sessionPartLabel,
    presentSlotIds: presentSlotIds,
    buildStandardTimeSlots: buildStandardTimeSlots
  };
}());

if (typeof module !== 'undefined' && module.exports) module.exports = CampCore;
