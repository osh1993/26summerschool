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

// 순수 균형·제약 로직은 CampCore.computeGroupProposal에 있다(학생만 자동 배정, 외향성 균형 축, 부조장 경고).
// 여기서는 비순수 의존(UUID·시간·실행자)만 주입한다.
function computeGroupProposal_(data) {
  return CampCore.computeGroupProposal(data, {
    idFactory: function () { return 'ga_' + Utilities.getUuid().replace(/-/g, ''); },
    now: nowIso_(),
    updatedBy: Session.getEffectiveUser().getEmail() || 'operator'
  });
}

function replaceAutomaticGroupAssignments_(newRows) {
  var sheet = getSheetRequired_(CAMP.SHEETS.GROUP_ASSIGNMENTS);
  // 자동(auto) 배정만 교체하고, 잠금·수동·역할(teacher/sub_leader) 배정은 보존한다.
  var rows = tableRows_(sheet).filter(function (row) {
    return !CampCore.bool(row.locked) &&
      String(row.assignment_source) !== 'manual' &&
      ['teacher', 'sub_leader'].indexOf(String(row.role)) < 0;
  });
  rows.sort(function (a, b) { return b._row - a._row; }).forEach(function (row) { sheet.deleteRow(row._row); });
  appendObjects_(CAMP.SHEETS.GROUP_ASSIGNMENTS, newRows);
}
