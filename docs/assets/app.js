"use strict";

const SUPPORTED_SCHEMAS = ["public-snapshot/v1", "public-snapshot/v2", "public-snapshot/v3", "public-snapshot/v4"];
const INTERNAL_SCHEMAS = ["internal-snapshot/v1", "internal-snapshot/v2", "internal-snapshot/v3"];
const INTERNAL_SESSION_KEY = "camp.internal.snapshot";
// 쓰기 토큰은 스냅샷과 별도로 보관한다(비밀번호는 저장하지 않음).
const INTERNAL_TOKEN_KEY = "camp.internal.token";
const FALLBACK_SOURCES = [
  { key: "latest", url: "data/latest.json" },
  { key: "sample", url: "data/sample.json" }
];

// 관리자 설정 화면 고정 어휘(Apps Script Core.js의 계약과 일치해야 한다).
const CONFIG_SETTINGS_KEYS = [
  "EVENT_NAME", "EVENT_START_DATE", "EVENT_END_DATE",
  "GROUP_COUNT", "ROOM_COUNT", "ATTENDANCE_SOURCE_HEADER",
  "RAW_STUDENT_SHEET", "RAW_STAFF_SHEET"
];
const FIELD_MAP_SOURCES = ["Form_Raw_Students", "Form_Raw_Staff", "Roster_Import"];
const NORMALIZED_FIELD_LABELS = {
  legal_name: "이름 (legal_name)",
  person_type: "구분 (person_type)",
  campus: "소속 (campus)",
  grade_band: "학년 (grade_band)",
  gender: "성별 (gender)",
  engagement_score: "적극성 (engagement_score)",
  extraversion_score: "외향성 (extraversion_score)",
  newcomer: "새친구 (newcomer)",
  leader_candidate: "리더 후보 (leader_candidate)",
  phone: "전화 (phone)",
  birth_date: "생년월일 (birth_date)",
  guardian_phone: "보호자 전화 (guardian_phone)",
  insurance_status: "보험 (insurance_status)",
  private_note: "비공개 메모 (private_note)",
  free_text: "자유 서술 (free_text)"
};
const GENDER_SCOPE_OPTIONS = [["male", "남 (male)"], ["female", "여 (female)"], ["mixed", "혼성 (mixed)"]];
// {error} 코드 → 운영자 안내 문구.
const CONFIG_ERROR_MESSAGES = {
  writes_disabled: "서버에 토큰 비밀키(CAMP_INTERNAL_TOKEN_SECRET)가 설정되지 않아 저장이 비활성화되었습니다.",
  unauthorized: "세션이 만료되었거나 인증되지 않았습니다. 내부 명단 탭에서 다시 로그인하세요.",
  token_expired: "로그인 세션이 만료되었습니다. 내부 명단 탭에서 다시 로그인하세요.",
  invalid_input: "입력값을 확인해 주세요.",
  not_found: "알 수 없는 요청입니다.",
  temporarily_unavailable: "일시적으로 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요."
};

const state = {
  snapshot: null,
  source: "loading",
  trips: {
    date: "all",
    direction: "all",
    bucket: "all",
    query: ""
  },
  groups: {
    query: ""
  },
  rooms: {
    query: ""
  },
  internal: {
    snapshot: null,
    source: null
  },
  config: {
    token: null,
    loaded: false,
    loading: false
  },
  // 참석자 관리(Phase B): PII 포함 목록. 서버(get_participants)에서만 채워지고 정적 저장하지 않는다.
  participants: {
    list: [],
    private: {},
    query: "",
    disabled: true
  }
};

// 참석자 편집 폼 enum 옵션(Core.js validateParticipantInput 계약과 일치해야 한다).
const PARTICIPANT_PERSON_TYPE_OPTIONS = [["student", "학생"], ["teacher", "교사"], ["staff", "스탭"]];
const PARTICIPANT_CAMPUS_OPTIONS = [["", "(미지정)"], ["imd", "임동"], ["suwan", "수완"], ["other", "기타"]];
const PARTICIPANT_GRADE_OPTIONS = [["", "(미지정)"], ["middle_1", "중1"], ["middle_2", "중2"], ["middle_3", "중3"], ["high_1", "고1"], ["high_2", "고2"], ["high_3", "고3"], ["adult", "성인"], ["unknown", "미상"]];
const PARTICIPANT_GENDER_OPTIONS = [["", "(미지정)"], ["male", "남"], ["female", "여"], ["other", "기타"], ["undisclosed", "비공개"]];
// 목록 표시용 라벨 맵(옵션 배열에서 파생).
const PARTICIPANT_CAMPUS_LABELS = Object.fromEntries(PARTICIPANT_CAMPUS_OPTIONS);
const PARTICIPANT_GRADE_LABELS = Object.fromEntries(PARTICIPANT_GRADE_OPTIONS);
const PARTICIPANT_GENDER_LABELS = Object.fromEntries(PARTICIPANT_GENDER_OPTIONS);

const tripStatusLabels = {
  open: "접수 중",
  confirmed: "운행 확정",
  departed: "출발함",
  arrived: "도착함",
  cancelled: "운행 취소"
};

const boardingStatusLabels = {
  planned: "예정",
  confirmed: "확정",
  boarded: "탑승",
  cancelled: "취소"
};

const roleLabels = {
  leader: "조장",
  sub_leader: "부조장",
  teacher: "조선생님",
  member: "조원"
};

const directionLabels = {
  IN: "IN · 수련회장으로",
  OUT: "OUT · 광주로"
};

// 차량 운행 시간 버킷: 색상만으로 구분하지 않고 아이콘+텍스트를 함께 쓴다(오전/오후/밤).
const tripBucketLabels = {
  morning: "오전",
  afternoon: "오후",
  night: "밤"
};
const tripBucketIcons = {
  morning: "☀",
  afternoon: "⛅",
  night: "🌙"
};

// 방 성별 범위: 색상만으로 구분하지 않고 아이콘+텍스트를 함께 쓴다.
const genderScopeLabels = {
  male: { icon: "♂", text: "남" },
  female: { icon: "♀", text: "여" },
  mixed: { icon: "⚥", text: "혼성" }
};

const personTypeLabels = {
  student: "학생",
  teacher: "교사",
  staff: "스탭"
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindTabs();
  bindFilters();
  bindInternal();
  bindConfig();
  bindParticipants();

  try {
    const loaded = await loadSnapshot();
    state.snapshot = loaded.snapshot;
    state.source = loaded.source;
    setSourceBanner(loaded.source);
    populateDateFilter();
    renderAll();
  } catch (error) {
    console.error("공시 데이터 로드 실패:", error);
    setSourceBanner("error", "공시 정보를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
    renderFatalError();
  }
}

function bindTabs() {
  const tabs = Array.from(document.querySelectorAll("[role='tab']"));

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();

      let nextIndex = index;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;

      activateTab(tabs[nextIndex].dataset.tab);
      tabs[nextIndex].focus();
    });
  });
}

function activateTab(name) {
  document.querySelectorAll("[role='tab']").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });

  document.querySelectorAll("[role='tabpanel']").forEach((panel) => {
    panel.hidden = panel.id !== `panel-${name}`;
  });

  // 설정 탭이 활성화될 때마다 로그인/토큰/샘플 상태를 다시 판단해 렌더한다.
  if (name === "config") renderConfig();
}

function bindFilters() {
  const dateFilter = document.getElementById("date-filter");
  const directionFilter = document.getElementById("direction-filter");
  const bucketFilter = document.getElementById("bucket-filter");
  const tripSearch = document.getElementById("trip-search");
  const groupSearch = document.getElementById("group-search");
  const roomSearch = document.getElementById("room-search");

  dateFilter.addEventListener("change", () => {
    state.trips.date = dateFilter.value;
    renderTrips();
  });

  directionFilter.addEventListener("change", () => {
    state.trips.direction = directionFilter.value;
    renderTrips();
  });

  bucketFilter.addEventListener("change", () => {
    state.trips.bucket = bucketFilter.value;
    renderTrips();
  });

  tripSearch.addEventListener("input", () => {
    state.trips.query = normalizeSearch(tripSearch.value);
    renderTrips();
  });

  groupSearch.addEventListener("input", () => {
    state.groups.query = normalizeSearch(groupSearch.value);
    renderGroups();
  });

  roomSearch.addEventListener("input", () => {
    state.rooms.query = normalizeSearch(roomSearch.value);
    renderRooms();
  });
}

async function loadSnapshot() {
  const apiUrl = String(window.CAMP_CONFIG?.apiUrl || "").trim();
  const candidates = [];

  if (apiUrl) {
    candidates.push({ key: "live", url: apiUrl });
  }
  candidates.push(...FALLBACK_SOURCES);

  const failures = [];
  for (const candidate of candidates) {
    try {
      const snapshot = await fetchSnapshot(candidate.url);
      validateSnapshot(snapshot);
      return { source: candidate.key, snapshot };
    } catch (error) {
      failures.push(`${candidate.key}: ${error.message}`);
    }
  }

  throw new Error(failures.join(" | "));
}

async function fetchSnapshot(url) {
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "follow",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("JSON 객체가 아닙니다");
  }
  if (!SUPPORTED_SCHEMAS.includes(snapshot.schema_version)) {
    throw new Error(`지원하지 않는 스키마: ${snapshot.schema_version || "없음"}`);
  }

  const requiredStrings = ["generated_at", "updated_at", "publish_id"];
  requiredStrings.forEach((key) => {
    if (typeof snapshot[key] !== "string" || !snapshot[key].trim()) {
      throw new Error(`필수 필드 누락: ${key}`);
    }
  });

  ["notices", "groups", "vehicles", "trips", "unassigned_summary"].forEach((key) => {
    if (!Array.isArray(snapshot[key])) throw new Error(`배열 필드 누락: ${key}`);
  });

  // v2 이상은 time_slots(세션 정의)가 필수. v1은 없어도 통과(하위호환).
  const isV2Plus = ["public-snapshot/v2", "public-snapshot/v3", "public-snapshot/v4"].includes(snapshot.schema_version);
  if (isV2Plus && !Array.isArray(snapshot.time_slots)) {
    throw new Error("배열 필드 누락: time_slots");
  }
  // v3 이상은 rooms(방배정)가 필수. rooms가 있으면 배열이어야 한다.
  const isV3Plus = ["public-snapshot/v3", "public-snapshot/v4"].includes(snapshot.schema_version);
  if (isV3Plus && !Array.isArray(snapshot.rooms)) {
    throw new Error("배열 필드 누락: rooms");
  }
  if (snapshot.rooms != null && !Array.isArray(snapshot.rooms)) {
    throw new Error("배열 필드 오류: rooms");
  }

  if (!snapshot.event || snapshot.event.timezone !== "Asia/Seoul") {
    throw new Error("행사 시간대가 올바르지 않습니다");
  }
  if (!snapshot.validation || Number(snapshot.validation.blocking_error_count) > 0) {
    throw new Error("차단 검증 오류가 있는 공시본입니다");
  }

  const vehicleIds = new Set(snapshot.vehicles.map((vehicle) => vehicle.vehicle_id));
  const requireBucket = snapshot.schema_version === "public-snapshot/v4";
  snapshot.trips.forEach((trip) => {
    if (!vehicleIds.has(trip.vehicle_id)) throw new Error(`알 수 없는 차량: ${trip.vehicle_id}`);
    // v4는 time_bucket(오전/오후/밤)이 필수 파생 필드다. 값이 있으면 enum이어야 한다.
    if (requireBucket && !tripBucketLabels[trip.time_bucket]) {
      throw new Error(`시간 버킷 누락/오류: ${trip.trip_id}`);
    }
    if (trip.time_bucket != null && !tripBucketLabels[trip.time_bucket]) {
      throw new Error(`시간 버킷 값 오류: ${trip.trip_id}`);
    }
    if (!Array.isArray(trip.passengers)) throw new Error(`승객 배열 누락: ${trip.trip_id}`);
    if (Number(trip.passenger_count) !== trip.passengers.length) {
      throw new Error(`승객 수 불일치: ${trip.trip_id}`);
    }
    if (Number(trip.remaining_seats) < 0) throw new Error(`정원 초과: ${trip.trip_id}`);
    if (trip.status === "cancelled" && trip.passengers.length > 0) {
      throw new Error(`취소 운행에 탑승자가 있습니다: ${trip.trip_id}`);
    }
  });
}

function setSourceBanner(source, customDetail = "") {
  const banner = document.getElementById("source-banner");
  const icon = document.getElementById("source-icon");
  const label = document.getElementById("source-label");
  const detail = document.getElementById("source-detail");
  const copy = {
    live: ["✓", "최신 공시 정보", "Google 운영 데이터에서 확인한 최신 공시본입니다."],
    latest: ["↻", "마지막 정상 공시본", "실시간 연결 대신 저장된 마지막 정상 공시본을 표시합니다."],
    sample: ["!", "샘플 데이터", "설정 확인용 합성 데이터입니다. 실제 배정 정보가 아닙니다."],
    error: ["!", "공시 정보를 표시할 수 없습니다", customDetail]
  };
  const selected = copy[source] || copy.error;

  banner.dataset.source = source;
  icon.textContent = selected[0];
  label.textContent = selected[1];
  detail.textContent = customDetail || selected[2];
}

function populateDateFilter() {
  const filter = document.getElementById("date-filter");
  const dates = [...new Set(state.snapshot.trips.map((trip) => trip.date))].sort();

  dates.forEach((date) => {
    const option = document.createElement("option");
    option.value = date;
    option.textContent = formatDate(date, true);
    filter.append(option);
  });
}

function renderAll() {
  renderNotices();
  renderTrips();
  renderGroups();
  renderRooms();
  renderUnassigned();
  renderFooter();
}

function renderNotices() {
  const section = document.getElementById("notice-section");
  const list = document.getElementById("notice-list");
  clearNode(list);

  if (!state.snapshot.notices.length) {
    section.hidden = true;
    return;
  }

  state.snapshot.notices.forEach((notice) => {
    const article = element("article", "notice-item");
    article.dataset.severity = notice.severity || "info";
    appendTextElement(article, "strong", notice.title || "공지");
    appendTextElement(article, "p", notice.message || "");
    list.append(article);
  });
  section.hidden = false;
}

function renderTrips() {
  if (!state.snapshot) return;
  const list = document.getElementById("trip-list");
  const empty = document.getElementById("trip-empty");
  const filtered = state.snapshot.trips
    .filter((trip) => state.trips.date === "all" || trip.date === state.trips.date)
    .filter((trip) => state.trips.direction === "all" || trip.direction === state.trips.direction)
    .filter((trip) => state.trips.bucket === "all" || trip.time_bucket === state.trips.bucket)
    .filter((trip) => matchesTripSearch(trip, state.trips.query))
    .sort(compareTrips);

  clearNode(list);
  filtered.forEach((trip) => list.append(createTripCard(trip)));
  empty.hidden = filtered.length > 0;
  document.getElementById("trip-count").textContent = `${filtered.length}개 운행`;
}

function createTripCard(trip) {
  const card = element("article", "trip-card");
  card.setAttribute("aria-labelledby", `trip-title-${safeId(trip.trip_id)}`);

  const header = element("header", "trip-card-header");
  const headerText = document.createElement("div");
  const direction = element("span", "direction-chip");
  direction.dataset.direction = trip.direction;
  direction.textContent = directionLabels[trip.direction] || trip.direction;
  headerText.append(direction);

  // 시간 버킷 배지(오전/오후/밤): 아이콘+텍스트 병행, 색상 단독 금지. 정밀 시각은 아래 제목에서 병행 표시한다.
  const bucketChip = createBucketChip(trip.time_bucket);
  if (bucketChip) headerText.append(bucketChip);

  const title = element("h3");
  title.id = `trip-title-${safeId(trip.trip_id)}`;
  title.textContent = `${formatDate(trip.date, true)} ${trip.time}`;
  headerText.append(title);
  appendTextElement(headerText, "p", `집결 ${trip.meeting_point}`, "trip-time");

  const status = element("span", "status-chip");
  status.dataset.status = trip.status;
  status.textContent = tripStatusLabels[trip.status] || trip.status;
  header.append(headerText, status);

  const body = element("div", "trip-body");
  const route = element("div", "route");
  appendTextElement(route, "span", trip.origin);
  appendTextElement(route, "span", "→", "route-arrow");
  appendTextElement(route, "span", trip.destination);
  body.append(route);

  const vehicle = state.snapshot.vehicles.find((item) => item.vehicle_id === trip.vehicle_id);
  const facts = element("dl", "trip-facts");
  facts.append(
    fact("차량", vehicle?.label || trip.vehicle_id),
    fact("운전자", trip.driver_label || "공시 없음"),
    fact("전체 정원", `${trip.capacity}명 · 운전자 포함`),
    fact("남은 승객 좌석", `${trip.remaining_seats}석`, trip.remaining_seats > 2 ? "seats-good" : "seats-low")
  );
  body.append(facts);

  const details = element("details", "passenger-details");
  const summary = document.createElement("summary");
  summary.textContent = `공개 탑승 코드 ${trip.passenger_count}명 확인`;
  details.append(summary);

  const passengers = element("ul", "passenger-list");
  if (!trip.passengers.length) {
    appendTextElement(passengers, "li", "공개된 탑승 코드가 없습니다.");
  } else {
    trip.passengers.forEach((passenger) => passengers.append(createPersonRow(passenger, "boarding")));
  }
  details.append(passengers);
  body.append(details);
  card.append(header, body);
  return card;
}

// 시간 버킷 배지(오전/오후/밤). 아이콘+텍스트를 함께 써서 색상만으로 구분하지 않는다. 버킷이 없으면 null.
function createBucketChip(bucket) {
  const label = tripBucketLabels[bucket];
  if (!label) return null;
  const chip = element("span", "bucket-chip");
  chip.dataset.bucket = bucket;
  appendTextElement(chip, "span", tripBucketIcons[bucket] || "", "bucket-icon").setAttribute("aria-hidden", "true");
  appendTextElement(chip, "span", label, "bucket-text");
  chip.setAttribute("aria-label", `시간대 ${label}`);
  return chip;
}

function timeSlots(snapshot) {
  return Array.isArray(snapshot?.time_slots) ? snapshot.time_slots : [];
}

// time_slots 라벨을 열 머리글로 채운다(세션 컬럼 하나에 7세션 표기).
function renderSessionHeader(headId, snapshot) {
  const head = document.getElementById(headId);
  if (!head) return;
  const slots = timeSlots(snapshot);
  clearNode(head);
  head.append(document.createTextNode("세션"));
  if (!slots.length) return;
  appendTextElement(head, "span", ` (${slots.length}세션)`, "th-note");
}

// 참가자 한 명의 7세션 참석을 텍스트+아이콘으로 렌더(색상만으로 구분하지 않음).
function createSessionCell(snapshot, sessionSlots) {
  const cell = element("td", "session-cell");
  const slots = timeSlots(snapshot);
  const present = new Set(Array.isArray(sessionSlots) ? sessionSlots.map(String) : []);
  if (!slots.length) {
    appendTextElement(cell, "span", "세션 정보 없음", "sess-none");
    return cell;
  }
  const wrap = element("div", "session-grid");
  slots.forEach((slot) => {
    const isPresent = present.has(String(slot.slot_id));
    const chip = element("span", "sess-cell");
    chip.dataset.present = String(isPresent);
    const shortLabel = slot.label || slot.slot_id;
    chip.setAttribute("aria-label", `${shortLabel} ${isPresent ? "참석" : "불참"}`);
    chip.title = `${shortLabel} ${isPresent ? "참석" : "불참"}`;
    appendTextElement(chip, "span", isPresent ? "✓" : "–", "sess-icon");
    appendTextElement(chip, "span", shortLabel, "sess-label");
    wrap.append(chip);
  });
  cell.append(wrap);
  return cell;
}

function roleBadge(role) {
  const badge = element("span", "role-badge");
  badge.dataset.role = role || "member";
  badge.textContent = roleLabels[role] || role || "조원";
  return badge;
}

function renderGroups() {
  if (!state.snapshot) return;
  const body = document.getElementById("group-table-body");
  const empty = document.getElementById("group-empty");
  const table = document.getElementById("group-table");
  const filtered = state.snapshot.groups.filter((group) => matchesGroupSearch(group, state.groups.query));

  renderSessionHeader("group-session-head", state.snapshot);
  clearNode(body);
  let memberCount = 0;
  filtered.forEach((group) => {
    group.members.forEach((member) => {
      memberCount += 1;
      const row = document.createElement("tr");
      const groupCell = element("td", "group-cell");
      const dot = element("span", "group-dot");
      dot.style.setProperty("--group-color", safeColor(group.color));
      groupCell.append(dot);
      appendTextElement(groupCell, "span", group.display_name || group.group_id);
      row.append(groupCell);

      const nameCell = element("td", "name-cell");
      appendTextElement(nameCell, "span", member.public_name || member.public_id, "public-code");
      appendTextElement(nameCell, "span", member.public_id, "code-sub");
      row.append(nameCell);

      const roleCell = document.createElement("td");
      roleCell.append(roleBadge(member.role));
      row.append(roleCell);

      appendTextElement(row, "td", member.campus || "-");
      row.append(createSessionCell(state.snapshot, member.session_slots));
      body.append(row);
    });
  });

  const hasRows = memberCount > 0;
  table.hidden = !hasRows;
  empty.hidden = hasRows;
  document.getElementById("group-count").textContent = `${filtered.length}개 조 · ${memberCount}명`;
}

// 방 성별 범위 칩(아이콘+텍스트 병행, 색상 단독 금지).
function genderChip(scope) {
  const chip = element("span", "gender-chip");
  const meta = genderScopeLabels[scope] || genderScopeLabels.mixed;
  chip.dataset.gender = genderScopeLabels[scope] ? scope : "mixed";
  appendTextElement(chip, "span", meta.icon, "gender-icon").setAttribute("aria-hidden", "true");
  appendTextElement(chip, "span", meta.text, "gender-text");
  chip.setAttribute("aria-label", `성별 ${meta.text}`);
  return chip;
}

function renderRooms() {
  if (!state.snapshot) return;
  const list = document.getElementById("room-list");
  const empty = document.getElementById("room-empty");
  const rooms = Array.isArray(state.snapshot.rooms) ? state.snapshot.rooms : [];
  const filtered = rooms.filter((room) => matchesRoomSearch(room, state.rooms.query));

  clearNode(list);
  let personCount = 0;
  filtered.forEach((room) => {
    personCount += (room.members || []).length;
    list.append(createRoomCard(room));
  });

  empty.hidden = filtered.length > 0;
  document.getElementById("room-count").textContent = `${filtered.length}개 방 · ${personCount}명`;
}

function createRoomCard(room) {
  const card = element("article", "room-card");
  card.setAttribute("aria-labelledby", `room-title-${safeId(room.room_id)}`);

  const header = element("header", "room-card-header");
  const headText = document.createElement("div");
  const title = element("h3");
  title.id = `room-title-${safeId(room.room_id)}`;
  title.textContent = room.display_name || room.room_id;
  headText.append(title);
  appendTextElement(headText, "p", room.floor ? `${room.floor}층` : "층 미지정", "room-meta");
  header.append(headText, genderChip(room.gender_scope));

  const body = element("div", "room-body");
  const capacity = Number(room.capacity) || 0;
  const occupancy = Number(room.occupancy) || (room.members || []).length;
  const remaining = capacity - occupancy;
  const facts = element("dl", "room-facts");
  facts.append(
    fact("정원", `${capacity}명`),
    fact("현원", `${occupancy}명`),
    fact("남은 자리", remaining > 0 ? `${remaining}자리` : "정원 마감", remaining > 0 ? "seats-good" : "seats-low")
  );
  body.append(facts);

  const members = element("ul", "room-member-list");
  if (!(room.members || []).length) {
    appendTextElement(members, "li", "아직 배정된 인원이 없습니다.", "room-empty-note");
  } else {
    room.members.forEach((member) => {
      const item = element("li", "room-member");
      appendTextElement(item, "span", member.public_name || member.public_id, "public-code");
      appendTextElement(item, "span", personTypeLabels[member.person_type] || "학생", "person-type-badge");
      if (member.campus) appendTextElement(item, "span", member.campus, "member-campus");
      members.append(item);
    });
  }
  body.append(members);

  card.append(header, body);
  return card;
}

function matchesRoomSearch(room, query) {
  if (!query) return true;
  const haystack = [
    room.room_id,
    room.display_name,
    room.floor,
    ...(room.members || []).flatMap((member) => [member.public_id, member.public_name])
  ].join(" ");
  return normalizeSearch(haystack).includes(query);
}

function createPersonRow(person, mode) {
  const row = document.createElement("li");
  const identity = element("span", "public-code");
  identity.textContent = person.public_name || person.public_id;
  row.append(identity);

  if (mode === "boarding") {
    const status = element("span", "boarding-chip");
    status.dataset.status = person.boarding_status;
    status.textContent = boardingStatusLabels[person.boarding_status] || "예정";
    row.append(status);
  } else if (person.role) {
    appendTextElement(row, "span", roleLabels[person.role] || person.role, "member-role");
  }
  return row;
}

function renderUnassigned() {
  const panel = document.getElementById("unassigned-panel");
  const list = document.getElementById("unassigned-list");
  clearNode(list);

  if (!state.snapshot.unassigned_summary.length) {
    panel.hidden = true;
    return;
  }

  state.snapshot.unassigned_summary.forEach((item) => {
    const direction = directionLabels[item.direction] || item.direction;
    appendTextElement(list, "li", `${item.trip_window_id} · ${direction} · ${item.count}명 (${reasonLabel(item.reason_code)})`);
  });
  panel.hidden = false;
}

function renderFooter() {
  document.getElementById("updated-at").textContent = `마지막 공시: ${formatDateTime(state.snapshot.updated_at)}`;
  document.getElementById("publish-id").textContent = `공시본 ${state.snapshot.publish_id}`;
}

function renderFatalError() {
  document.getElementById("trip-list").replaceChildren();
  document.getElementById("group-table-body").replaceChildren();
  document.getElementById("group-table").hidden = true;
  document.getElementById("room-list").replaceChildren();
  document.getElementById("room-empty").hidden = false;
  document.getElementById("trip-empty").hidden = false;
  document.getElementById("group-empty").hidden = false;
  document.getElementById("trip-count").textContent = "0개 운행";
  document.getElementById("group-count").textContent = "0개 조";
  document.getElementById("room-count").textContent = "0개 방";
  document.getElementById("updated-at").textContent = "공시 시각을 확인할 수 없습니다.";
}

function matchesTripSearch(trip, query) {
  if (!query) return true;
  const vehicle = state.snapshot.vehicles.find((item) => item.vehicle_id === trip.vehicle_id);
  const haystack = [
    trip.trip_id,
    trip.origin,
    trip.destination,
    trip.meeting_point,
    trip.driver_label,
    tripBucketLabels[trip.time_bucket],
    vehicle?.label,
    ...trip.passengers.flatMap((passenger) => [passenger.public_id, passenger.public_name])
  ].join(" ");
  return normalizeSearch(haystack).includes(query);
}

function matchesGroupSearch(group, query) {
  if (!query) return true;
  const haystack = [
    group.group_id,
    group.display_name,
    ...group.members.flatMap((member) => [member.public_id, member.public_name, member.role])
  ].join(" ");
  return normalizeSearch(haystack).includes(query);
}

function compareTrips(a, b) {
  return `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`);
}

function normalizeSearch(value) {
  return String(value || "").trim().toLocaleLowerCase("ko-KR").replace(/\s+/g, "");
}

function formatDate(value, withWeekday = false) {
  const [year, month, day] = String(value).split("-").map(Number);
  if (!year || !month || !day) return value;
  const date = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    ...(withWeekday ? { weekday: "short" } : {})
  }).format(date);
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function fact(label, value, valueClass = "") {
  const wrapper = document.createElement("div");
  appendTextElement(wrapper, "dt", label);
  appendTextElement(wrapper, "dd", value, valueClass);
  return wrapper;
}

function reasonLabel(code) {
  const labels = {
    NO_CAPACITY: "좌석 부족",
    NO_DRIVER: "운전자 필요",
    NO_TIME_MATCH: "시간 불일치",
    ROUTE_MISMATCH: "경로 불일치",
    STATE_CONFLICT: "참석 일정 확인 필요",
    ACCESSIBILITY_MISMATCH: "접근 가능 차량 필요"
  };
  return labels[code] || "운영 확인 중";
}

function safeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#0b63ce";
}

function safeId(value) {
  return String(value || "item").replace(/[^a-zA-Z0-9_-]/g, "-");
}

function element(tagName, className = "") {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

function appendTextElement(parent, tagName, text, className = "") {
  const node = element(tagName, className);
  node.textContent = String(text ?? "");
  parent.append(node);
  return node;
}

function clearNode(node) {
  node.replaceChildren();
}

/* ── 인증 내부 뷰 ──────────────────────────────────────────────
   공용 ID/PW를 Apps Script(doPost)로 보내 서버 검증 후에만 전체 이름을 받는다.
   자격증명은 저장하지 않고, 응답(내부 스냅샷)만 sessionStorage에 임시 보관한다. */
function bindInternal() {
  const form = document.getElementById("internal-form");
  const logout = document.getElementById("internal-logout");
  if (form) form.addEventListener("submit", submitInternal);
  if (logout) logout.addEventListener("click", logoutInternal);
  restoreInternal();
}

function restoreInternal() {
  try {
    const raw = sessionStorage.getItem(INTERNAL_SESSION_KEY);
    if (!raw) return;
    const snapshot = JSON.parse(raw);
    if (snapshot && INTERNAL_SCHEMAS.includes(snapshot.schema_version)) {
      state.internal.snapshot = snapshot;
      state.internal.source = "session";
      // 쓰기 토큰도 함께 복원한다(있을 때만).
      const token = sessionStorage.getItem(INTERNAL_TOKEN_KEY);
      if (token) state.config.token = token;
      showInternalView(true);
      renderInternal();
    }
  } catch (error) {
    sessionStorage.removeItem(INTERNAL_SESSION_KEY);
  }
}

async function submitInternal(event) {
  event.preventDefault();
  const userInput = document.getElementById("internal-user");
  const passwordInput = document.getElementById("internal-password");
  const submit = document.getElementById("internal-submit");
  const user = String(userInput.value || "").trim();
  const password = String(passwordInput.value || "");
  const apiUrl = String(window.CAMP_CONFIG?.internalApiUrl || "").trim();

  setInternalMessage("", false);
  submit.disabled = true;
  submit.textContent = "확인 중…";

  try {
    let snapshot;
    if (apiUrl) {
      snapshot = await postInternal(apiUrl, user, password);
      if (!snapshot || snapshot.error || !INTERNAL_SCHEMAS.includes(snapshot.schema_version)) {
        setInternalMessage("아이디 또는 비밀번호가 올바르지 않습니다.", true);
        return;
      }
      state.internal.source = "live";
    } else {
      // 내부 API 미설정: 합성 내부 샘플로 화면을 시연한다(실데이터 아님).
      snapshot = await fetchSnapshot("data/sample-internal.json");
      if (!snapshot || !INTERNAL_SCHEMAS.includes(snapshot.schema_version)) {
        setInternalMessage("내부 API가 설정되지 않았고 샘플도 불러오지 못했습니다.", true);
        return;
      }
      state.internal.source = "sample";
    }

    state.internal.snapshot = snapshot;
    // 쓰기 토큰이 함께 오면 별도 키에 보관한다(설정 탭 저장 인증용). 비밀번호는 저장하지 않는다.
    state.config.token = (snapshot.token && typeof snapshot.token === "string") ? snapshot.token : null;
    state.config.loaded = false;
    try { sessionStorage.setItem(INTERNAL_SESSION_KEY, JSON.stringify(snapshot)); } catch (storeError) { /* 저장 실패는 화면 표시에 영향 없음 */ }
    try {
      if (state.config.token) sessionStorage.setItem(INTERNAL_TOKEN_KEY, state.config.token);
      else sessionStorage.removeItem(INTERNAL_TOKEN_KEY);
    } catch (tokenStoreError) { /* 저장 실패는 화면 표시에 영향 없음 */ }
    showInternalView(true);
    renderInternal();
  } catch (error) {
    setInternalMessage("내부 명단을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.", true);
  } finally {
    // 비밀번호는 화면/메모리에 남기지 않는다.
    passwordInput.value = "";
    submit.disabled = false;
    submit.innerHTML = '<span aria-hidden="true">🔓</span> 내부 명단 열기';
  }
}

async function postInternal(apiUrl, user, password) {
  // text/plain로 보내 CORS preflight를 피한다. Apps Script는 e.postData.contents를 JSON.parse한다.
  const response = await fetch(apiUrl, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ user, password })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function logoutInternal() {
  sessionStorage.removeItem(INTERNAL_SESSION_KEY);
  sessionStorage.removeItem(INTERNAL_TOKEN_KEY);
  state.internal.snapshot = null;
  state.internal.source = null;
  state.config.token = null;
  state.config.loaded = false;
  renderConfig();
  clearNode(document.getElementById("internal-table-body"));
  clearNode(document.getElementById("internal-room-body"));
  clearNode(document.getElementById("internal-trip-body"));
  clearNode(document.getElementById("teachers-table-body"));
  clearNode(document.getElementById("staff-table-body"));
  // 참석자 관리(PII) 상태·화면 초기화.
  state.participants.list = [];
  state.participants.private = {};
  closeParticipantForm();
  renderParticipants([], {}, true);
  showInternalView(false);
  setInternalMessage("로그아웃되었습니다.", false);
}

function showInternalView(loggedIn) {
  document.getElementById("internal-login").hidden = loggedIn;
  document.getElementById("internal-view").hidden = !loggedIn;
}

function setInternalMessage(text, isError) {
  const node = document.getElementById("internal-message");
  node.textContent = text;
  node.dataset.tone = isError ? "error" : "info";
  node.hidden = !text;
}

function renderInternal() {
  const snapshot = state.internal.snapshot;
  if (!snapshot) return;

  const statusText = {
    live: "실시간 내부 명단",
    sample: "샘플 내부 명단 (실데이터 아님)",
    session: "저장된 내부 명단"
  }[state.internal.source] || "내부 명단";
  document.getElementById("internal-status").textContent = statusText;

  renderSessionHeader("internal-session-head", snapshot);

  const body = document.getElementById("internal-table-body");
  clearNode(body);
  (snapshot.groups || []).forEach((group) => {
    (group.members || []).forEach((member) => {
      const row = document.createElement("tr");
      const groupCell = element("td", "group-cell");
      const dot = element("span", "group-dot");
      dot.style.setProperty("--group-color", safeColor(group.color));
      groupCell.append(dot);
      appendTextElement(groupCell, "span", group.display_name || group.group_id);
      row.append(groupCell);

      appendTextElement(row, "td", member.full_name || member.public_name || "-", "full-name");
      appendTextElement(row, "td", member.public_id || "-", "code-sub");
      const roleCell = document.createElement("td");
      roleCell.append(roleBadge(member.role));
      row.append(roleCell);
      appendTextElement(row, "td", member.campus || "-");
      row.append(createSessionCell(snapshot, member.session_slots));
      body.append(row);
    });
  });

  renderInternalRooms(snapshot);
  renderInternalTrips(snapshot);
  renderDirectory("teachers-table-body", snapshot.teachers, snapshot.groups);
  renderDirectory("staff-table-body", snapshot.staff, snapshot.groups);
}

// 내부(인증) 방배정: 전체 이름으로 방/층/성별/정원·현원과 함께 표시한다.
function renderInternalRooms(snapshot) {
  const body = document.getElementById("internal-room-body");
  if (!body) return;
  clearNode(body);
  const rooms = Array.isArray(snapshot.rooms) ? snapshot.rooms : [];

  if (!rooms.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "empty-cell";
    cell.textContent = "등록된 방배정이 없습니다.";
    row.append(cell);
    body.append(row);
    return;
  }

  rooms.forEach((room) => {
    const members = room.members || [];
    const capacity = Number(room.capacity) || 0;
    const occupancy = Number(room.occupancy) || members.length;
    if (!members.length) {
      const row = document.createElement("tr");
      appendTextElement(row, "td", room.display_name || room.room_id);
      appendTextElement(row, "td", room.floor ? `${room.floor}층` : "-");
      const genderCell = document.createElement("td");
      genderCell.append(genderChip(room.gender_scope));
      row.append(genderCell);
      appendTextElement(row, "td", `${capacity} · ${occupancy}`);
      const note = appendTextElement(row, "td", "배정 인원 없음", "empty-cell");
      note.colSpan = 4;
      body.append(row);
      return;
    }
    members.forEach((member) => {
      const row = document.createElement("tr");
      appendTextElement(row, "td", room.display_name || room.room_id);
      appendTextElement(row, "td", room.floor ? `${room.floor}층` : "-");
      const genderCell = document.createElement("td");
      genderCell.append(genderChip(room.gender_scope));
      row.append(genderCell);
      appendTextElement(row, "td", `${capacity} · ${occupancy}`);
      appendTextElement(row, "td", member.full_name || member.public_name || "-", "full-name");
      appendTextElement(row, "td", member.public_id || "-", "code-sub");
      appendTextElement(row, "td", personTypeLabels[member.person_type] || "학생");
      appendTextElement(row, "td", member.campus || "-");
      body.append(row);
    });
  });
}

// 내부(인증) 차량 운행: 탑승자를 전체 이름으로 표시한다. 시간대 배지는 공개 뷰와 동일 어휘(오전/오후/밤).
function renderInternalTrips(snapshot) {
  const body = document.getElementById("internal-trip-body");
  if (!body) return;
  clearNode(body);
  const trips = Array.isArray(snapshot.trips) ? [...snapshot.trips].sort(compareTrips) : [];
  const vehicles = Array.isArray(snapshot.vehicles) ? snapshot.vehicles : [];

  if (!trips.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "empty-cell";
    cell.textContent = "등록된 차량 운행이 없습니다.";
    row.append(cell);
    body.append(row);
    return;
  }

  trips.forEach((trip) => {
    const row = document.createElement("tr");
    appendTextElement(row, "td", `${formatDate(trip.date, true)} ${trip.time}`);

    const bucketCell = document.createElement("td");
    const chip = createBucketChip(trip.time_bucket);
    if (chip) bucketCell.append(chip); else bucketCell.textContent = "-";
    row.append(bucketCell);

    appendTextElement(row, "td", directionLabels[trip.direction] || trip.direction);
    const vehicle = vehicles.find((item) => item.vehicle_id === trip.vehicle_id);
    appendTextElement(row, "td", vehicle?.label || trip.vehicle_id);

    // 내부 뷰는 전체 이름(full_name)을 우선 표시하고, 없으면 마스킹 표시명으로 폴백한다.
    const names = (trip.passengers || [])
      .map((passenger) => passenger.full_name || passenger.public_name || passenger.public_id)
      .join(", ");
    appendTextElement(row, "td", names || "탑승자 없음", "full-name");
    body.append(row);
  });
}

function renderDirectory(bodyId, people, groups) {
  const body = document.getElementById(bodyId);
  clearNode(body);
  const groupNames = {};
  (groups || []).forEach((group) => { groupNames[group.group_id] = group.display_name || group.group_id; });

  if (!Array.isArray(people) || !people.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.className = "empty-cell";
    cell.textContent = "등록된 인원이 없습니다.";
    row.append(cell);
    body.append(row);
    return;
  }

  people.forEach((person) => {
    const row = document.createElement("tr");
    appendTextElement(row, "td", person.full_name || "-", "full-name");
    appendTextElement(row, "td", person.campus || "-");
    appendTextElement(row, "td", person.group_id ? (groupNames[person.group_id] || person.group_id) : "미배정");
    body.append(row);
  });
}

/* ── 관리자 설정 탭(Phase A-3) ─────────────────────────────────
   로그인으로 받은 쓰기 토큰으로 Apps Script(doPost)에 {action, token, payload}를 보내
   설정·매핑·조·방·차량을 편집한다. 비밀번호는 저장하지 않고, 토큰만 sessionStorage에 임시 보관한다. */
function bindConfig() {
  const form = document.getElementById("config-settings-form");
  if (form) form.addEventListener("submit", onSaveSettings);
  bindConfigClick("config-reload", () => { state.config.loaded = false; loadConfig(); });
  bindConfigClick("config-ensure-groups", () => runEnsure("ensure_group_count", "config-settings-msg", "조 개수를 Settings 기준으로 맞췄습니다."));
  bindConfigClick("config-ensure-rooms", () => runEnsure("ensure_room_count", "config-settings-msg", "방 개수를 Settings 기준으로 맞췄습니다."));
  bindConfigClick("config-fieldmap-add", () => addConfigRow("config-fieldmap-body", fieldMapRowNode));
  bindConfigClick("config-fieldmap-save", () => saveConfig("save_field_map", collectConfigRows("config-fieldmap-body"), "config-fieldmap-msg", "필드 매핑을 저장했습니다."));
  bindConfigClick("config-groups-add", () => addConfigRow("config-groups-body", groupRowNode));
  bindConfigClick("config-groups-save", () => saveConfig("save_groups", collectConfigRows("config-groups-body"), "config-groups-msg", "조 정보를 저장했습니다."));
  bindConfigClick("config-rooms-add", () => addConfigRow("config-rooms-body", roomRowNode));
  bindConfigClick("config-rooms-save", () => saveConfig("save_rooms", collectConfigRows("config-rooms-body"), "config-rooms-msg", "방 정보를 저장했습니다."));
  bindConfigClick("config-vehicles-add", () => addConfigRow("config-vehicles-body", vehicleRowNode));
  bindConfigClick("config-vehicles-save", () => saveConfig("save_vehicles", collectConfigRows("config-vehicles-body"), "config-vehicles-msg", "차량 정보를 저장했습니다."));
}

function bindConfigClick(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", fn);
}

function onSaveSettings(event) {
  event.preventDefault();
  if (state.config.disabled) return;
  const payload = {};
  CONFIG_SETTINGS_KEYS.forEach((key) => {
    const input = document.querySelector(`#config-settings-form [data-setting="${key}"]`);
    payload[key] = input ? input.value : "";
  });
  saveConfig("save_settings", payload, "config-settings-msg", "설정을 저장했습니다.");
}

// 로그인/토큰/샘플 상태에 따라 안내(gate)만 보일지, 편집 본문(body)을 보일지 결정한다.
function renderConfig() {
  const gate = document.getElementById("config-gate");
  const gateText = document.getElementById("config-gate-text");
  const body = document.getElementById("config-body");
  const reload = document.getElementById("config-reload");
  const modeNote = document.getElementById("config-mode-note");
  if (!gate || !body) return;

  const loggedIn = !!state.internal.snapshot;
  const apiUrl = String(window.CAMP_CONFIG?.internalApiUrl || "").trim();
  const hasToken = !!state.config.token;
  reload.hidden = true;
  modeNote.hidden = true;

  if (!loggedIn) {
    body.hidden = true;
    gate.hidden = false;
    gate.dataset.tone = "info";
    gateText.textContent = "내부 명단 탭에서 먼저 로그인하세요. 로그인하면 이 화면에서 설정을 편집할 수 있습니다.";
    return;
  }

  if (!apiUrl) {
    // 샘플(데모) 모드: 백엔드가 없어 저장할 수 없다. 폼은 비활성 상태로만 보여준다.
    gate.hidden = true;
    body.hidden = false;
    modeNote.hidden = false;
    modeNote.textContent = "샘플(데모) 모드입니다. 실제 백엔드(config.js의 internalApiUrl)를 연결해야 설정을 저장할 수 있습니다.";
    applyConfigData(emptyConfigData(), true);
    // 참석자 관리는 PII를 다루므로 샘플 모드에서 비활성(실서버에서만 조회/편집).
    renderParticipants([], {}, true);
    return;
  }

  if (!hasToken) {
    body.hidden = true;
    gate.hidden = false;
    gate.dataset.tone = "warn";
    gateText.textContent = "서버에 토큰 비밀키(CAMP_INTERNAL_TOKEN_SECRET)가 설정되지 않아 설정 편집이 비활성화되었습니다. 관리자에게 문의하세요.";
    return;
  }

  gate.hidden = true;
  body.hidden = false;
  reload.hidden = false;
  if (!state.config.loaded && !state.config.loading) loadConfig();
}

async function loadConfig() {
  const apiUrl = String(window.CAMP_CONFIG?.internalApiUrl || "").trim();
  if (!apiUrl || !state.config.token) return;
  state.config.loading = true;
  try {
    const data = await postConfigAction("get_config", null);
    if (data && data.error) {
      if (handleConfigSessionError(data.error)) return;
      applyConfigData(emptyConfigData(), true);
      return;
    }
    state.config.loaded = true;
    applyConfigData(data, false);
    // 설정 로드 성공 후 참석자 목록(PII)도 함께 불러온다(같은 토큰·서버).
    loadParticipants();
  } catch (error) {
    applyConfigData(emptyConfigData(), true);
    renderParticipants([], {}, true);
  } finally {
    state.config.loading = false;
  }
}

// 세션 만료/미인증이면 토큰을 비우고 안내 gate를 띄운다. 처리했으면 true.
function handleConfigSessionError(code) {
  if (code !== "token_expired" && code !== "unauthorized") return false;
  state.config.token = null;
  state.config.loaded = false;
  try { sessionStorage.removeItem(INTERNAL_TOKEN_KEY); } catch (error) { /* noop */ }
  const gate = document.getElementById("config-gate");
  const gateText = document.getElementById("config-gate-text");
  document.getElementById("config-body").hidden = true;
  document.getElementById("config-reload").hidden = true;
  gate.hidden = false;
  gate.dataset.tone = "warn";
  gateText.textContent = CONFIG_ERROR_MESSAGES[code];
  return true;
}

async function postConfigAction(action, payload) {
  const apiUrl = String(window.CAMP_CONFIG?.internalApiUrl || "").trim();
  if (!apiUrl) throw new Error("internalApiUrl 미설정");
  // text/plain으로 보내 CORS preflight를 피한다(내부 뷰 로그인과 동일 패턴).
  const response = await fetch(apiUrl, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, token: state.config.token, payload })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function saveConfig(action, payload, msgId, okText) {
  if (state.config.disabled) return;
  clearConfigMsg(msgId);
  try {
    const data = await postConfigAction(action, payload);
    if (data && data.error) {
      if (handleConfigSessionError(data.error)) return;
      showConfigMsg(msgId, CONFIG_ERROR_MESSAGES[data.error] || "저장하지 못했습니다.", "error", data.issues);
      return;
    }
    // 성공: 서버가 부여한 새 id·상태를 반영하기 위해 재로딩한 뒤 안내한다.
    const warnings = Array.isArray(data.warnings) ? data.warnings : [];
    await loadConfig();
    showConfigMsg(msgId, okText + (warnings.length ? ` (경고 ${warnings.length}건)` : ""), warnings.length ? "warn" : "info", warnings);
  } catch (error) {
    showConfigMsg(msgId, CONFIG_ERROR_MESSAGES.temporarily_unavailable, "error");
  }
}

async function runEnsure(action, msgId, okText) {
  if (state.config.disabled) return;
  clearConfigMsg(msgId);
  try {
    const data = await postConfigAction(action, null);
    if (data && data.error) {
      if (handleConfigSessionError(data.error)) return;
      showConfigMsg(msgId, CONFIG_ERROR_MESSAGES[data.error] || "실행하지 못했습니다.", "error");
      return;
    }
    await loadConfig();
    showConfigMsg(msgId, okText, "info");
  } catch (error) {
    showConfigMsg(msgId, CONFIG_ERROR_MESSAGES.temporarily_unavailable, "error");
  }
}

function applyConfigData(data, disabled) {
  state.config.disabled = disabled;
  data = data || {};
  CONFIG_SETTINGS_KEYS.forEach((key) => {
    const input = document.querySelector(`#config-settings-form [data-setting="${key}"]`);
    if (!input) return;
    input.value = (data.settings && data.settings[key] != null) ? String(data.settings[key]) : "";
    input.disabled = disabled;
  });

  const datalist = document.getElementById("config-form-headers");
  clearNode(datalist);
  const headers = data.form_headers || {};
  [...new Set([...(headers.students || []), ...(headers.staff || [])])].forEach((header) => {
    const option = document.createElement("option");
    option.value = String(header);
    datalist.append(option);
  });

  renderConfigTable("config-fieldmap-body", data.field_map, fieldMapRowNode, disabled);
  renderConfigTable("config-groups-body", data.groups, groupRowNode, disabled);
  renderConfigTable("config-rooms-body", data.rooms, roomRowNode, disabled);
  renderConfigTable("config-vehicles-body", data.vehicles, vehicleRowNode, disabled);
  setConfigButtonsDisabled(disabled);
}

function setConfigButtonsDisabled(disabled) {
  [
    "config-settings-save", "config-ensure-groups", "config-ensure-rooms",
    "config-fieldmap-add", "config-fieldmap-save",
    "config-groups-add", "config-groups-save",
    "config-rooms-add", "config-rooms-save",
    "config-vehicles-add", "config-vehicles-save"
  ].forEach((id) => { const button = document.getElementById(id); if (button) button.disabled = disabled; });
}

function emptyConfigData() {
  return { settings: {}, field_map: [], groups: [], rooms: [], vehicles: [], lookups: [], form_headers: { students: [], staff: [] } };
}

function renderConfigTable(bodyId, rows, builder, disabled) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  clearNode(body);
  (Array.isArray(rows) ? rows : []).forEach((row) => body.append(builder(row, disabled)));
}

function addConfigRow(bodyId, builder) {
  if (state.config.disabled) return;
  document.getElementById(bodyId).append(builder({ active: true }, false));
}

function collectConfigRows(bodyId) {
  return Array.from(document.getElementById(bodyId).querySelectorAll("tr")).map((tr) => {
    const object = {};
    tr.querySelectorAll("[data-field]").forEach((element) => {
      object[element.dataset.field] = element.type === "checkbox" ? element.checked : element.value;
    });
    return object;
  });
}

// ── 편집 셀 빌더(값은 textContent/value로만 주입, innerHTML 미사용) ──
function cfgInput(type, value, field, opts) {
  opts = opts || {};
  const input = document.createElement("input");
  input.type = type;
  input.dataset.field = field;
  if (type === "checkbox") input.checked = !!value;
  else input.value = value == null ? "" : String(value);
  if (opts.readOnly) input.readOnly = true;
  if (opts.disabled) input.disabled = true;
  if (opts.list) input.setAttribute("list", opts.list);
  if (opts.min != null) input.min = String(opts.min);
  if (opts.max != null) input.max = String(opts.max);
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.setAttribute("aria-label", opts.ariaLabel || field);
  return input;
}

function cfgSelect(options, value, field, opts) {
  opts = opts || {};
  const select = document.createElement("select");
  select.dataset.field = field;
  options.forEach(([optionValue, label]) => {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    if (String(optionValue) === String(value == null ? "" : value)) option.selected = true;
    select.append(option);
  });
  if (opts.disabled) select.disabled = true;
  select.setAttribute("aria-label", opts.ariaLabel || field);
  return select;
}

function cfgCell(node) {
  const td = document.createElement("td");
  if (node) td.append(node);
  return td;
}

// 상태 칩: 신규(id 없음) / 배정 있음(비활성 불가) / 기존.
function cfgStatusCell(idValue, hasAssignments) {
  const td = document.createElement("td");
  const chip = element("span", "config-status-chip");
  if (!idValue) { chip.dataset.kind = "new"; chip.textContent = "신규"; }
  else if (hasAssignments) { chip.dataset.kind = "locked"; chip.textContent = "배정 있음"; }
  else { chip.dataset.kind = "active"; chip.textContent = "기존"; }
  td.append(chip);
  return td;
}

function cfgRemoveCell(disabled) {
  const td = document.createElement("td");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "config-row-remove";
  button.textContent = "삭제";
  button.setAttribute("aria-label", "이 매핑 행 삭제");
  if (disabled) button.disabled = true;
  button.addEventListener("click", () => { const tr = button.closest("tr"); if (tr) tr.remove(); });
  td.append(button);
  return td;
}

function fieldMapRowNode(row, disabled) {
  row = row || {};
  const tr = document.createElement("tr");
  tr.append(cfgCell(cfgSelect(FIELD_MAP_SOURCES.map((source) => [source, source]), row.source_sheet || FIELD_MAP_SOURCES[0], "source_sheet", { disabled, ariaLabel: "원본 시트" })));
  tr.append(cfgCell(cfgInput("text", row.source_header, "source_header", { disabled, list: "config-form-headers", placeholder: "질문 헤더", ariaLabel: "원본 헤더" })));
  tr.append(cfgCell(cfgSelect(Object.keys(NORMALIZED_FIELD_LABELS).map((key) => [key, NORMALIZED_FIELD_LABELS[key]]), row.normalized_field || "legal_name", "normalized_field", { disabled, ariaLabel: "정규 필드" })));
  tr.append(cfgCell(cfgInput("checkbox", row.required, "required", { disabled, ariaLabel: "필수 여부" })));
  tr.append(cfgCell(cfgInput("checkbox", row.active == null ? true : row.active, "active", { disabled, ariaLabel: "활성 여부" })));
  tr.append(cfgRemoveCell(disabled));
  return tr;
}

function groupRowNode(row, disabled) {
  row = row || {};
  const tr = document.createElement("tr");
  const id = row.group_id || "";
  const activeDisabled = disabled || !!row.has_assignments;
  tr.append(cfgCell(cfgInput("text", id, "group_id", { readOnly: true, placeholder: "(신규)", ariaLabel: "조 ID" })));
  tr.append(cfgCell(cfgInput("text", row.display_name, "display_name", { disabled, placeholder: "예: 1조", ariaLabel: "조 이름" })));
  tr.append(cfgCell(cfgInput("text", row.color, "color", { disabled, placeholder: "#2563EB", ariaLabel: "색" })));
  tr.append(cfgCell(cfgInput("number", row.target_size, "target_size", { disabled, min: 0, ariaLabel: "목표 인원" })));
  tr.append(cfgCell(cfgInput("number", row.min_size, "min_size", { disabled, min: 0, ariaLabel: "최소 인원" })));
  tr.append(cfgCell(cfgInput("number", row.max_size, "max_size", { disabled, min: 0, ariaLabel: "최대 인원" })));
  tr.append(cfgCell(cfgInput("checkbox", row.active == null ? true : row.active, "active", { disabled: activeDisabled, ariaLabel: "활성 여부" })));
  tr.append(cfgStatusCell(id, row.has_assignments));
  return tr;
}

function roomRowNode(row, disabled) {
  row = row || {};
  const tr = document.createElement("tr");
  const id = row.room_id || "";
  const activeDisabled = disabled || !!row.has_assignments;
  tr.append(cfgCell(cfgInput("text", id, "room_id", { readOnly: true, placeholder: "(신규)", ariaLabel: "방 ID" })));
  tr.append(cfgCell(cfgInput("text", row.display_name, "display_name", { disabled, placeholder: "예: 101호", ariaLabel: "방 이름" })));
  tr.append(cfgCell(cfgInput("number", row.capacity, "capacity", { disabled, min: 1, ariaLabel: "정원" })));
  tr.append(cfgCell(cfgSelect(GENDER_SCOPE_OPTIONS, row.gender_scope || "mixed", "gender_scope", { disabled, ariaLabel: "성별 범위" })));
  tr.append(cfgCell(cfgInput("text", row.floor, "floor", { disabled, placeholder: "예: 1", ariaLabel: "층" })));
  tr.append(cfgCell(cfgInput("checkbox", row.active == null ? true : row.active, "active", { disabled: activeDisabled, ariaLabel: "활성 여부" })));
  tr.append(cfgStatusCell(id, row.has_assignments));
  return tr;
}

function vehicleRowNode(row, disabled) {
  row = row || {};
  const tr = document.createElement("tr");
  const id = row.vehicle_id || "";
  const activeDisabled = disabled || !!row.has_assignments;
  tr.append(cfgCell(cfgInput("text", id, "vehicle_id", { readOnly: true, placeholder: "(신규)", ariaLabel: "차량 ID" })));
  tr.append(cfgCell(cfgInput("text", row.public_label, "public_label", { disabled, placeholder: "예: 1호차", ariaLabel: "공개 표시명" })));
  tr.append(cfgCell(cfgInput("number", row.capacity_total, "capacity_total", { disabled, min: 2, ariaLabel: "전체 정원(운전자 포함)" })));
  tr.append(cfgCell(cfgInput("checkbox", row.accessible, "accessible", { disabled, ariaLabel: "휠체어 접근 가능" })));
  tr.append(cfgCell(cfgInput("checkbox", row.active == null ? true : row.active, "active", { disabled: activeDisabled, ariaLabel: "활성 여부" })));
  tr.append(cfgStatusCell(id, row.has_assignments));
  return tr;
}

function clearConfigMsg(msgId) {
  const node = document.getElementById(msgId);
  if (!node) return;
  clearNode(node);
  node.hidden = true;
}

function showConfigMsg(msgId, text, tone, issues) {
  const node = document.getElementById(msgId);
  if (!node) return;
  clearNode(node);
  node.dataset.tone = tone || "info";
  node.hidden = false;
  appendTextElement(node, "span", text);
  if (Array.isArray(issues) && issues.length) {
    const list = element("ul", "config-issue-list");
    issues.forEach((item) => appendTextElement(list, "li", configIssueText(item)));
    node.append(list);
  }
}

function configIssueText(issue) {
  const ref = (issue.ref != null && issue.ref !== "") ? ` [${issue.ref}]` : "";
  return `${issue.message || issue.code || "확인 필요"}${ref}`;
}

/* ── 참석자 관리(Phase B) ─────────────────────────────────
   인증 토큰으로 get_participants/save_participant/deactivate_participant를 호출한다.
   실명·연락처(PII)를 서버에서만 받아 화면에 표시하며 정적 저장하지 않는다.
   값 주입은 textContent/value로만 하여 XSS를 방지한다. */
function bindParticipants() {
  fillSelect("cp-person_type", PARTICIPANT_PERSON_TYPE_OPTIONS);
  fillSelect("cp-campus", PARTICIPANT_CAMPUS_OPTIONS);
  fillSelect("cp-grade_band", PARTICIPANT_GRADE_OPTIONS);
  fillSelect("cp-gender", PARTICIPANT_GENDER_OPTIONS);

  const search = document.getElementById("config-participants-search");
  if (search) search.addEventListener("input", () => {
    state.participants.query = search.value || "";
    renderParticipants(state.participants.list, state.participants.private, state.participants.disabled);
  });
  bindConfigClick("config-participants-add", () => openParticipantForm(null));
  bindConfigClick("config-participant-cancel", closeParticipantForm);
  bindConfigClick("config-participant-deactivate", onDeactivateParticipant);
  const form = document.getElementById("config-participant-form");
  if (form) form.addEventListener("submit", onSaveParticipant);
}

function fillSelect(id, options) {
  const select = document.getElementById(id);
  if (!select) return;
  clearNode(select);
  options.forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  });
}

async function loadParticipants() {
  const apiUrl = String(window.CAMP_CONFIG?.internalApiUrl || "").trim();
  if (!apiUrl || !state.config.token) { renderParticipants([], {}, true); return; }
  try {
    const data = await postConfigAction("get_participants", null);
    if (data && data.error) {
      if (handleConfigSessionError(data.error)) return;
      renderParticipants([], {}, true);
      return;
    }
    state.participants.list = Array.isArray(data.participants) ? data.participants : [];
    state.participants.private = (data.private && typeof data.private === "object") ? data.private : {};
    renderParticipants(state.participants.list, state.participants.private, false);
  } catch (error) {
    renderParticipants([], {}, true);
  }
}

// 목록 렌더. disabled면 편집·추가를 잠그고 샘플/미연결 안내만 보인다.
function renderParticipants(list, priv, disabled) {
  state.participants.disabled = !!disabled;
  const body = document.getElementById("config-participants-body");
  if (!body) return;
  clearNode(body);

  const addButton = document.getElementById("config-participants-add");
  if (addButton) addButton.disabled = !!disabled;

  if (disabled) {
    closeParticipantForm();
    showConfigMsg("config-participants-msg", "샘플(데모) 모드에서는 참석자 관리를 사용할 수 없습니다. 실명·연락처는 실서버(백엔드 연결) 인증 화면에서만 조회·편집됩니다.", "info");
    appendParticipantEmptyRow(body, "참석자 정보는 실서버에서만 표시됩니다.");
    return;
  }
  clearConfigMsg("config-participants-msg");

  const query = String(state.participants.query || "").trim().toLowerCase();
  const filtered = (Array.isArray(list) ? list : []).filter((p) => {
    if (!query) return true;
    const haystack = [p.legal_name, personTypeLabels[p.person_type] || p.person_type, PARTICIPANT_CAMPUS_LABELS[p.campus] || p.campus, PARTICIPANT_GRADE_LABELS[p.grade_band] || p.grade_band]
      .map((v) => String(v == null ? "" : v).toLowerCase()).join(" ");
    return haystack.includes(query);
  });

  if (!filtered.length) {
    appendParticipantEmptyRow(body, query ? "검색 결과가 없습니다." : "등록된 참석자가 없습니다.");
    return;
  }

  filtered.forEach((p) => body.append(participantRowNode(p)));
}

function appendParticipantEmptyRow(body, text) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 9;
  cell.className = "empty-cell";
  cell.textContent = text;
  row.append(cell);
  body.append(row);
}

function participantRowNode(p) {
  const tr = document.createElement("tr");
  if (!bool(p.active)) tr.classList.add("is-inactive");
  appendTextElement(tr, "td", p.legal_name || "-", "full-name");
  appendTextElement(tr, "td", personTypeLabels[p.person_type] || p.person_type || "-");
  appendTextElement(tr, "td", PARTICIPANT_CAMPUS_LABELS[p.campus] || p.campus || "-");
  appendTextElement(tr, "td", PARTICIPANT_GRADE_LABELS[p.grade_band] || p.grade_band || "-");
  appendTextElement(tr, "td", PARTICIPANT_GENDER_LABELS[p.gender] || p.gender || "-");
  // 색상만으로 상태를 구분하지 않고 아이콘+텍스트를 함께 쓴다.
  appendTextElement(tr, "td", bool(p.public_consent) ? "✔ 동의" : "✖ 미동의");
  const traits = [];
  if (bool(p.newcomer)) traits.push("새친구");
  if (bool(p.leader_candidate)) traits.push("리더");
  appendTextElement(tr, "td", traits.length ? traits.join(", ") : "-");
  appendTextElement(tr, "td", bool(p.active) ? "✔ 활성" : "⛔ 비활성");

  const editCell = document.createElement("td");
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "config-secondary config-row-edit";
  editButton.textContent = "편집";
  editButton.setAttribute("aria-label", `${p.legal_name || "참석자"} 편집`);
  editButton.addEventListener("click", () => openParticipantForm(p));
  editCell.append(editButton);
  tr.append(editCell);
  return tr;
}

// bool 유틸(시트의 'TRUE'/JS true/문자열 모두 수용). Core.bool과 동일 취지.
function bool(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return ["true", "1", "y", "yes", "예"].includes(normalized);
}

// 편집 폼 열기. participant=null이면 신규(추가), 객체면 수정(id 불변, 서버가 보존).
function openParticipantForm(participant) {
  if (state.participants.disabled) return;
  const form = document.getElementById("config-participant-form");
  if (!form) return;
  clearConfigMsg("config-participant-form-msg");

  const isEdit = !!(participant && participant.participant_id);
  document.getElementById("config-participant-form-title").textContent = isEdit ? "참석자 수정" : "참석자 추가";
  setVal("cp-participant_id", isEdit ? participant.participant_id : "");

  const p = participant || {};
  setVal("cp-legal_name", p.legal_name || "");
  setVal("cp-public_name", p.public_name || "");
  setVal("cp-person_type", p.person_type || "student");
  setVal("cp-campus", p.campus || "");
  setVal("cp-grade_band", p.grade_band || "");
  setVal("cp-gender", p.gender || "");
  setVal("cp-engagement_score", p.engagement_score != null && p.engagement_score !== "" ? p.engagement_score : 3);
  setVal("cp-extraversion_score", p.extraversion_score != null && p.extraversion_score !== "" ? p.extraversion_score : 3);
  setChecked("cp-newcomer", bool(p.newcomer));
  setChecked("cp-leader_candidate", bool(p.leader_candidate));
  setChecked("cp-public_consent", bool(p.public_consent));

  // 민감필드는 get_participants의 private 맵에서만 채운다(목록 행에는 없음).
  const privateFields = (isEdit && state.participants.private[participant.participant_id]) || {};
  setVal("cp-phone", privateFields.phone || "");
  setVal("cp-birth_date", privateFields.birth_date || "");
  setVal("cp-guardian_phone", privateFields.guardian_phone || "");
  setVal("cp-insurance_status", privateFields.insurance_status || "");
  setVal("cp-private_note", privateFields.private_note || "");

  // 비활성 버튼은 기존(수정) 대상에만 노출한다.
  const deactivateButton = document.getElementById("config-participant-deactivate");
  if (deactivateButton) deactivateButton.hidden = !isEdit;

  form.hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
  const nameInput = document.getElementById("cp-legal_name");
  if (nameInput) nameInput.focus();
}

function closeParticipantForm() {
  const form = document.getElementById("config-participant-form");
  if (form) form.hidden = true;
}

function collectParticipantPayload() {
  // 공개모델(participant)에는 민감필드를 절대 넣지 않는다(서버 PARTICIPANT_PRIVATE_LEAK 방어와 이중 안전).
  const participant = {
    person_type: getVal("cp-person_type"),
    legal_name: getVal("cp-legal_name"),
    public_name: getVal("cp-public_name"),
    campus: getVal("cp-campus"),
    grade_band: getVal("cp-grade_band"),
    gender: getVal("cp-gender"),
    engagement_score: getVal("cp-engagement_score"),
    extraversion_score: getVal("cp-extraversion_score"),
    newcomer: getChecked("cp-newcomer"),
    leader_candidate: getChecked("cp-leader_candidate"),
    public_consent: getChecked("cp-public_consent")
  };
  const id = getVal("cp-participant_id");
  if (id) participant.participant_id = id;
  const priv = {
    phone: getVal("cp-phone"),
    birth_date: getVal("cp-birth_date"),
    guardian_phone: getVal("cp-guardian_phone"),
    insurance_status: getVal("cp-insurance_status"),
    private_note: getVal("cp-private_note")
  };
  return { participant, private: priv };
}

async function onSaveParticipant(event) {
  event.preventDefault();
  if (state.participants.disabled) return;
  const msgId = "config-participant-form-msg";
  clearConfigMsg(msgId);
  const saveButton = document.getElementById("config-participant-save");
  if (saveButton) saveButton.disabled = true;
  try {
    const data = await postConfigAction("save_participant", collectParticipantPayload());
    if (data && data.error) {
      if (handleConfigSessionError(data.error)) return;
      showConfigMsg(msgId, CONFIG_ERROR_MESSAGES[data.error] || "저장하지 못했습니다.", "error", data.issues);
      return;
    }
    closeParticipantForm();
    await loadParticipants();
    showConfigMsg("config-participants-msg", "참석자 정보를 저장했습니다.", "info");
  } catch (error) {
    showConfigMsg(msgId, CONFIG_ERROR_MESSAGES.temporarily_unavailable, "error");
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

async function onDeactivateParticipant() {
  if (state.participants.disabled) return;
  const id = getVal("cp-participant_id");
  if (!id) return;
  const name = getVal("cp-legal_name") || "이 참석자";
  if (!window.confirm(`${name}을(를) 비활성 처리할까요? (삭제가 아니라 명단에서 숨겨지며 기존 배정은 유지됩니다.)`)) return;
  const msgId = "config-participant-form-msg";
  clearConfigMsg(msgId);
  try {
    const data = await postConfigAction("deactivate_participant", { participant_id: id });
    if (data && data.error) {
      if (handleConfigSessionError(data.error)) return;
      showConfigMsg(msgId, CONFIG_ERROR_MESSAGES[data.error] || "처리하지 못했습니다.", "error");
      return;
    }
    closeParticipantForm();
    await loadParticipants();
    showConfigMsg("config-participants-msg", "참석자를 비활성 처리했습니다.", "info");
  } catch (error) {
    showConfigMsg(msgId, CONFIG_ERROR_MESSAGES.temporarily_unavailable, "error");
  }
}

// ── 폼 값 유틸(값 주입은 value/checked로만) ──
function getVal(id) { const el = document.getElementById(id); return el ? el.value : ""; }
function setVal(id, value) { const el = document.getElementById(id); if (el) el.value = value == null ? "" : String(value); }
function getChecked(id) { const el = document.getElementById(id); return !!(el && el.checked); }
function setChecked(id, value) { const el = document.getElementById(id); if (el) el.checked = !!value; }
