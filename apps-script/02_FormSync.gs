/**
 * Google Forms가 연결한 원본 탭에서 새 행만 정규화한다.
 * Form_Field_Map 예: Form_Raw_Students | 이름 | legal_name | TRUE | TRUE
 * 질문 문구가 바뀌면 코드 대신 매핑 탭을 수정한다.
 */
function syncFormResponsesIncremental() {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var settings = getSettings_();
    var results = [];
    results.push(syncOneFormSheet_(settings.RAW_STUDENT_SHEET || CAMP.SHEETS.RAW_STUDENTS, 'student', 'LAST_SYNC_ROW_STUDENTS'));
    results.push(syncOneFormSheet_(settings.RAW_STAFF_SHEET || CAMP.SHEETS.RAW_STAFF, 'staff', 'LAST_SYNC_ROW_STAFF'));
    SpreadsheetApp.getUi().alert(results.join('\n'));
  } finally {
    lock.releaseLock();
  }
}

function syncOneFormSheet_(sourceSheetName, defaultPersonType, cursorSettingKey) {
  var spreadsheet = campSpreadsheet_();
  var source = spreadsheet.getSheetByName(sourceSheetName);
  if (!source || source.getLastRow() < 2) return sourceSheetName + ': 새 응답 없음';
  var settings = getSettings_();
  var startRow = Math.max(2, Number(settings[cursorSettingKey] || 1) + 1);
  var lastRow = source.getLastRow();
  if (startRow > lastRow) return sourceSheetName + ': 새 응답 없음';

  var sourceHeaders = source.getRange(1, 1, 1, source.getLastColumn()).getDisplayValues()[0].map(function (value) { return String(value).trim(); });
  var mappings = tableRows_(getSheetRequired_(CAMP.SHEETS.FIELD_MAP)).filter(function (row) {
    return String(row.source_sheet) === String(sourceSheetName) && asBoolean_(row.active);
  });
  if (!mappings.length) throw new Error(sourceSheetName + '의 활성 Form_Field_Map이 없습니다.');
  mappings.forEach(function (mapping) {
    if (sourceHeaders.indexOf(String(mapping.source_header).trim()) < 0) {
      throw new Error(sourceSheetName + '에서 매핑된 원본 헤더를 찾을 수 없습니다: ' + mapping.source_header);
    }
  });

  var participantSheet = getSheetRequired_(CAMP.SHEETS.PARTICIPANTS);
  var privateSheet = getSheetRequired_(CAMP.SHEETS.PRIVATE);
  var participantRows = tableRows_(participantSheet);
  var bySource = participantRows.reduce(function (map, row) {
    if (row.source_response_id) map[String(row.source_response_id)] = row;
    return map;
  }, {});
  var publicIds = participantRows.reduce(function (map, row) { if (row.public_id) map[String(row.public_id)] = true; return map; }, {});
  var sourceValues = source.getRange(startRow, 1, lastRow - startRow + 1, source.getLastColumn()).getValues();
  var participantsToAppend = [];
  var privateToAppend = [];
  var issues = [];

  sourceValues.forEach(function (values, offset) {
    var rawRowNumber = startRow + offset;
    var raw = {};
    sourceHeaders.forEach(function (header, index) { if (header) raw[header] = values[index]; });
    var normalized = {};
    var missing = [];
    mappings.forEach(function (mapping) {
      var value = raw[String(mapping.source_header).trim()];
      normalized[String(mapping.normalized_field).trim()] = value;
      if (asBoolean_(mapping.required) && (value === '' || value == null)) missing.push(String(mapping.normalized_field));
    });
    var sourceResponseId = sourceSheetName + ':' + rawRowNumber;
    if (bySource[sourceResponseId]) return; // 재실행 안전성
    if (missing.length) {
      issues.push(CampCore.issue('FORM_REQUIRED_FIELD_MISSING', 'source_response', sourceResponseId, '필수 정규화 필드 누락: ' + missing.join(',')));
      return;
    }
    var participantId = 'pt_' + Utilities.getUuid().replace(/-/g, '');
    var publicId = generatePublicId_(publicIds);
    publicIds[publicId] = true;
    participantsToAppend.push({
      participant_id: participantId,
      event_id: settings.EVENT_ID || CAMP.DEFAULT_SETTINGS.EVENT_ID,
      person_type: normalizePersonType_(normalized.person_type || defaultPersonType),
      legal_name: normalized.legal_name || '',
      public_id: publicId,
      public_name: '', // 운영자가 동의 확인 후 승인한 게시명만 입력한다.
      public_consent: false,
      campus: normalizeCampus_(normalized.campus),
      grade_band: normalizeGradeBand_(normalized.grade_band),
      gender: normalizeGender_(normalized.gender),
      engagement_score: clamp_(asNumber_(normalized.engagement_score, 3), 1, 5),
      newcomer: asBoolean_(normalized.newcomer),
      leader_candidate: asBoolean_(normalized.leader_candidate),
      active: true,
      source_response_id: sourceResponseId,
      updated_at: nowIso_()
    });
    privateToAppend.push({
      participant_id: participantId,
      birth_date: normalized.birth_date || '',
      phone: normalized.phone || '',
      guardian_phone: normalized.guardian_phone || '',
      insurance_status: normalized.insurance_status || '',
      private_note: normalized.private_note || normalized.free_text || ''
    });
  });

  appendObjects_(CAMP.SHEETS.PARTICIPANTS, participantsToAppend);
  appendObjects_(CAMP.SHEETS.PRIVATE, privateToAppend);
  appendValidationIssues_(issues);
  setSetting_(cursorSettingKey, String(lastRow));
  return sourceSheetName + ': ' + participantsToAppend.length + '명 동기화, ' + issues.length + '건 검토 필요';
}

function generatePublicId_(existing) {
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (var attempt = 0; attempt < 20; attempt += 1) {
    // UUID는 내부 ID와 독립적으로 새로 생성하며 행사 간 재사용하지 않는다.
    var seed = Utilities.getUuid().replace(/-/g, '').toUpperCase();
    var suffix = '';
    for (var i = 0; i < 6; i += 1) {
      suffix += alphabet.charAt(parseInt(seed.substr(i * 2, 2), 16) % alphabet.length);
    }
    var candidate = 'P-' + suffix;
    if (!existing[candidate]) return candidate;
  }
  throw new Error('고유 public_id 생성에 실패했습니다.');
}

function normalizePersonType_(value) {
  var text = String(value || '').toLowerCase();
  if (text.indexOf('교사') >= 0 || text === 'teacher') return 'teacher';
  if (text.indexOf('스탭') >= 0 || text.indexOf('staff') >= 0) return 'staff';
  return 'student';
}

function normalizeCampus_(value) {
  var text = String(value || '').trim().toLowerCase();
  if (text.indexOf('임동') >= 0 || text === 'imd') return 'imd';
  if (text.indexOf('수완') >= 0 || text === 'suwan') return 'suwan';
  return text ? 'other' : '';
}

function normalizeGradeBand_(value) {
  var text = String(value || '').replace(/\s/g, '');
  var middle = text.match(/(?:중학교|중)([1-3])/);
  var high = text.match(/(?:고등학교|고)([1-3])/);
  if (middle) return 'middle_' + middle[1];
  if (high) return 'high_' + high[1];
  if (/교사|스탭|성인|adult/i.test(text)) return 'adult';
  return 'unknown';
}

function normalizeGender_(value) {
  var text = String(value || '').trim().toLowerCase();
  if (text === '남' || text.indexOf('남성') >= 0 || text === 'male') return 'male';
  if (text === '여' || text.indexOf('여성') >= 0 || text === 'female') return 'female';
  return text ? 'other' : 'undisclosed';
}

function clamp_(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
