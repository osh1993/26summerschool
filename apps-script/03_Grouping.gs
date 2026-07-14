/** 잠금/수동 배정을 보존하고 나머지 참가자의 균형 조편성을 제안한다. */
function proposeGroupAssignments() {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var data = readOperationalData_();
    var result = computeGroupProposal_(data);
    if (result.issues.some(function (row) { return row.blocking; })) {
      appendValidationIssues_(result.issues);
      SpreadsheetApp.getUi().alert('조편성 제약 충돌로 저장하지 않았습니다. Validation 탭을 확인하세요.');
      return;
    }
    replaceAutomaticGroupAssignments_(result.assignments);
    appendValidationIssues_(result.issues);
    SpreadsheetApp.getUi().alert('자동 조편성 ' + result.assignments.length + '건을 저장했습니다. 잠금/수동 배정은 유지되었습니다.');
  } finally {
    lock.releaseLock();
  }
}

function computeGroupProposal_(data) {
  var issues = [];
  var groups = (data.groups || []).filter(function (row) { return CampCore.bool(row.active); });
  if (!groups.length) return { assignments: [], issues: [CampCore.issue('NO_ACTIVE_GROUP', 'group', '', '활성 조가 없습니다.')] };
  var attendanceByPerson = CampCore.groupBy(data.attendance || [], 'participant_id');
  var useAttendance = (data.attendance || []).length > 0;
  var participants = (data.participants || []).filter(function (row) {
    if (!CampCore.bool(row.active)) return false;
    if (!useAttendance) return true;
    return (attendanceByPerson[String(row.participant_id)] || []).some(function (slot) { return String(slot.presence_status) === 'present'; });
  });
  issues = issues.concat(CampCore.findBundleRelationConflicts(participants, data.relations || []));
  if (CampCore.blockingIssues(issues).length) return { assignments: [], issues: issues };
  var byId = CampCore.indexBy(participants, 'participant_id');
  var preserved = (data.groupAssignments || []).filter(function (row) {
    return CampCore.bool(row.locked) || String(row.assignment_source) === 'manual';
  }).filter(function (row) { return byId[String(row.participant_id)]; });
  var state = {};
  groups.forEach(function (group) { state[String(group.group_id)] = { group: group, members: [] }; });
  preserved.forEach(function (row) {
    if (!state[String(row.group_id)]) issues.push(CampCore.issue('LOCK_CONFLICT', 'assignment', row.assignment_id, '잠금/수동 배정의 조가 비활성입니다.'));
    else state[String(row.group_id)].members.push(byId[String(row.participant_id)]);
  });

  var parent = {};
  participants.forEach(function (row) { parent[String(row.participant_id)] = String(row.participant_id); });
  function find(id) { while (parent[id] !== id) { parent[id] = parent[parent[id]]; id = parent[id]; } return id; }
  function unite(a, b) { if (!parent[a] || !parent[b]) return; var ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; }
  (data.relations || []).filter(function (row) { return CampCore.bool(row.active) && row.relation_type === 'must_together'; })
    .forEach(function (row) { unite(String(row.participant_a_id), String(row.participant_b_id)); });
  var bundles = {};
  participants.forEach(function (row) { var root = find(String(row.participant_id)); if (!bundles[root]) bundles[root] = []; bundles[root].push(row); });
  var preservedByPerson = CampCore.indexBy(preserved, 'participant_id');
  var separatePairs = {};
  (data.relations || []).filter(function (row) { return CampCore.bool(row.active) && row.relation_type === 'must_separate'; }).forEach(function (row) {
    separatePairs[String(row.participant_a_id) + '|' + String(row.participant_b_id)] = true;
    separatePairs[String(row.participant_b_id) + '|' + String(row.participant_a_id)] = true;
  });
  var unassignedBundles = Object.keys(bundles).map(function (key) { return bundles[key]; });
  // 큰 묶음과 희소한 리더/새친구를 먼저 배정한다. ID 정렬로 재실행 결과를 결정적으로 만든다.
  unassignedBundles.sort(function (a, b) {
    var aPriority = a.length * 100 + a.filter(function (p) { return CampCore.bool(p.leader_candidate) || CampCore.bool(p.newcomer); }).length * 10;
    var bPriority = b.length * 100 + b.filter(function (p) { return CampCore.bool(p.leader_candidate) || CampCore.bool(p.newcomer); }).length * 10;
    return bPriority - aPriority || String(a[0].participant_id).localeCompare(String(b[0].participant_id));
  });
  var generated = [];
  var global = distributionStats_(participants);
  global.groupCount = groups.length;

  unassignedBundles.forEach(function (bundle) {
    var existingGroups = bundle.map(function (p) { return preservedByPerson[String(p.participant_id)]; }).filter(Boolean).map(function (row) { return String(row.group_id); });
    var uniqueExisting = existingGroups.filter(function (id, index, list) { return list.indexOf(id) === index; });
    if (uniqueExisting.length > 1) {
      issues.push(CampCore.issue('LOCK_CONFLICT', 'participant_bundle', bundle[0].participant_id, 'must_together 묶음이 서로 다른 수동 조에 고정되었습니다.'));
      return;
    }
    if (uniqueExisting.length === 1) {
      var fixedState = state[uniqueExisting[0]];
      if (fixedState.members.length + bundle.filter(function (p) { return !preservedByPerson[String(p.participant_id)]; }).length > CampCore.number(fixedState.group.max_size, 999)) {
        issues.push(CampCore.issue('GROUP_SIZE_EXCEEDED', 'group', fixedState.group.group_id, '고정 묶음으로 조 최대 인원을 초과합니다.'));
        return;
      }
      bundle.forEach(function (p) {
        if (!preservedByPerson[String(p.participant_id)]) addGeneratedAssignment_(generated, fixedState, p, 'MUST_TOGETHER_FIXED');
      });
      return;
    }
    var candidates = groups.map(function (group) { return state[String(group.group_id)]; }).filter(function (candidate) {
      if (candidate.members.length + bundle.length > CampCore.number(candidate.group.max_size, 999)) return false;
      return !bundle.some(function (person) {
        return candidate.members.some(function (member) { return separatePairs[String(person.participant_id) + '|' + String(member.participant_id)]; });
      });
    }).map(function (candidate) {
      return { state: candidate, score: incrementalGroupPenalty_(candidate, bundle, global) };
    }).sort(function (a, b) { return a.score - b.score || String(a.state.group.group_id).localeCompare(String(b.state.group.group_id)); });
    if (!candidates.length) {
      issues.push(CampCore.issue('CONSTRAINT_CONFLICT', 'participant_bundle', bundle[0].participant_id, '배치 가능한 조가 없습니다.'));
      return;
    }
    bundle.forEach(function (person) { addGeneratedAssignment_(generated, candidates[0].state, person, 'BALANCED_GREEDY'); });
  });
  return { assignments: generated, issues: issues };
}

function distributionStats_(participants) {
  var campus = {}, grade = {}, engagement = 0;
  participants.forEach(function (row) {
    campus[String(row.campus || 'unknown')] = (campus[String(row.campus || 'unknown')] || 0) + 1;
    grade[String(row.grade_band || 'unknown')] = (grade[String(row.grade_band || 'unknown')] || 0) + 1;
    engagement += CampCore.number(row.engagement_score, 3);
  });
  return { count: Math.max(1, participants.length), campus: campus, grade: grade, engagementMean: engagement / Math.max(1, participants.length) };
}

function incrementalGroupPenalty_(candidate, bundle, global) {
  var members = candidate.members.concat(bundle);
  var target = CampCore.number(candidate.group.target_size, 0);
  if (target <= 0) target = Math.ceil(global.count / Math.max(1, global.groupCount));
  var score = Math.abs(members.length - target) * 30;
  var engagement = members.reduce(function (sum, row) { return sum + CampCore.number(row.engagement_score, 3); }, 0) / Math.max(1, members.length);
  score += Math.abs(engagement - global.engagementMean) * 12;
  ['campus', 'grade_band'].forEach(function (field) {
    var globalCounts = field === 'campus' ? global.campus : global.grade;
    Object.keys(globalCounts).forEach(function (value) {
      var localRatio = members.filter(function (row) { return String(row[field] || 'unknown') === value; }).length / Math.max(1, members.length);
      score += Math.abs(localRatio - globalCounts[value] / global.count) * 9;
    });
  });
  if (!members.some(function (row) { return CampCore.bool(row.leader_candidate); })) score += 20;
  var newcomerTarget = 1;
  score += Math.abs(members.filter(function (row) { return CampCore.bool(row.newcomer); }).length - newcomerTarget) * 12;
  return score;
}

function addGeneratedAssignment_(generated, candidate, person, reason) {
  var hasLeader = candidate.members.some(function (row) { return CampCore.bool(row.leader_candidate); });
  var role = CampCore.bool(person.leader_candidate) && !hasLeader ? 'leader' : 'member';
  candidate.members.push(person);
  generated.push({
    assignment_id: 'ga_' + Utilities.getUuid().replace(/-/g, ''),
    participant_id: person.participant_id,
    group_id: candidate.group.group_id,
    role: role,
    locked: false,
    assignment_source: 'auto',
    score_delta: '',
    reason_codes: reason,
    revision: 1,
    updated_at: nowIso_(),
    updated_by: Session.getEffectiveUser().getEmail() || 'operator'
  });
}

function replaceAutomaticGroupAssignments_(newRows) {
  var sheet = getSheetRequired_(CAMP.SHEETS.GROUP_ASSIGNMENTS);
  var rows = tableRows_(sheet).filter(function (row) { return !CampCore.bool(row.locked) && String(row.assignment_source) !== 'manual'; });
  rows.sort(function (a, b) { return b._row - a._row; }).forEach(function (row) { sheet.deleteRow(row._row); });
  appendObjects_(CAMP.SHEETS.GROUP_ASSIGNMENTS, newRows);
}
