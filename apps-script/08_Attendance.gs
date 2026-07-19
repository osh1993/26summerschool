/**
 * 참석 여부(구글폼 자유텍스트) → Attendance 탭 세션 반영.
 * 원본(학생/교사) 시트의 '참석 여부' 열 텍스트를 세션별 present/absent로 정규화해 Attendance에 upsert 한다.
 *
 * 소스 읽기·시트 쓰기(비순수)는 이 파일이 담당하고, 파싱·매핑·재조정 계획은 CampCore가 결정한다.
 *   - parseAttendanceSpec: '전일/Full' 또는 'N일'(달력 일) 파싱
 *   - buildDayIndexByDayOfMonth: 행사 기간을 day-of-month → day_index(1..3) 매핑
 *   - attendanceSlotIds: spec → present 슬롯 slot_id 목록
 *   - reconcileAttendance: 참가자별 present/absent 목표를 멱등 upsert 계획으로 변환(locked 보존)
 *
 * 참가자↔원본행 조인은 Form/Roster 동기화가 채운 source_response_id('<원본시트명>:<행번호>') 규약을 재사용한다.
 * 개인정보(원문 텍스트)는 공개 경로로 내보내지 않는다. 여기서는 slot 참석여부(present/absent)만 기록한다.
 */

/** 메뉴: 참석 여부 → Attendance 세션 반영. 멱등 재실행 안전. */
function applyAttendanceFromForm() {
  var ui = SpreadsheetApp.getUi();
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var settings = getSettings_();

    // 1) 행사 날짜로 day-of-month → day_index 매핑 구성. 미설정/무효면 파괴적 동작 없이 중단.
    var dayIndexMap = CampCore.buildDayIndexByDayOfMonth(
      String(settings.EVENT_START_DATE || '').trim(),
      String(settings.EVENT_END_DATE || '').trim()
    );
    if (!Object.keys(dayIndexMap).length) {
      ui.alert('EVENT_START_DATE/EVENT_END_DATE가 비었거나 올바르지 않습니다. Settings에 행사 시작/종료일(YYYY-MM-DD)을 입력한 뒤 다시 실행하세요.');
      return;
    }

    // 2) Time_Slots 로드. 없으면 표준 세션 시드 안내 후 중단.
    var timeSlots = tableRows_(getSheetRequired_(CAMP.SHEETS.TIME_SLOTS));
    if (!timeSlots.length) {
      ui.alert('Time_Slots가 비어 있습니다. 메뉴 "3-2. 표준 세션(7슬롯) 시드"를 먼저 실행한 뒤 다시 시도하세요.');
      return;
    }
    var allSlotIds = timeSlots.map(function (slot) { return String(slot.slot_id); });

    // 3) active 참가자 로드.
    var participants = tableRows_(getSheetRequired_(CAMP.SHEETS.PARTICIPANTS)).filter(function (row) {
      return CampCore.bool(row.active);
    });

    // 4) 원본(학생/교사) 시트에서 '참석 여부' 텍스트 인덱스('시트명:행번호' → text) 구성.
    var header = String(settings.ATTENDANCE_SOURCE_HEADER || CAMP.DEFAULT_SETTINGS.ATTENDANCE_SOURCE_HEADER).trim();
    var attendanceText = buildAttendanceTextIndex_(settings, header);

    var attendanceSheet = getSheetRequired_(CAMP.SHEETS.ATTENDANCE);
    var existingRows = tableRows_(attendanceSheet);
    var attIndex = headerIndex_(attendanceSheet);

    var applied = 0, skippedNoText = 0, skippedUnparsed = 0;
    var rowsToAppend = [];
    var issues = [];

    // 5) 참가자별 parse → slotIds → reconcile → upsert.
    participants.forEach(function (participant) {
      var sourceResponseId = String(participant.source_response_id || '').trim();
      var text = sourceResponseId ? attendanceText[sourceResponseId] : null;
      if (text == null || String(text).trim() === '') {
        skippedNoText += 1; // 매칭되는 원본행이 없거나 참석여부 텍스트가 비어 있음
        return;
      }
      var spec = CampCore.parseAttendanceSpec(text);
      if (!spec.full && (!spec.days || !spec.days.length)) {
        skippedUnparsed += 1;
        issues.push(CampCore.issue('ATTENDANCE_UNPARSED', 'participant', participant.participant_id,
          '참석 여부 텍스트를 해석하지 못해 세션을 반영하지 않았습니다.', false, 'warning'));
        return;
      }
      var presentIds = CampCore.attendanceSlotIds(spec, timeSlots, dayIndexMap);
      var plan = CampCore.reconcileAttendance(existingRows, participant.participant_id, presentIds, allSlotIds);
      applyAttendancePlan_(attendanceSheet, attIndex, plan, participant.participant_id, rowsToAppend);
      applied += 1;
    });

    if (rowsToAppend.length) appendObjects_(CAMP.SHEETS.ATTENDANCE, rowsToAppend);
    appendValidationIssues_(issues);

    ui.alert('[참석 세션 반영 완료]\n' +
      '반영 ' + applied + '명 / 참석여부 없음(스킵) ' + skippedNoText + ' / 해석 실패(스킵) ' + skippedUnparsed + '\n' +
      '신규 세션 행 ' + rowsToAppend.length + '개를 추가했습니다. 상세는 Validation 탭을 확인하세요.');
  } catch (error) {
    // 안전 코드만 노출한다(원문 텍스트·스택·시트 내부 정보 비노출).
    var code = error && error.attendanceCode ? error.attendanceCode : 'ATTENDANCE_APPLY_FAILED';
    appendValidationIssues_([CampCore.issue(code, 'attendance', '', '참석 세션 반영 중단: ' + code, true)]);
    ui.alert('참석 세션 반영 중단: ' + code);
  } finally {
    lock.releaseLock();
  }
}

/**
 * 원본(학생/교사) 시트에서 참석여부 헤더 열을 찾아 '시트명:행번호' → 텍스트 인덱스를 만든다.
 * 참석여부 열이 없는 원본 시트는 조용히 건너뛴다(교사 폼에는 없을 수 있음).
 */
function buildAttendanceTextIndex_(settings, header) {
  var index = {};
  var sheetNames = [
    settings.RAW_STUDENT_SHEET || CAMP.SHEETS.RAW_STUDENTS,
    settings.RAW_STAFF_SHEET || CAMP.SHEETS.RAW_STAFF
  ];
  sheetNames.forEach(function (rawName) {
    var name = String(rawName || '').trim();
    if (!name) return;
    var sheet = campSpreadsheet_().getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(function (value) {
      return String(value).trim();
    });
    var col = headers.indexOf(header);
    if (col < 0) return; // 이 원본 시트에 참석여부 열이 없으면 건너뛴다
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getDisplayValues();
    values.forEach(function (rowValues, offset) {
      index[name + ':' + (offset + 2)] = rowValues[col];
    });
  });
  return index;
}

/** reconcile 계획을 시트에 적용한다. 기존 행은 presence_status만 갱신, 신규 행은 attendance_id 발급 후 append 목록에 넣는다. */
function applyAttendancePlan_(sheet, attIndex, plan, participantId, rowsToAppend) {
  plan.toSetPresent.concat(plan.toSetAbsent).forEach(function (item) {
    if (item.isNew) {
      rowsToAppend.push({
        attendance_id: 'at_' + Utilities.getUuid().replace(/-/g, ''),
        participant_id: participantId,
        slot_id: item.slot_id,
        presence_status: item.presence_status,
        locked: false
      });
    } else if (item.row && attIndex.presence_status != null) {
      sheet.getRange(item.row, attIndex.presence_status + 1).setValue(item.presence_status);
    }
  });
}
