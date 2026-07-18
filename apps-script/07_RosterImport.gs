/**
 * 참석자 명단 일괄 가져오기(Roster Import).
 * 운영자가 (A) 다른 Google Sheets URL 또는 (B) Drive의 엑셀(.xlsx) 파일을 지정하면
 * Participants(+Participant_Private) 탭에 안전하게 upsert한다.
 *
 * 소스 열기·시트 쓰기(비순수)는 이 파일이 담당하고, 매칭·병합 계획은 CampCore가 결정한다.
 * 설계 근거: _workspace/07_data_architect_roster_import.md
 *
 * Form_Field_Map에서 source_sheet='Roster_Import'인 활성 행을 매핑으로 사용한다.
 * URL/파일 ID는 매 실행 프롬프트로 받고 시트에 저장하지 않는다.
 */

/** 메뉴: 미리보기(시트 미변경) */
function importRosterPreview() {
  runRosterImport_('preview');
}

/** 메뉴: 반영(commit 또는 commit-overwrite) */
function importRosterCommit() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt(
    '명단 반영 모드',
    '기존 값이 다를 때 명단 값으로 덮어쓰려면 OVERWRITE 를 입력하세요. 비우고 확인하면 빈 칸만 채웁니다.',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var mode = String(response.getResponseText()).trim().toUpperCase() === 'OVERWRITE' ? 'commit-overwrite' : 'commit';
  runRosterImport_(mode);
}

function runRosterImport_(mode) {
  var ui = SpreadsheetApp.getUi();
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var mappings = tableRows_(getSheetRequired_(CAMP.SHEETS.FIELD_MAP)).filter(function (row) {
      return String(row.source_sheet) === 'Roster_Import' && asBoolean_(row.active);
    });
    if (!mappings.length) {
      ui.alert('Roster_Import 활성 매핑이 없습니다. Form_Field_Map에 source_sheet=Roster_Import 행을 추가하세요.');
      return;
    }

    var grid = promptRosterSource_(ui);
    if (!grid) return; // 사용자가 취소함

    validateRosterHeaders_(grid, mappings);
    var rosterRows = buildRosterRows_(grid, mappings);
    var settings = getSettings_();
    var participants = tableRows_(getSheetRequired_(CAMP.SHEETS.PARTICIPANTS));
    var privateRows = tableRows_(getSheetRequired_(CAMP.SHEETS.PRIVATE));

    var plan = CampCore.planRosterUpsert(participants, privateRows, rosterRows, mappings.map(function (row) {
      return { normalized_field: String(row.normalized_field).trim(), required: asBoolean_(row.required) };
    }), {
      mode: mode,
      eventId: settings.EVENT_ID || CAMP.DEFAULT_SETTINGS.EVENT_ID,
      maxRows: asNumber_(settings.ROSTER_MAX_ROWS, 2000)
    });

    if (mode === 'preview') {
      appendValidationIssues_(plan.issues);
      ui.alert(formatRosterSummary_(plan, true));
      return;
    }

    applyRosterPlan_(plan, participants);
    appendValidationIssues_(plan.issues);
    ui.alert(formatRosterSummary_(plan, false));
  } catch (error) {
    // 안전 코드만 노출하고 URL·스택·시트 내부 정보는 남기지 않는다.
    var code = error && error.rosterCode ? error.rosterCode : 'ROSTER_IMPORT_FAILED';
    var message = '명단 가져오기 중단: ' + code + (error && error.message ? ' — ' + error.message : '');
    appendValidationIssues_([CampCore.issue(code, 'import', '', message)]);
    ui.alert(message);
  } finally {
    lock.releaseLock();
  }
}

function rosterError_(code, message) {
  var error = new Error(message || code);
  error.rosterCode = code;
  return error;
}

/** 소스 종류·식별자·대상 탭을 프롬프트로 받아 헤더/값 그리드를 반환한다. 취소 시 null. */
function promptRosterSource_(ui) {
  var typeResponse = ui.prompt('명단 소스 종류', '1 = 다른 Google Sheets URL\n2 = Drive 엑셀(.xlsx) 파일 ID', ui.ButtonSet.OK_CANCEL);
  if (typeResponse.getSelectedButton() !== ui.Button.OK) return null;
  var type = String(typeResponse.getResponseText()).trim();

  var settings = getSettings_();
  var tabResponse = ui.prompt('대상 탭 이름', '읽을 탭 이름을 입력하세요. 비우면 첫 시트를 사용합니다.', ui.ButtonSet.OK_CANCEL);
  if (tabResponse.getSelectedButton() !== ui.Button.OK) return null;
  var tabName = String(tabResponse.getResponseText()).trim() || String(settings.ROSTER_TARGET_TAB || '').trim();

  if (type === '1' || type.toLowerCase() === 'sheet_url') {
    var urlResponse = ui.prompt('Google Sheets URL', '명단 스프레드시트의 공유 URL을 입력하세요.', ui.ButtonSet.OK_CANCEL);
    if (urlResponse.getSelectedButton() !== ui.Button.OK) return null;
    return readRosterFromSheetUrl_(String(urlResponse.getResponseText()).trim(), tabName);
  }
  if (type === '2' || type.toLowerCase() === 'drive_xlsx') {
    var idResponse = ui.prompt('Drive 파일 ID', '.xlsx 파일의 Drive 파일 ID를 입력하세요.', ui.ButtonSet.OK_CANCEL);
    if (idResponse.getSelectedButton() !== ui.Button.OK) return null;
    return readRosterFromDriveXlsx_(String(idResponse.getResponseText()).trim(), tabName);
  }
  throw rosterError_('ROSTER_INVALID_FILE_TYPE', '알 수 없는 소스 종류입니다. 1 또는 2를 입력하세요.');
}

function readRosterFromSheetUrl_(url, tabName) {
  if (!url) throw rosterError_('ROSTER_SOURCE_UNREADABLE', 'URL이 비어 있습니다.');
  var spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openByUrl(url);
  } catch (error) {
    throw rosterError_('ROSTER_SOURCE_UNREADABLE', 'URL을 열 수 없거나 접근 권한이 없습니다.');
  }
  var sheet = tabName ? spreadsheet.getSheetByName(tabName) : spreadsheet.getSheets()[0];
  if (!sheet) throw rosterError_('ROSTER_SOURCE_UNREADABLE', '지정한 탭을 찾을 수 없습니다.');
  return readRosterGrid_(sheet);
}

/**
 * Advanced Drive Service(v2)로 xlsx를 임시 Google Sheets로 변환해 읽고, 임시본을 즉시 폐기한다.
 * 조직 정책상 Advanced Drive Service를 켤 수 없으면 운영자가 수동으로 Sheets 변환 후 소스 (A)로 제출한다.
 */
function readRosterFromDriveXlsx_(fileId, tabName) {
  if (!fileId) throw rosterError_('ROSTER_INVALID_FILE_TYPE', '파일 ID가 비어 있습니다.');
  var tempId = null;
  try {
    var converted;
    try {
      converted = Drive.Files.copy({ title: 'roster_temp_' + Utilities.getUuid(), mimeType: 'application/vnd.google-apps.spreadsheet' }, fileId);
    } catch (error) {
      throw rosterError_('ROSTER_INVALID_FILE_TYPE', '엑셀 파일을 Google Sheets로 변환하지 못했습니다.');
    }
    tempId = converted && converted.id;
    if (!tempId) throw rosterError_('ROSTER_INVALID_FILE_TYPE', '변환 결과 파일을 만들지 못했습니다.');
    var spreadsheet = SpreadsheetApp.openById(tempId);
    var sheet = tabName ? spreadsheet.getSheetByName(tabName) : spreadsheet.getSheets()[0];
    if (!sheet) throw rosterError_('ROSTER_SOURCE_UNREADABLE', '변환한 파일에서 탭을 찾을 수 없습니다.');
    return readRosterGrid_(sheet);
  } finally {
    if (tempId) {
      try { Drive.Files.remove(tempId); } catch (cleanupError) { /* 임시본 폐기 실패는 원본에 영향 없음 */ }
    }
  }
}

function readRosterGrid_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  if (lastRow < 1 || lastColumn < 1) throw rosterError_('ROSTER_SOURCE_UNREADABLE', '명단이 비어 있습니다.');
  var headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(function (value) { return String(value).trim(); });
  var values = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getDisplayValues() : [];
  return { headers: headers, values: values };
}

function validateRosterHeaders_(grid, mappings) {
  var headerSet = {};
  grid.headers.forEach(function (header) { if (header) headerSet[header] = true; });
  mappings.forEach(function (mapping) {
    if (!headerSet[String(mapping.source_header).trim()]) {
      throw rosterError_('ROSTER_HEADER_UNMAPPED', '매핑된 헤더를 명단에서 찾을 수 없습니다: ' + mapping.normalized_field);
    }
  });
}

function buildRosterRows_(grid, mappings) {
  return grid.values.map(function (values, offset) {
    var raw = {};
    grid.headers.forEach(function (header, index) { if (header) raw[header] = values[index]; });
    var fields = {};
    mappings.forEach(function (mapping) {
      var normalizedField = String(mapping.normalized_field).trim();
      fields[normalizedField] = normalizeRosterField_(normalizedField, raw[String(mapping.source_header).trim()]);
    });
    return { index: offset + 2, fields: fields };
  });
}

/** Form 동기화와 동일한 정규화 헬퍼를 재사용한다. 명단이라고 다른 규칙을 만들지 않는다. */
function normalizeRosterField_(field, value) {
  switch (field) {
    case 'person_type': return (value === '' || value == null) ? '' : normalizePersonType_(value);
    case 'campus': return normalizeCampus_(value);
    case 'grade_band': return (value === '' || value == null) ? '' : normalizeGradeBand_(value);
    case 'gender': return (value === '' || value == null) ? '' : normalizeGender_(value);
    case 'engagement_score': return (value === '' || value == null) ? '' : clamp_(asNumber_(value, 3), 1, 5);
    case 'legal_name': return String(value == null ? '' : value).trim();
    default: return value == null ? '' : value; // 민감/불리언 필드는 원값 유지
  }
}

function applyRosterPlan_(plan, participants) {
  var publicIds = (participants || []).reduce(function (map, row) { if (row.public_id) map[String(row.public_id)] = true; return map; }, {});
  var participantsToAppend = [];
  var privateToAppend = [];
  var changeLogToAppend = [];

  plan.inserts.forEach(function (insert) {
    var participantId = 'pt_' + Utilities.getUuid().replace(/-/g, '');
    var publicId = generatePublicId_(publicIds);
    publicIds[publicId] = true;
    var participant = insert.participant;
    participant.participant_id = participantId;
    participant.public_id = publicId;
    participant.updated_at = nowIso_();
    participantsToAppend.push(participant);

    var privateRow = insert.private || {};
    privateRow.participant_id = participantId;
    privateToAppend.push(privateRow);

    changeLogToAppend.push(rosterChangeRow_('participant', participantId, '__created', '', participantId, 'roster insert'));
  });

  appendObjects_(CAMP.SHEETS.PARTICIPANTS, participantsToAppend);
  appendObjects_(CAMP.SHEETS.PRIVATE, privateToAppend);
  applyRosterUpdates_(plan.updates, changeLogToAppend);
  appendObjects_(CAMP.SHEETS.CHANGE_LOG, changeLogToAppend);
}

function applyRosterUpdates_(updates, changeLogToAppend) {
  if (!updates || !updates.length) return;
  var participantSheet = getSheetRequired_(CAMP.SHEETS.PARTICIPANTS);
  var privateSheet = getSheetRequired_(CAMP.SHEETS.PRIVATE);
  var participantIndex = headerIndex_(participantSheet);
  var privateIndex = headerIndex_(privateSheet);

  updates.forEach(function (update) {
    var participantFields = Object.keys(update.setParticipant);
    participantFields.forEach(function (field) {
      if (participantIndex[field] == null) return;
      participantSheet.getRange(update.row, participantIndex[field] + 1).setValue(update.setParticipant[field]);
    });
    if (participantFields.length && participantIndex.updated_at != null) {
      participantSheet.getRange(update.row, participantIndex.updated_at + 1).setValue(nowIso_());
    }

    var privateFields = Object.keys(update.setPrivate);
    if (privateFields.length) {
      if (update.private_row) {
        privateFields.forEach(function (field) {
          if (privateIndex[field] == null) return;
          privateSheet.getRange(update.private_row, privateIndex[field] + 1).setValue(update.setPrivate[field]);
        });
      } else {
        var newPrivate = { participant_id: update.participant_id };
        privateFields.forEach(function (field) { newPrivate[field] = update.setPrivate[field]; });
        appendObjects_(CAMP.SHEETS.PRIVATE, [newPrivate]);
      }
    }

    (update.changeLog || []).forEach(function (change) {
      changeLogToAppend.push(rosterChangeRow_(change.entity_type, update.participant_id, change.field_name, change.old_value, change.new_value, change.reason));
    });
  });
}

function rosterChangeRow_(entityType, entityId, field, oldValue, newValue, reason) {
  return {
    change_id: 'chg_' + Utilities.getUuid().replace(/-/g, ''),
    entity_type: entityType,
    entity_id: entityId,
    field_name: field,
    old_value: oldValue,
    new_value: newValue,
    changed_at: nowIso_(),
    changed_by: 'roster_import',
    reason: reason
  };
}

function formatRosterSummary_(plan, isPreview) {
  var s = plan.summary;
  return (isPreview ? '[미리보기] 시트를 변경하지 않았습니다.\n' : '[반영 완료]\n') +
    '신규 ' + s.insert + ' / 갱신 ' + s.update + ' / 값충돌 ' + s.conflict +
    ' / 동명이인 보류 ' + s.ambiguous + ' / 건너뜀 ' + s.skip + ' / 명단 누락 ' + s.missing_existing + '\n' +
    'Validation 탭에서 상세 코드를 확인하세요.';
}
