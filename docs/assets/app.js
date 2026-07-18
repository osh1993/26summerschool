"use strict";

const SUPPORTED_SCHEMAS = ["public-snapshot/v1", "public-snapshot/v2"];
const INTERNAL_SCHEMA = "internal-snapshot/v1";
const INTERNAL_SESSION_KEY = "camp.internal.snapshot";
const FALLBACK_SOURCES = [
  { key: "latest", url: "data/latest.json" },
  { key: "sample", url: "data/sample.json" }
];

const state = {
  snapshot: null,
  source: "loading",
  trips: {
    date: "all",
    direction: "all",
    query: ""
  },
  groups: {
    query: ""
  },
  internal: {
    snapshot: null,
    source: null
  }
};

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

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindTabs();
  bindFilters();
  bindInternal();

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
}

function bindFilters() {
  const dateFilter = document.getElementById("date-filter");
  const directionFilter = document.getElementById("direction-filter");
  const tripSearch = document.getElementById("trip-search");
  const groupSearch = document.getElementById("group-search");

  dateFilter.addEventListener("change", () => {
    state.trips.date = dateFilter.value;
    renderTrips();
  });

  directionFilter.addEventListener("change", () => {
    state.trips.direction = directionFilter.value;
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

  // v2는 time_slots(세션 정의)가 필수. v1은 없어도 통과(하위호환).
  if (snapshot.schema_version === "public-snapshot/v2" && !Array.isArray(snapshot.time_slots)) {
    throw new Error("배열 필드 누락: time_slots");
  }

  if (!snapshot.event || snapshot.event.timezone !== "Asia/Seoul") {
    throw new Error("행사 시간대가 올바르지 않습니다");
  }
  if (!snapshot.validation || Number(snapshot.validation.blocking_error_count) > 0) {
    throw new Error("차단 검증 오류가 있는 공시본입니다");
  }

  const vehicleIds = new Set(snapshot.vehicles.map((vehicle) => vehicle.vehicle_id));
  snapshot.trips.forEach((trip) => {
    if (!vehicleIds.has(trip.vehicle_id)) throw new Error(`알 수 없는 차량: ${trip.vehicle_id}`);
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
  document.getElementById("trip-empty").hidden = false;
  document.getElementById("group-empty").hidden = false;
  document.getElementById("trip-count").textContent = "0개 운행";
  document.getElementById("group-count").textContent = "0개 조";
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
    if (snapshot && snapshot.schema_version === INTERNAL_SCHEMA) {
      state.internal.snapshot = snapshot;
      state.internal.source = "session";
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
      if (!snapshot || snapshot.error || snapshot.schema_version !== INTERNAL_SCHEMA) {
        setInternalMessage("아이디 또는 비밀번호가 올바르지 않습니다.", true);
        return;
      }
      state.internal.source = "live";
    } else {
      // 내부 API 미설정: 합성 내부 샘플로 화면을 시연한다(실데이터 아님).
      snapshot = await fetchSnapshot("data/sample-internal.json");
      if (!snapshot || snapshot.schema_version !== INTERNAL_SCHEMA) {
        setInternalMessage("내부 API가 설정되지 않았고 샘플도 불러오지 못했습니다.", true);
        return;
      }
      state.internal.source = "sample";
    }

    state.internal.snapshot = snapshot;
    try { sessionStorage.setItem(INTERNAL_SESSION_KEY, JSON.stringify(snapshot)); } catch (storeError) { /* 저장 실패는 화면 표시에 영향 없음 */ }
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
  state.internal.snapshot = null;
  state.internal.source = null;
  clearNode(document.getElementById("internal-table-body"));
  clearNode(document.getElementById("teachers-table-body"));
  clearNode(document.getElementById("staff-table-body"));
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

  renderDirectory("teachers-table-body", snapshot.teachers, snapshot.groups);
  renderDirectory("staff-table-body", snapshot.staff, snapshot.groups);
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
