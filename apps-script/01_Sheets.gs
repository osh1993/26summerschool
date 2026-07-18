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

function ensureHeaders_(sheet, expectedHeaders) {
  var lastColumn = Math.max(sheet.getLastColumn(), expectedHeaders.length);
  var current = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  var hasAny = current.some(function (value) { return value !== ''; });
  if (hasAny) {
    var prefix = current.slice(0, expectedHeaders.length);
    if (JSON.stringify(prefix) !== JSON.stringify(expectedHeaders)) {
      throw new Error(sheet.getName() + ' 헤더가 계약과 다릅니다. 기존 데이터를 보존하기 위해 초기화를 중단했습니다.');
    }
    return;
  }
  sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, expectedHeaders.length)
    .setFontWeight('bold')
    .setBackground('#E8F0FE');
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
