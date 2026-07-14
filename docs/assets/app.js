"use strict";

const EXPECTED_SCHEMA = "public-snapshot/v1";
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
  assistant: "도우미",
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
  if (snapshot.schema_version !== EXPECTED_SCHEMA) {
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

function renderGroups() {
  if (!state.snapshot) return;
  const list = document.getElementById("group-list");
  const empty = document.getElementById("group-empty");
  const filtered = state.snapshot.groups.filter((group) => matchesGroupSearch(group, state.groups.query));

  clearNode(list);
  filtered.forEach((group) => list.append(createGroupCard(group)));
  empty.hidden = filtered.length > 0;
  document.getElementById("group-count").textContent = `${filtered.length}개 조`;
}

function createGroupCard(group) {
  const card = element("article", "group-card");
  card.style.setProperty("--group-color", safeColor(group.color));
  const header = element("header", "group-card-header");
  appendTextElement(header, "h3", group.display_name || group.group_id);
  appendTextElement(header, "span", `${group.members.length}명`, "group-size");
  card.append(header);

  const members = element("ul", "member-list");
  group.members.forEach((member) => members.append(createPersonRow(member, "role")));
  card.append(members);
  return card;
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
  document.getElementById("group-list").replaceChildren();
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
