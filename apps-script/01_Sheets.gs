/** 시트 메뉴와 초기 구조를 만든다. 기존 원본 응답 탭의 데이터는 지우지 않는다. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('수련회 운영')
    .addItem('1. 운영 시트 초기화', 'initializeCampWorkbook')
    .addSeparator()
    .addItem('2. Form 응답 증분 동기화', 'syncFormResponsesIncremental')
    .addItem('2-1. 명단 파일 가져오기(미리보기)', 'importRosterPreview')
    .addItem('2-2. 명단 가져오기 반영', 'importRosterCommit')
    .addItem('3. 조편성 제안', 'proposeGroupAssignments')
    .addItem('3-1. 조 개수 맞추기(Settings 기준)', 'ensureGroupCountFromSettings')
    .addItem('3-2. 표준 세션(7슬롯) 시드', 'seedStandardTimeSlots')
    .addItem('4. 차량 수요 배정', 'assignVehicleDemands')
    .addSeparator()
    .addItem('5. 게시 전 검증', 'validateBeforePublish')
    .addItem('6. 공개 스냅샷 게시', 'publishPublicSnapshot')
    .addToUi();
}

function initializeCampWorkbook() {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var spreadsheet = campSpreadsheet_();
    Object.keys(CAMP.HEADERS).forEach(function (sheetName) {
      var sheet = spreadsheet.getSheetByName(sheetName);
      if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
      var headers = CAMP.HEADERS[sheetName];
      if (!headers.length) return; // Form 원본 탭은 Form이 헤더를 소유한다.
      ensureHeaders_(sheet, headers);
    });
    seedSettings_();
    seedLookups_();
    seedGroups_();
    seedTimeSlots_();
    formatOperationalSheets_();
    SpreadsheetApp.getUi().alert('운영 시트 초기화가 완료되었습니다. Settings와 Form_Field_Map을 먼저 확인하세요.');
  } finally {
    lock.releaseLock();
  }
}

function seedGroups_() {
  var sheet = getSheetRequired_(CAMP.SHEETS.GROUPS);
  if (sheet.getLastRow() > 1) return;
  var settings = getSettings_();
  var count = Math.max(1, Number(settings.GROUP_COUNT || 6));
  var colors = ['#2563EB', '#DC2626', '#16A34A', '#9333EA', '#EA580C', '#0891B2', '#4F46E5', '#BE123C'];
  var rows = [];
  for (var i = 1; i <= count; i += 1) {
    rows.push(['G' + String(i).padStart(2, '0'), settings.EVENT_ID, i + '조', colors[(i - 1) % colors.length], '', 0, 999, true]);
  }
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

/** 표준 7세션(첫날 오전/오후/밤, 2일 오전/오후/밤, 3일 오전)을 Time_Slots에 멱등 시드한다. 이미 있으면 중복 생성하지 않는다. */
function seedTimeSlots_() {
  var sheet = getSheetRequired_(CAMP.SHEETS.TIME_SLOTS);
  var settings = getSettings_();
  var eventId = settings.EVENT_ID || CAMP.DEFAULT_SETTINGS.EVENT_ID;
  var existing = tableRows_(sheet).reduce(function (map, row) {
    if (!isBlankValue_(row.slot_id)) map[String(row.slot_id)] = true;
    return map;
  }, {});
  var seeds = CampCore.buildStandardTimeSlots(eventId).filter(function (slot) { return !existing[slot.slot_id]; });
  if (seeds.length) appendObjects_(CAMP.SHEETS.TIME_SLOTS, seeds);
  return seeds.length;
}

/** 메뉴: 표준 세션 시드(멱등). */
function seedStandardTimeSlots() {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var added = seedTimeSlots_();
    SpreadsheetApp.getUi().alert(added > 0 ? ('표준 세션 ' + added + '개를 추가했습니다.') : '표준 세션이 이미 모두 존재합니다(추가 없음).');
  } finally {
    lock.releaseLock();
  }
}

/**
 * 메뉴: Settings.GROUP_COUNT(권위값)에 맞춰 Groups 활성 행을 N개로 맞춘다.
 * 기존 조의 이름·색·정원은 보존한다. 부족하면 비활성 조 재활성화 후 신규 생성,
 * 초과하면 배정이 없는 여분 조만 비활성화하고 배정이 있는 조는 보존/경고한다.
 */
function ensureGroupCountFromSettings() {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var settings = getSettings_();
    var target = Math.max(1, Number(settings.GROUP_COUNT || 6));
    var sheet = getSheetRequired_(CAMP.SHEETS.GROUPS);
    var idx = headerIndex_(sheet);
    var rows = tableRows_(sheet);
    var active = rows.filter(function (row) { return CampCore.bool(row.active); });
    var inactive = rows.filter(function (row) { return !CampCore.bool(row.active); });
    var messages = [];

    if (active.length < target) {
      var need = target - active.length;
      var reactivate = inactive.slice(0, need);
      reactivate.forEach(function (row) { sheet.getRange(row._row, idx.active + 1).setValue(true); });
      need -= reactivate.length;
      if (need > 0) {
        var newRows = buildNewGroupRows_(rows, need, settings.EVENT_ID || CAMP.DEFAULT_SETTINGS.EVENT_ID);
        appendObjects_(CAMP.SHEETS.GROUPS, newRows);
      }
      messages.push('활성 조를 ' + target + '개로 맞췄습니다(재활성화 ' + reactivate.length + ' / 신규 ' + Math.max(0, need) + ').');
    } else if (active.length > target) {
      var assignmentsByGroup = CampCore.groupBy(tableRows_(getSheetRequired_(CAMP.SHEETS.GROUP_ASSIGNMENTS)), 'group_id');
      // 조 번호 역순으로 여분을 비활성화 후보로 본다. 배정이 있는 조는 건너뛴다.
      var ordered = active.slice().sort(function (a, b) { return String(b.group_id).localeCompare(String(a.group_id)); });
      var toRemove = active.length - target;
      var deactivated = 0, blockedByAssignment = 0;
      ordered.forEach(function (row) {
        if (deactivated >= toRemove) return;
        var hasAssignments = (assignmentsByGroup[String(row.group_id)] || []).length > 0;
        if (hasAssignments) { blockedByAssignment += 1; return; }
        sheet.getRange(row._row, idx.active + 1).setValue(false);
        deactivated += 1;
      });
      messages.push('여분 조 ' + deactivated + '개를 비활성화했습니다.');
      if (blockedByAssignment > 0) messages.push('배정이 남은 조 ' + blockedByAssignment + '개는 보존했습니다. 수동으로 정리한 뒤 다시 실행하세요.');
    } else {
      messages.push('활성 조가 이미 ' + target + '개입니다(변경 없음).');
    }
    SpreadsheetApp.getUi().alert(messages.join('\n'));
  } finally {
    lock.releaseLock();
  }
}

/** 기존 조 번호와 겹치지 않는 신규 조 행을 생성한다. 이름·색은 기본 규칙을 따른다. */
function buildNewGroupRows_(existingRows, count, eventId) {
  var colors = ['#2563EB', '#DC2626', '#16A34A', '#9333EA', '#EA580C', '#0891B2', '#4F46E5', '#BE123C'];
  var maxNumber = 0;
  existingRows.forEach(function (row) {
    var match = String(row.group_id || '').match(/(\d+)/);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
    var nameMatch = String(row.display_name || '').match(/(\d+)/);
    if (nameMatch) maxNumber = Math.max(maxNumber, Number(nameMatch[1]));
  });
  var rows = [];
  for (var i = 1; i <= count; i += 1) {
    var n = maxNumber + i;
    rows.push({
      group_id: 'G' + String(n).padStart(2, '0'),
      event_id: eventId,
      display_name: n + '조',
      color: colors[(n - 1) % colors.length],
      target_size: '',
      min_size: 0,
      max_size: 999,
      active: true
    });
  }
  return rows;
}

function isBlankValue_(value) {
  return value == null || String(value).trim() === '';
}

function ensureHeaders_(sheet, expectedHeaders) {
  if (!expectedHeaders.length) return;
  var existingColumnCount = sheet.getLastColumn();
  var current = existingColumnCount ? sheet.getRange(1, 1, 1, existingColumnCount).getDisplayValues()[0] : [];
  var hasAny = current.some(function (value) { return value !== ''; });
  if (!hasAny) {
    // 신규 시트: 전체 헤더 기록.
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, expectedHeaders.length).setFontWeight('bold').setBackground('#E8F0FE');
    return;
  }
  // 겹치는 열은 반드시 계약과 일치해야 한다(기존 데이터 열 정렬 보존).
  var overlap = Math.min(current.length, expectedHeaders.length);
  for (var i = 0; i < overlap; i += 1) {
    if (String(current[i]) !== String(expectedHeaders[i])) {
      throw new Error(sheet.getName() + ' 헤더가 계약과 다릅니다(열 ' + (i + 1) + '). 기존 데이터를 보존하기 위해 초기화를 중단했습니다.');
    }
  }
  // 계약에 추가된 후행 신규 열은 기존 데이터를 지우지 않고 헤더만 append(마이그레이션).
  if (current.length < expectedHeaders.length) {
    var appendCount = expectedHeaders.length - current.length;
    sheet.getRange(1, current.length + 1, 1, appendCount).setValues([expectedHeaders.slice(current.length)]);
    sheet.getRange(1, current.length + 1, 1, appendCount).setFontWeight('bold').setBackground('#E8F0FE');
  }
  // current.length > expectedHeaders.length(운영자 추가 열)은 허용한다.
  sheet.setFrozenRows(1);
}

function seedSettings_() {
  var sheet = getSheetRequired_(CAMP.SHEETS.SETTINGS);
  var existing = tableRows_(sheet).reduce(function (map, row) {
    map[row.key] = true;
    return map;
  }, {});
  var rows = [];
  Object.keys(CAMP.DEFAULT_SETTINGS).forEach(function (key) {
    if (!existing[key]) rows.push([key, CAMP.DEFAULT_SETTINGS[key], 'string', '운영 설정']);
  });
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
}

function seedLookups_() {
  var sheet = getSheetRequired_(CAMP.SHEETS.LOOKUPS);
  if (sheet.getLastRow() > 1) return;
  var rows = [
    ['person_type', 'student', '학생', 1, true], ['person_type', 'teacher', '교사', 2, true], ['person_type', 'staff', '스탭', 3, true],
    ['role', 'member', '조원', 1, true], ['role', 'leader', '조장', 2, true], ['role', 'sub_leader', '부조장', 3, true], ['role', 'teacher', '조선생님', 4, true],
    ['part', 'morning', '오전', 1, true], ['part', 'afternoon', '오후', 2, true], ['part', 'night', '밤', 3, true],
    ['direction', 'IN', '광주→수련회장', 1, true], ['direction', 'OUT', '수련회장→광주', 2, true],
    ['boarding_status', 'planned', '예정', 1, true], ['boarding_status', 'confirmed', '확정', 2, true], ['boarding_status', 'boarded', '탑승', 3, true], ['boarding_status', 'cancelled', '취소', 4, true],
    ['trip_status', 'draft', '초안', 1, true], ['trip_status', 'open', '모집', 2, true], ['trip_status', 'confirmed', '확정', 3, true], ['trip_status', 'cancelled', '취소', 4, true]
  ];
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function formatOperationalSheets_() {
  var spreadsheet = campSpreadsheet_();
  Object.keys(CAMP.HEADERS).forEach(function (name) {
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet || !CAMP.HEADERS[name].length) return;
    sheet.autoResizeColumns(1, Math.min(CAMP.HEADERS[name].length, 8));
    sheet.setFrozenRows(1);
  });
}

function getSheetRequired_(name) {
  var sheet = campSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error(name + ' 시트가 없습니다. 먼저 운영 시트 초기화를 실행하세요.');
  return sheet;
}

function headerIndex_(sheet) {
  if (sheet.getLastColumn() < 1) return {};
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
    .reduce(function (map, value, index) {
      if (value) map[String(value).trim()] = index;
      return map;
    }, {});
}

function tableRows_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];
  var headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  return sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues().map(function (values, rowOffset) {
    var object = { _row: rowOffset + 2 };
    headers.forEach(function (header, index) {
      if (header) object[String(header).trim()] = values[index];
    });
    return object;
  });
}

function appendObjects_(sheetName, objects) {
  if (!objects.length) return;
  var sheet = getSheetRequired_(sheetName);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var values = objects.map(function (object) {
    return headers.map(function (header) { return object[header] == null ? '' : object[header]; });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
}

function getSettings_() {
  return tableRows_(getSheetRequired_(CAMP.SHEETS.SETTINGS)).reduce(function (settings, row) {
    if (row.key) settings[String(row.key)] = row.value;
    return settings;
  }, {});
}

function setSetting_(key, value) {
  var sheet = getSheetRequired_(CAMP.SHEETS.SETTINGS);
  var rows = tableRows_(sheet);
  var match = rows.find(function (row) { return String(row.key) === String(key); });
  var column = headerIndex_(sheet).value + 1;
  if (match) sheet.getRange(match._row, column).setValue(value);
  else sheet.appendRow([key, value, 'string', '자동 생성']);
}
