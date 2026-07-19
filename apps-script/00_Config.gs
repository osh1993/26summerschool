/**
 * 2026 수련회 운영 시트 공통 설정.
 * 이 프로젝트에는 Spreadsheet ID, URL, 개인 식별값을 하드코딩하지 않는다.
 */
var CAMP = Object.freeze({
  // Phase 3: 차량 운행에 time_bucket(오전/오후/밤) 파생 표시 + 탑승자 성 마스킹으로 공개 v4 / 내부 v3로 bump.
  // publisher(06_PublicApi.gs)가 이 값으로 스냅샷을 스탬프하므로, trips[].time_bucket과 성 마스킹된 passengers[].public_name을
  // 반드시 함께 조립해야 게시 검증을 통과한다(rooms[]·time_slots[]도 v3부터 계속 필수).
  SCHEMA_VERSION: 'public-snapshot/v4',
  INTERNAL_SCHEMA_VERSION: 'internal-snapshot/v3',
  TIMEZONE: 'Asia/Seoul',
  PUBLIC_EXPORT_CHUNK_SIZE: 40000,
  SHEETS: Object.freeze({
    SETTINGS: 'Settings',
    LOOKUPS: 'Lookups',
    FIELD_MAP: 'Form_Field_Map',
    RAW_STUDENTS: 'Form_Raw_Students',
    RAW_STAFF: 'Form_Raw_Staff',
    PARTICIPANTS: 'Participants',
    PRIVATE: 'Participant_Private',
    TIME_SLOTS: 'Time_Slots',
    ATTENDANCE: 'Attendance',
    RELATIONS: 'Relations',
    GROUPS: 'Groups',
    GROUP_ASSIGNMENTS: 'Group_Assignments',
    ROOMS: 'Rooms',
    ROOM_ASSIGNMENTS: 'Room_Assignments',
    LOCATIONS: 'Locations',
    TRAVEL_DEMANDS: 'Travel_Demands',
    VEHICLES: 'Vehicles',
    VEHICLE_AVAILABILITY: 'Vehicle_Availability',
    TRIPS: 'Trips',
    TRIP_PASSENGERS: 'Trip_Passengers',
    NOTICES: 'Notices',
    VALIDATION: 'Validation',
    CHANGE_LOG: 'Change_Log',
    PUBLIC_EXPORT: 'Public_Export'
  }),
  HEADERS: Object.freeze({
    Settings: ['key', 'value', 'type', 'description'],
    Lookups: ['category', 'value', 'label', 'sort_order', 'active'],
    Form_Field_Map: ['source_sheet', 'source_header', 'normalized_field', 'required', 'active'],
    Form_Raw_Students: [],
    Form_Raw_Staff: [],
    // extraversion_score(외향성 1~5, 기본 3)는 기존 시트 마이그레이션 안전성을 위해 후행 컬럼으로 append 한다.
    Participants: ['participant_id', 'event_id', 'person_type', 'legal_name', 'public_id', 'public_name', 'public_consent', 'campus', 'grade_band', 'gender', 'engagement_score', 'newcomer', 'leader_candidate', 'active', 'source_response_id', 'updated_at', 'extraversion_score'],
    Participant_Private: ['participant_id', 'birth_date', 'phone', 'guardian_phone', 'insurance_status', 'private_note'],
    // day_index(1~3)/part(morning/afternoon/night)는 세션 표시용 후행 컬럼으로 append 한다.
    Time_Slots: ['slot_id', 'event_id', 'label', 'starts_at', 'ends_at', 'core_program', 'day_index', 'part'],
    Attendance: ['attendance_id', 'participant_id', 'slot_id', 'presence_status', 'locked'],
    Relations: ['relation_id', 'participant_a_id', 'participant_b_id', 'relation_type', 'weight', 'reason_private', 'active'],
    Groups: ['group_id', 'event_id', 'display_name', 'color', 'target_size', 'min_size', 'max_size', 'active'],
    Group_Assignments: ['assignment_id', 'participant_id', 'group_id', 'role', 'locked', 'assignment_source', 'score_delta', 'reason_codes', 'revision', 'updated_at', 'updated_by'],
    // Phase 2 방배정: 방 정보는 운영자가 시트에서 수동 관리한다. gender_scope ∈ male|female|mixed, capacity=정수 정원.
    Rooms: ['room_id', 'event_id', 'display_name', 'capacity', 'floor', 'gender_scope', 'active', 'private_note'],
    // 방 배정도 운영자 수동 입력. assignment_source 기본 manual, locked=재배정 보호.
    Room_Assignments: ['room_id', 'participant_id', 'locked', 'assignment_source'],
    Locations: ['location_id', 'internal_name', 'public_label', 'area', 'full_address_private', 'public_allowed'],
    Travel_Demands: ['demand_id', 'participant_id', 'direction', 'earliest_depart_at', 'latest_depart_at', 'origin_location_id', 'destination_location_id', 'party_size', 'demand_status', 'locked_trip_id', 'priority', 'private_note'],
    Vehicles: ['vehicle_id', 'event_id', 'internal_label', 'public_label', 'capacity_total', 'accessible', 'route_scope', 'active', 'private_note'],
    Vehicle_Availability: ['availability_id', 'vehicle_id', 'driver_participant_id', 'available_from', 'available_to', 'origin_scope', 'destination_scope', 'status'],
    Trips: ['trip_id', 'event_id', 'direction', 'depart_at', 'arrival_estimate', 'origin_location_id', 'destination_location_id', 'meeting_location_id', 'vehicle_id', 'driver_participant_id', 'trip_status', 'locked', 'revision', 'updated_at'],
    Trip_Passengers: ['trip_passenger_id', 'trip_id', 'participant_id', 'demand_id', 'boarding_status', 'seat_count', 'assignment_source', 'locked', 'updated_at'],
    Notices: ['notice_id', 'title', 'message', 'severity', 'starts_at', 'ends_at', 'active'],
    Validation: ['severity', 'entity_type', 'entity_id', 'rule_code', 'message_private', 'blocking', 'detected_at', 'resolved_at'],
    Change_Log: ['change_id', 'entity_type', 'entity_id', 'field_name', 'old_value', 'new_value', 'changed_at', 'changed_by', 'reason'],
    Public_Export: ['publish_id', 'chunk_index', 'chunk_count', 'sha256', 'json_chunk', 'generated_at', 'active']
  }),
  DEFAULT_SETTINGS: Object.freeze({
    EVENT_ID: '2026-summer',
    EVENT_NAME: '2026 여름수련회',
    EVENT_START_DATE: '',
    EVENT_END_DATE: '',
    GROUP_COUNT: '6',
    ROOM_COUNT: '8',
    RAW_STUDENT_SHEET: 'Form_Raw_Students',
    RAW_STAFF_SHEET: 'Form_Raw_Staff',
    // 원본(학생/교사) 시트에서 '참석 여부' 자유텍스트 열을 찾는 헤더명. 이 텍스트를 세션별 present/absent로 반영한다.
    ATTENDANCE_SOURCE_HEADER: '참석 여부',
    LAST_SYNC_ROW_STUDENTS: '1',
    LAST_SYNC_ROW_STAFF: '1',
    ROSTER_SOURCE_MODE: '',
    ROSTER_TARGET_TAB: '',
    ROSTER_MAX_ROWS: '2000',
    PUBLISH_STATUS: 'draft',
    LAST_PUBLISH_ID: ''
  })
});

function campSpreadsheet_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('바운드 Google Spreadsheet에서 실행해야 합니다.');
  return spreadsheet;
}

function nowIso_() {
  return Utilities.formatDate(new Date(), CAMP.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function asBoolean_(value) {
  if (value === true || value === 1) return true;
  var normalized = String(value == null ? '' : value).trim().toLowerCase();
  return ['true', '1', 'y', 'yes', '예', '동의', '참석'].indexOf(normalized) >= 0;
}

function asNumber_(value, fallback) {
  var number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function dateToIso_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, CAMP.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
  }
  var parsed = new Date(value);
  return isNaN(parsed.getTime()) ? String(value) : Utilities.formatDate(parsed, CAMP.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}
