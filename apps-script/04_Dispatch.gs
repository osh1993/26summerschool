/** 기존 운행 후보(Trips)에 이동 수요를 배정한다. 차량/운행 자체는 운영자가 먼저 등록한다. */
function assignVehicleDemands() {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var data = readOperationalData_();
    var result = computeVehicleAssignments_(data);
    replaceAutomaticTripPassengers_(result.assignments);
    applyDemandStatuses_(result.demandStatuses);
    appendValidationIssues_(result.issues);
    SpreadsheetApp.getUi().alert('차량 자동 배정 ' + result.assignments.length + '건, 미배정/경고 ' + result.issues.length + '건입니다.');
  } finally {
    lock.releaseLock();
  }
}

function computeVehicleAssignments_(data) {
  var issues = [];
  var vehicles = CampCore.indexBy((data.vehicles || []).filter(function (row) { return CampCore.bool(row.active); }), 'vehicle_id');
  var trips = (data.trips || []).filter(function (row) { return ['draft', 'open', 'confirmed'].indexOf(String(row.trip_status)) >= 0; });
  var availabilityByVehicle = CampCore.groupBy(data.vehicleAvailability || [], 'vehicle_id');
  var preserved = (data.tripPassengers || []).filter(function (row) {
    return CampCore.bool(row.locked) || String(row.assignment_source) === 'manual';
  }).filter(function (row) { return ['cancelled', 'no_show'].indexOf(String(row.boarding_status)) < 0; });
  var assignments = [];
  var occupancy = {};
  var personTrips = {};
  trips.forEach(function (trip) { occupancy[String(trip.trip_id)] = []; });
  preserved.forEach(function (row) {
    if (occupancy[String(row.trip_id)]) occupancy[String(row.trip_id)].push(row);
    if (!personTrips[String(row.participant_id)]) personTrips[String(row.participant_id)] = [];
    var trip = trips.find(function (candidate) { return String(candidate.trip_id) === String(row.trip_id); });
    if (trip) personTrips[String(row.participant_id)].push(trip);
  });
  var alreadyAssignedDemand = preserved.reduce(function (map, row) { map[String(row.demand_id)] = true; return map; }, {});
  var demandStatuses = {};
  var demands = (data.travelDemands || []).filter(function (row) {
    return ['requested', 'unassigned'].indexOf(String(row.demand_status)) >= 0 && !alreadyAssignedDemand[String(row.demand_id)];
  });
  demands.sort(function (a, b) {
    var ap = String(a.priority) === 'accessibility' ? 0 : String(a.priority) === 'operational' ? 1 : 2;
    var bp = String(b.priority) === 'accessibility' ? 0 : String(b.priority) === 'operational' ? 1 : 2;
    return ap - bp || new Date(a.earliest_depart_at).getTime() - new Date(b.earliest_depart_at).getTime() || String(a.demand_id).localeCompare(String(b.demand_id));
  });

  demands.forEach(function (demand) {
    if (CampCore.number(demand.party_size, 1) !== 1) {
      issues.push(CampCore.issue('PARTY_SIZE_UNMODELED', 'demand', demand.demand_id, '동반자는 각각 참가자로 등록해야 합니다.'));
      demandStatuses[String(demand.demand_id)] = 'unassigned';
      return;
    }
    var candidates = trips.filter(function (trip) {
      var vehicle = vehicles[String(trip.vehicle_id)];
      if (!vehicle) return false;
      if (String(demand.direction) !== String(trip.direction) || String(demand.origin_location_id) !== String(trip.origin_location_id) || String(demand.destination_location_id) !== String(trip.destination_location_id)) return false;
      var depart = new Date(trip.depart_at).getTime();
      var earliest = new Date(demand.earliest_depart_at).getTime();
      var latest = new Date(demand.latest_depart_at).getTime();
      if ((Number.isFinite(earliest) && depart < earliest) || (Number.isFinite(latest) && depart > latest)) return false;
      if (String(demand.priority) === 'accessibility' && !CampCore.bool(vehicle.accessible)) return false;
      var availability = availabilityByVehicle[String(trip.vehicle_id)] || [];
      var available = availability.some(function (window) {
        return String(window.status || 'available') === 'available' &&
          new Date(window.available_from).getTime() <= new Date(trip.depart_at).getTime() &&
          new Date(window.available_to).getTime() >= new Date(trip.arrival_estimate).getTime() &&
          (!window.driver_participant_id || String(window.driver_participant_id) === String(trip.driver_participant_id));
      });
      if (!available) return false;
      var seatsUsed = (occupancy[String(trip.trip_id)] || []).reduce(function (sum, row) { return sum + CampCore.number(row.seat_count, 1); }, 0);
      if (seatsUsed + 1 + 1 > CampCore.number(vehicle.capacity_total, 0)) return false; // 새 승객 + 운전자
      return !(personTrips[String(demand.participant_id)] || []).some(function (other) {
        return CampCore.intervalsOverlap(trip.depart_at, trip.arrival_estimate, other.depart_at, other.arrival_estimate);
      });
    }).map(function (trip) {
      var vehicle = vehicles[String(trip.vehicle_id)];
      var used = (occupancy[String(trip.trip_id)] || []).reduce(function (sum, row) { return sum + CampCore.number(row.seat_count, 1); }, 0);
      return { trip: trip, remainingAfter: CampCore.number(vehicle.capacity_total, 0) - 1 - used - 1 };
    }).sort(function (a, b) {
      return a.remainingAfter - b.remainingAfter || new Date(a.trip.depart_at).getTime() - new Date(b.trip.depart_at).getTime();
    });
    if (!candidates.length) {
      var reason = String(demand.priority) === 'accessibility' ? 'ACCESSIBILITY_OR_CAPACITY_MISMATCH' : 'NO_COMPATIBLE_TRIP';
      issues.push(CampCore.issue(reason, 'demand', demand.demand_id, '호환되는 운행/좌석/가용시간이 없습니다.', false, 'warning'));
      demandStatuses[String(demand.demand_id)] = 'unassigned';
      return;
    }
    var chosen = candidates[0].trip;
    var assignment = {
      trip_passenger_id: 'tp_' + Utilities.getUuid().replace(/-/g, ''),
      trip_id: chosen.trip_id,
      participant_id: demand.participant_id,
      demand_id: demand.demand_id,
      boarding_status: 'planned',
      seat_count: 1,
      assignment_source: 'auto',
      locked: false,
      updated_at: nowIso_()
    };
    assignments.push(assignment);
    occupancy[String(chosen.trip_id)].push(assignment);
    if (!personTrips[String(demand.participant_id)]) personTrips[String(demand.participant_id)] = [];
    personTrips[String(demand.participant_id)].push(chosen);
    demandStatuses[String(demand.demand_id)] = 'confirmed';
  });
  return { assignments: assignments, demandStatuses: demandStatuses, issues: issues };
}

function replaceAutomaticTripPassengers_(newRows) {
  var sheet = getSheetRequired_(CAMP.SHEETS.TRIP_PASSENGERS);
  tableRows_(sheet).filter(function (row) {
    return !CampCore.bool(row.locked) && String(row.assignment_source) !== 'manual';
  }).sort(function (a, b) { return b._row - a._row; }).forEach(function (row) { sheet.deleteRow(row._row); });
  appendObjects_(CAMP.SHEETS.TRIP_PASSENGERS, newRows);
}

function applyDemandStatuses_(statusById) {
  var sheet = getSheetRequired_(CAMP.SHEETS.TRAVEL_DEMANDS);
  var columns = headerIndex_(sheet);
  tableRows_(sheet).forEach(function (row) {
    var status = statusById[String(row.demand_id)];
    if (status) sheet.getRange(row._row, columns.demand_status + 1).setValue(status);
  });
}
