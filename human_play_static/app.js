const powerColors = {
  AUSTRIA: "oklch(74% 0.105 31)",
  ENGLAND: "oklch(73% 0.13 321)",
  FRANCE: "oklch(74% 0.11 252)",
  GERMANY: "oklch(72% 0.075 83)",
  ITALY: "oklch(76% 0.105 148)",
  RUSSIA: "oklch(74% 0.08 292)",
  TURKEY: "oklch(78% 0.12 98)",
};

const flagCodes = {
  AUSTRIA: "at",
  ENGLAND: "gb",
  FRANCE: "fr",
  GERMANY: "de",
  ITALY: "it",
  RUSSIA: "ru",
  TURKEY: "tr",
};

const defaultVisualProvinceAliases = {
  MID: "MAO",
  NAT: "NAO",
  NRG: "NWG",
  GOL: "LYO",
  TYN: "TYS",
};

let gameState = null;
let activeChatChannel = "GLOBAL";
let toastTimer = null;
let mapReady = false;
const defaultMapScale = 1.32;
let mapScale = defaultMapScale;
let mapPanX = 0;
let mapPanY = 0;
let showArrows = true;
let showBottomDock = false;
let showSidePanel = true;
let historyIndex = null;
let selectedOrderLocation = null;
let resizeTimer = null;
let panStart = null;
let suppressMapClickUntil = 0;
let clientBusyText = "";
let pendingResolve = false;
const pendingReplies = new Set();
const replyQueue = [];
let replyWorkerRunning = false;
let draftPhase = "";
const draftOrdersByLocation = new Map();
const explicitOrderLocations = new Set();
let pendingActionChoices = null;
let hoveredActionChoices = null;
const orderModeByLocation = new Map();
let orderDrag = null;

const el = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

async function loadMapSvg() {
  const svgText = await fetch("/assets/standard.svg").then((response) => response.text());
  const stripped = svgText
    .replace(/<\?xml[\s\S]*?\?>/i, "")
    .replace(/<!DOCTYPE[\s\S]*?>/i, "");
  el("mapSvgMount").innerHTML = stripped;
  const svg = el("mapSvgMount").querySelector("svg");
  if (svg) {
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    for (const node of svg.querySelectorAll(".currentnoterect, .currentnotetext, .currentphasetext, #CurrentNote, #CurrentNote2, #CurrentPhase")) {
      node.remove();
    }
    for (const rect of svg.querySelectorAll("rect")) {
      const looksLikeOldPhaseNote =
        rect.getAttribute("fill") === "#c5dfea" ||
        (rect.getAttribute("x") === "25" && rect.getAttribute("y") === "25" && rect.getAttribute("width") === "750");
      if (looksLikeOldPhaseNote) rect.remove();
    }
    installMapTextures(svg);
  }
  installMapClickHandlers();
  mapReady = true;
}

function installMapTextures(svg) {
  svg.querySelector("#humanPlayMapTextures")?.remove();
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.id = "humanPlayMapTextures";
  defs.innerHTML = `
    <linearGradient id="seaTileGradient" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="oklch(68% 0.062 218)" />
      <stop offset="45%" stop-color="oklch(73% 0.06 206)" />
      <stop offset="100%" stop-color="oklch(62% 0.065 230)" />
    </linearGradient>
    <pattern id="seaTexture" width="118" height="92" patternUnits="userSpaceOnUse">
      <rect width="118" height="92" fill="url(#seaTileGradient)" />
      <path d="M-18 18 C 0 8 18 8 36 18 S 72 28 96 18 S 132 8 150 18" class="sea-wave bright" />
      <path d="M-12 48 C 8 38 28 38 48 48 S 86 58 124 44" class="sea-wave mid" />
      <path d="M-20 78 C 8 68 28 68 52 78 S 96 88 138 72" class="sea-wave dark" />
      <path d="M22 4 C 36 12 48 12 62 4" class="sea-current" />
      <path d="M78 64 C 90 72 104 72 116 64" class="sea-current" />
      <circle cx="18" cy="64" r="1.1" class="sea-glint" />
      <circle cx="88" cy="30" r="0.9" class="sea-glint" />
    </pattern>
    <radialGradient id="seaHoverGlow" cx="50%" cy="45%" r="70%">
      <stop offset="0%" stop-color="oklch(90% 0.04 198 / 48%)" />
      <stop offset="100%" stop-color="oklch(65% 0.07 220 / 0%)" />
    </radialGradient>
  `;
  svg.insertBefore(defs, svg.firstChild);
}

async function refresh() {
  gameState = await api("/api/state");
  render();
}

function render() {
  if (!gameState) return;
  syncDraftOrdersForPhase();
  if (selectedOrderLocation && !(gameState.orderableLocations || []).includes(selectedOrderLocation)) {
    selectedOrderLocation = null;
    pendingActionChoices = null;
    hoveredActionChoices = null;
  }
  el("phaseTitle").textContent = `${displayPhase(gameState.phase)} ${gameState.isGameDone ? "(complete)" : ""}`;
  el("humanPower").textContent = `Playing as ${powerLabel(gameState.humanPower)}`;
  el("statusText").textContent = currentStatusText();
  renderBodyState();
  renderAiStatus();
  renderLlmSetup();

  renderOrders();
  renderTurnStatus();
  renderLastOutcome();
  renderTurnProgress();
  renderMap();
  updateOrderHint();
  renderMapActionTray();
  renderLastResult();
  renderBottomDock();
  renderOrderArrows();
  renderChatTabs();
  renderRecipients();
  renderMessages();
  renderCenters();
  updateButtons();
}

function syncDraftOrdersForPhase() {
  const phase = gameState?.phase || "";
  if (phase !== draftPhase) {
    draftPhase = phase;
    draftOrdersByLocation.clear();
    explicitOrderLocations.clear();
    pendingActionChoices = null;
    hoveredActionChoices = null;
    orderModeByLocation.clear();
  }
  const reservedLocations = new Set();
  for (const order of gameState.pendingHumanOrders || []) {
    const loc = orderableLocationForOrder(order);
    if (loc) {
      draftOrdersByLocation.set(loc, order);
      reservedLocations.add(loc);
      if (!(gameState.phaseType === "M" && order === defaultOrderForLocation(loc))) {
        explicitOrderLocations.add(loc);
      }
    } else if (String(order).trim().toUpperCase() === "WAIVE") {
      const waiveLocation = nextWaiveLocation(reservedLocations);
      if (waiveLocation) {
        draftOrdersByLocation.set(waiveLocation, "WAIVE");
        explicitOrderLocations.add(waiveLocation);
        reservedLocations.add(waiveLocation);
      }
    }
  }
}

function nextWaiveLocation(reservedLocations) {
  return (gameState?.orderableLocations || []).find((loc) => {
    if (reservedLocations.has(loc)) return false;
    return (gameState.possibleOrders?.[loc] || []).some((order) => order.toUpperCase() === "WAIVE");
  });
}

function renderBodyState() {
  document.body.classList.toggle("is-busy", isBusy());
  document.body.classList.toggle("no-human-orders", !(gameState.orderableLocations || []).length);
  document.body.classList.toggle("phase-adjustment", gameState.phaseType === "A");
  document.body.classList.toggle("phase-retreat", gameState.phaseType === "R");
  document.body.classList.toggle("chat-collapsed", !showSidePanel);
  el("sidePanel")?.classList.toggle("is-collapsed", !showSidePanel);
  const toggle = el("togglePanelButton");
  if (toggle) {
    toggle.textContent = showSidePanel ? "›" : "‹";
    toggle.title = showSidePanel ? "Hide chat" : "Show chat";
    toggle.setAttribute("aria-label", toggle.title);
  }
}

function currentStatusText() {
  if (clientBusyText) return clientBusyText;
  if (gameState.busy) return "AI is thinking...";
  return statusLabel(gameState.status);
}

function isBusy() {
  return Boolean(gameState?.busy || pendingResolve);
}

function renderAiStatus() {
  const pill = el("aiStatus");
  const status = gameState.aiStatus || { label: "AI", real: false, detail: "Unknown AI status." };
  pill.textContent = status.label;
  pill.title = status.detail || "";
  pill.classList.toggle("real", Boolean(status.real));
  pill.classList.toggle("mock", !status.real);
}

function renderLlmSetup() {
  const setup = el("llmSetup");
  if (!setup) return;
  setup.hidden = Boolean(gameState.aiStatus?.real);
}

function displayPhase(phase) {
  if (!phase || phase.length < 6) return phase || "";
  const season = phase[0] === "S" ? "Spring" : phase[0] === "F" ? "Fall" : phase[0] === "W" ? "Winter" : phase[0];
  const year = phase.slice(1, 5);
  const type = phase.endsWith("M") ? "Orders" : phase.endsWith("R") ? "Retreats" : "Builds";
  return `${season} ${year} ${type}`;
}

function currentBoardState() {
  return {
    phase: gameState?.phase || "",
    unitViews: gameState?.unitViews || [],
    centers: gameState?.centers || {},
    centerOwners: gameState?.centerOwners || {},
  };
}

function reviewedBoardPhase() {
  if (!showBottomDock) return null;
  const phase = activeHistoryPhase();
  return phase?.boardAfter || phase?.boardBefore ? phase : null;
}

function activeBoardState() {
  const phase = reviewedBoardPhase();
  return phase?.boardAfter || phase?.boardBefore || currentBoardState();
}

function isReviewingBoard() {
  return Boolean(reviewedBoardPhase());
}

function renderedMapFrame() {
  const viewport = el("mapViewport");
  const viewBox = gameState?.mapViewBox;
  if (!viewport || !viewBox?.width || !viewBox?.height) return null;
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (!width || !height) return null;
  const scale = Math.min(width / viewBox.width, height / viewBox.height);
  const renderedWidth = viewBox.width * scale;
  const renderedHeight = viewBox.height * scale;
  return {
    left: (width - renderedWidth) / 2,
    top: (height - renderedHeight) / 2,
    width: renderedWidth,
    height: renderedHeight,
  };
}

function syncMapOverlayFrame() {
  const frame = renderedMapFrame();
  if (!frame) return;
  for (const id of ["unitOverlay", "orderArrowOverlay", "mapChoiceOverlay"]) {
    const overlay = el(id);
    if (!overlay) continue;
    overlay.style.left = `${frame.left}px`;
    overlay.style.top = `${frame.top}px`;
    overlay.style.width = `${frame.width}px`;
    overlay.style.height = `${frame.height}px`;
  }
}

function renderMap() {
  if (!mapReady) return;
  const board = activeBoardState();
  colorProvinceOwnership(board);
  highlightMapOrderTargets(board);
  applyMapZoom();
  syncMapOverlayFrame();
  renderMapLegend(board);

  const overlay = el("unitOverlay");
  overlay.innerHTML = "";
  const stackOffsets = unitStackOffsets(board.unitViews || []);
  for (const unit of board.unitViews || []) {
    const coord = coordinateForLocation(unit.coordKey) || coordinateForLocation(unit.location);
    if (!coord) continue;
    const stack = stackOffsets.get(unit) || { x: 0, y: 0, count: 1 };
    const token = document.createElement("div");
    token.className = [
      "unit-token",
      unit.type === "Fleet" ? "fleet" : "army",
      unit.dislodged ? "dislodged" : "",
      stack.count > 1 ? "stacked-unit" : "",
      `power-${unit.power}`,
    ].join(" ");
    const flagCode = flagCodes[unit.power];
    if (flagCode) {
      token.style.setProperty("--unit-flag-url", `url("/assets/flags/${flagCode}.svg")`);
    }
    token.dataset.location = unit.location;
    token.dataset.province = provinceBaseCode(unit.location);
    token.style.setProperty("--stack-x", `${stack.x}px`);
    token.style.setProperty("--stack-y", `${stack.y}px`);
    token.style.left = `${(coord.x / gameState.mapViewBox.width) * 100}%`;
    token.style.top = `${(coord.y / gameState.mapViewBox.height) * 100}%`;
    token.title = `${powerLabel(unit.power)} ${unit.type} in ${provinceName(unit.location)}${unit.dislodged ? " (must retreat)" : ""}`;
    token.innerHTML = `
      <span class="unit-symbol">${unit.dislodged ? orderIconSvg("retreat", "unit-retreat-svg") : unit.type === "Fleet" ? "⚓" : "⚔"}</span>
      ${flagImage(unit.power, "unit-flag")}
    `;
    if (!isReviewingBoard() && unit.power === gameState.humanPower) {
      token.classList.add("human-unit");
      const canOrder = (gameState.orderableLocations || []).includes(unit.location);
      if (canOrder) token.classList.add("selectable-unit");
      if (selectedOrderLocation === unit.location) token.classList.add("selected-unit");
      token.addEventListener("pointerdown", (event) => {
        handleUnitTokenPointerDown(event, unit, canOrder);
      });
      token.addEventListener("click", (event) => {
        event.stopPropagation();
        handleUnitTokenClick(unit, canOrder);
      });
    }
    overlay.appendChild(token);
  }
  renderMapChoices();
}

function handleUnitTokenClick(unit, canOrder) {
  if (Date.now() < suppressMapClickUntil) return;
  if (selectedOrderLocation && selectedOrderLocation !== unit.location) {
    const code = provinceBaseCode(unit.location);
    const supportMatches = supportOriginActionsForCode(selectedOrderLocation, code);
    if (supportMatches.length) {
      orderModeByLocation.set(selectedOrderLocation, "support");
      chooseActionOrAsk(
        selectedOrderLocation,
        code,
        sortActionsForMode(supportMatches, "support"),
        { activeMode: "support", forceMenu: true, note: supportContextNote(selectedOrderLocation, code, supportMatches) },
      );
      return;
    }
    const activeMode = ensureOrderMode(selectedOrderLocation);
    const activeMatches = activeModeActionsForCode(selectedOrderLocation, code);
    if (activeMatches.length) {
      chooseActionOrAsk(selectedOrderLocation, code, activeMatches, { activeMode });
      return;
    }
    const tacticalMatches = actionsForCode(selectedOrderLocation, code).filter((action) =>
      ["support", "convoy", "convoy-move"].includes(action.kind),
    );
    if (tacticalMatches.length) {
      const tacticalMode = actionMode(tacticalMatches[0]);
      orderModeByLocation.set(selectedOrderLocation, tacticalMode);
      chooseActionOrAsk(
        selectedOrderLocation,
        code,
        sortActionsForMode(tacticalMatches, tacticalMode),
        { activeMode: tacticalMode, forceMenu: true },
      );
      return;
    }
  }
  if (canOrder) {
    selectOrderLocation(unit.location);
  } else {
    showToast(noOrderReason());
  }
}

function handleUnitTokenPointerDown(event, unit, canOrder) {
  if (!canOrder || isReviewingBoard() || event.button !== 0) return;
  event.stopPropagation();
  const start = {
    id: event.pointerId,
    location: unit.location,
    x: event.clientX,
    y: event.clientY,
    active: false,
  };
  orderDrag = start;

  const clearDrag = () => {
    document.removeEventListener("pointermove", handleMove);
    document.removeEventListener("pointerup", handleUp);
    document.removeEventListener("pointercancel", handleCancel);
    document.body.classList.remove("order-dragging");
    orderDrag = null;
  };

  const handleMove = (moveEvent) => {
    if (!orderDrag || moveEvent.pointerId !== start.id) return;
    const dx = moveEvent.clientX - start.x;
    const dy = moveEvent.clientY - start.y;
    if (!orderDrag.active && Math.hypot(dx, dy) > 10) {
      orderDrag.active = true;
      document.body.classList.add("order-dragging");
      if (selectedOrderLocation !== start.location) {
        selectOrderLocation(start.location, { force: true });
      }
    }
    if (orderDrag.active) moveEvent.preventDefault();
  };

  const handleUp = (upEvent) => {
    if (!orderDrag || upEvent.pointerId !== start.id) return;
    const wasDragging = orderDrag.active;
    clearDrag();
    if (!wasDragging) return;
    suppressMapClickUntil = Date.now() + 300;
    upEvent.preventDefault();
    upEvent.stopPropagation();
    const code = provinceCodeFromPoint(upEvent.clientX, upEvent.clientY);
    if (code) {
      chooseDroppedOrder(start.location, code);
    } else {
      cancelOrderSelection("Drop on a province to choose an order.");
    }
  };

  const handleCancel = (cancelEvent) => {
    if (!orderDrag || cancelEvent.pointerId !== start.id) return;
    clearDrag();
  };

  document.addEventListener("pointermove", handleMove);
  document.addEventListener("pointerup", handleUp);
  document.addEventListener("pointercancel", handleCancel);
}

function provinceCodeFromPoint(x, y) {
  for (const element of document.elementsFromPoint(x, y)) {
    if (element.classList?.contains("unit-token") && element.dataset.province) {
      return provinceBaseCode(element.dataset.province);
    }
    const path = element.matches?.("#MapLayer path[id^='_'], #MouseLayer path[id]")
      ? element
      : element.closest?.("#MapLayer path[id^='_'], #MouseLayer path[id]");
    const code = mapProvinceCode(path?.id);
    if (code) return code;
  }
  return "";
}

function chooseDroppedOrder(location, code) {
  if (!location || !code) return;
  selectedOrderLocation = location;
  pendingActionChoices = null;
  hoveredActionChoices = null;
  const activeMode = ensureOrderMode(location);
  const droppedUnit = unitAtBase(code);
  const supportMatches = supportOriginActionsForCode(location, code);
  if (activeMode === "support" && !supportMatches.length) {
    const note = supportRuleHint(location, code);
    pendingActionChoices = actionChoicePayload(location, code, [], { note });
    renderMapActionTray();
    renderMap();
    showToast(note);
    return;
  }
  if (supportMatches.length && (activeMode === "support" || droppedUnit?.power === gameState.humanPower)) {
    orderModeByLocation.set(location, "support");
    chooseActionOrAsk(location, code, sortActionsForMode(supportMatches, "support"), {
      activeMode: "support",
      forceMenu: true,
      note: supportContextNote(location, code, supportMatches),
    });
    return;
  }

  const activeMatches = activeModeActionsForCode(location, code);
  if (activeMatches.length) {
    chooseActionOrAsk(location, code, activeMatches, { activeMode });
    return;
  }

  const tacticalMatches = actionsForCode(location, code).filter((action) =>
    ["support", "convoy", "convoy-move"].includes(action.kind),
  );
  if (tacticalMatches.length) {
    const tacticalMode = actionMode(tacticalMatches[0]);
    orderModeByLocation.set(location, tacticalMode);
    chooseActionOrAsk(location, code, sortActionsForMode(tacticalMatches, tacticalMode), {
      activeMode: tacticalMode,
      forceMenu: true,
    });
    return;
  }

  handleProvinceClick(provinceBaseCode(code));
}

function unitStackOffsets(units) {
  const groups = new Map();
  for (const unit of units) {
    const coord = coordinateForLocation(unit.coordKey) || coordinateForLocation(unit.location);
    if (!coord) continue;
    const key = `${provinceBaseCode(unit.location)}:${Math.round(coord.x)}:${Math.round(coord.y)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(unit);
  }

  const offsets = new Map();
  const patterns = {
    1: [[0, 0]],
    2: [[-8, -7], [8, 7]],
    3: [[-9, -7], [9, -7], [0, 9]],
  };
  for (const group of groups.values()) {
    group.sort((left, right) => Number(left.dislodged) - Number(right.dislodged));
    const activeUnits = group.filter((unit) => !unit.dislodged);
    const dislodgedUnits = group.filter((unit) => unit.dislodged);
    if (activeUnits.length === 1 && dislodgedUnits.length) {
      offsets.set(activeUnits[0], { x: 0, y: 0, count: group.length });
      const retreatPattern = [[11, 9], [-11, 9], [11, -9], [-11, -9]];
      dislodgedUnits.forEach((unit, index) => {
        const [x, y] = retreatPattern[index % retreatPattern.length];
        offsets.set(unit, { x, y, count: group.length });
      });
      continue;
    }
    const pattern = patterns[group.length] || [[-9, -7], [9, -7], [-9, 8], [9, 8]];
    group.forEach((unit, index) => {
      const [x, y] = pattern[index % pattern.length];
      offsets.set(unit, { x, y, count: group.length });
    });
  }
  return offsets;
}

function renderMapLegend(board) {
  const legend = el("mapLegend");
  if (!legend) return;
  const reviewed = reviewedBoardPhase();
  const reviewText = reviewed
    ? `<span><i class="legend-swatch review"></i>Reviewing after ${escapeHtml(displayPhase(reviewed.name))}</span>`
    : "";
  legend.innerHTML = `
    ${reviewText}
    <span><i class="legend-swatch owner"></i>Center owner</span>
    <span><i class="legend-swatch occupier"></i>Unit influence</span>
    <span><i class="legend-swatch history"></i>Recent moves</span>
  `;
}

function installMapClickHandlers() {
  const svg = el("mapSvgMount").querySelector("svg");
  if (!svg) return;
  for (const path of svg.querySelectorAll("#MapLayer path[id^='_'], #MouseLayer path[id]")) {
    path.addEventListener("click", () => {
      if (Date.now() < suppressMapClickUntil) return;
      handleMapPathClick(path);
    });
    path.addEventListener("mouseenter", () => handleMapPathHover(path));
    path.addEventListener("mousemove", () => handleMapPathHover(path));
    path.addEventListener("mouseleave", () => clearMapHover(mapProvinceCode(path?.id)));
  }
}

function handleMapPathClick(path) {
  const code = mapProvinceCode(path?.id);
  if (code) handleProvinceClick(code);
}

function handleMapPathHover(path) {
  if (isReviewingBoard() || !selectedOrderLocation || pendingActionChoices || panStart) return;
  const code = mapProvinceCode(path?.id);
  if (!code) {
    clearMapHover();
    return;
  }
  const context = contextualActionsForCode(selectedOrderLocation, code);
  const actions = context.actions;
  if (!actions.length && !context.note) {
    clearMapHover(code);
    return;
  }
  const next = actionChoicePayload(selectedOrderLocation, code, actions, { note: context.note });
  if (sameActionChoicePayload(hoveredActionChoices, next)) return;
  hoveredActionChoices = next;
  renderMapChoices();
}

function clearMapHover(code = null) {
  if (!hoveredActionChoices) return;
  if (code && hoveredActionChoices.code !== code) return;
  hoveredActionChoices = null;
  renderMapChoices();
}

function colorProvinceOwnership(board = activeBoardState()) {
  const svg = el("mapSvgMount").querySelector("svg");
  if (!svg) return;
  const occupiers = provinceOccupiers(board);

  for (const path of svg.querySelectorAll("#MapLayer path[id^='_']")) {
    const base = mapProvinceCode(path.id);
    const province = gameState.provinces?.[base];
    const owner = board.centerOwners?.[base];
    const occupier = occupiers[base];
    const isSea = province?.type === "sea" || path.classList.contains("water");
    const isLand = !isSea && province?.type !== "impassable";

    path.classList.add("province-region");
    path.classList.toggle("sea-province", isSea);
    path.classList.toggle("land-province", isLand);
    path.classList.toggle("occupied-province", Boolean(occupier));

    if (owner) {
      path.style.fill = powerColors[owner];
      path.style.fillOpacity = "0.82";
    } else if (province?.supply_center) {
      path.style.fill = "oklch(89% 0.045 92)";
      path.style.fillOpacity = "0.9";
    } else if (occupier && !isSea) {
      path.style.fill = powerColors[occupier];
      path.style.fillOpacity = "0.34";
    } else if (isSea) {
      path.style.fill = "url(#seaTexture)";
      path.style.fillOpacity = "0.96";
    } else {
      path.style.fill = "oklch(83% 0.045 95)";
      path.style.fillOpacity = "0.92";
    }

    path.style.stroke = occupier
      ? powerColors[occupier]
      : isSea
        ? "oklch(34% 0.055 215 / 62%)"
        : "oklch(30% 0.04 88 / 68%)";
    path.style.strokeWidth = occupier ? (owner && owner !== occupier ? "5.2" : "3.6") : province?.supply_center ? "2.6" : "1.2";
    path.style.strokeOpacity = occupier ? "0.96" : "0.68";

    let title = path.querySelector("title");
    if (!title) {
      title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      path.appendChild(title);
    }
    title.textContent = [
      provinceName(base),
      owner ? `center owned by ${powerLabel(owner)}` : province?.supply_center ? "neutral supply center" : "",
      occupier ? `occupied by ${powerLabel(occupier)}` : "",
    ].filter(Boolean).join(", ");
  }
}

function provinceOccupiers(board = activeBoardState()) {
  const occupiers = {};
  for (const unit of board?.unitViews || []) {
    const base = provinceBaseCode(unit.location);
    if (!unit.dislodged || !occupiers[base]) {
      occupiers[base] = unit.power;
    }
  }
  return occupiers;
}

function highlightMapOrderTargets(board = activeBoardState()) {
  const svg = el("mapSvgMount").querySelector("svg");
  if (!svg) return;
  for (const path of svg.querySelectorAll("#MapLayer path[id^='_']")) {
    path.classList.remove(
      "selected-province",
      "move-target-province",
      "orderable-province",
      "planned-origin-province",
      "planned-target-province",
      "support-target-province",
      "convoy-target-province",
    );
  }
  if (isReviewingBoard()) return;
  const orderableBases = new Set((gameState.orderableLocations || []).map(provinceBaseCode));
  for (const path of svg.querySelectorAll("#MapLayer path[id^='_']")) {
    const code = mapProvinceCode(path.id);
    if (orderableBases.has(code)) path.classList.add("orderable-province");
  }
  const planned = plannedOrderCodes();
  for (const path of svg.querySelectorAll("#MapLayer path[id^='_']")) {
    const code = mapProvinceCode(path.id);
    if (planned.origins.has(code)) path.classList.add("planned-origin-province");
    if (planned.targets.has(code)) path.classList.add("planned-target-province");
  }
  if (!selectedOrderLocation) return;
  const selectedBase = provinceBaseCode(selectedOrderLocation);
  const activeMode = ensureOrderMode(selectedOrderLocation);
  const targetActions = orderActionsForLocation(selectedOrderLocation)
    .filter((action) => actionMode(action) === activeMode);
  const destinations = new Set(
    targetActions
      .flatMap((action) => activeMode === "support" ? [supportOriginCode(action)] : actionMapCodes(action))
      .filter(Boolean),
  );
  for (const path of svg.querySelectorAll("#MapLayer path[id^='_']")) {
    const code = mapProvinceCode(path.id);
    if (code === selectedBase) path.classList.add("selected-province");
    if (destinations.has(code)) {
      path.classList.add("move-target-province");
      if (activeMode === "support") path.classList.add("support-target-province");
      if (activeMode === "convoy") path.classList.add("convoy-target-province");
    }
  }
}

function plannedOrderCodes() {
  const origins = new Set();
  const targets = new Set();
  for (const order of selectedOrders()) {
    const parts = String(order).trim().split(/\s+/);
    if (parts[1]) origins.add(provinceBaseCode(parts[1]));
    const move = moveEndpoints(order);
    if (move?.to) targets.add(provinceBaseCode(move.to));
    const relation = orderRelationEndpoints(order);
    if (relation?.to) targets.add(provinceBaseCode(relation.to));
    if (relation?.supportFrom) targets.add(provinceBaseCode(relation.supportFrom));
    const retreatIndex = parts.indexOf("R");
    if (retreatIndex > -1 && parts[retreatIndex + 1]) {
      targets.add(provinceBaseCode(parts[retreatIndex + 1]));
    }
  }
  return { origins, targets };
}

function selectOrderLocation(location, options = {}) {
  selectedOrderLocation = options.force ? location : selectedOrderLocation === location ? null : location;
  pendingActionChoices = null;
  hoveredActionChoices = null;
  if (selectedOrderLocation) ensureOrderMode(selectedOrderLocation);
  updateOrderHint();
  renderMapActionTray();
  renderMap();
  renderOrderArrows();
  renderTurnProgress();
}

function cancelOrderSelection(message = "Selection cancelled.") {
  if (!selectedOrderLocation && !pendingActionChoices && !hoveredActionChoices) return;
  selectedOrderLocation = null;
  pendingActionChoices = null;
  hoveredActionChoices = null;
  updateOrderHint();
  renderMapActionTray();
  renderMap();
  renderOrderArrows();
  renderTurnProgress();
  if (message) showToast(message);
}

function handleProvinceClick(code) {
  if (!gameState) return;
  const orderableLocation = (gameState.orderableLocations || []).find(
    (loc) => provinceBaseCode(loc) === code,
  );
  if (!selectedOrderLocation) {
    if (orderableLocation) {
      selectOrderLocation(orderableLocation);
      return;
    }
    const ownUnit = (gameState.unitViews || []).find(
      (unit) =>
        unit.power === gameState.humanPower &&
        (gameState.orderableLocations || []).includes(unit.location) &&
        provinceBaseCode(unit.location) === code,
    );
    if (ownUnit) selectOrderLocation(ownUnit.location);
    return;
  }

  const activeMode = ensureOrderMode(selectedOrderLocation);
  const context = contextualActionsForCode(selectedOrderLocation, code);
  if (activeMode === "support" && context.note && !context.actions.length) {
    pendingActionChoices = actionChoicePayload(selectedOrderLocation, code, [], { note: context.note });
    hoveredActionChoices = null;
    renderMapActionTray();
    renderMap();
    showToast(context.note);
    return;
  }
  const clickedUnit = unitAtBase(code);
  const supportOriginMatches = supportOriginActionsForCode(selectedOrderLocation, code);
  if (clickedUnit && supportOriginMatches.length && (activeMode === "support" || clickedUnit.power === gameState.humanPower)) {
    orderModeByLocation.set(selectedOrderLocation, "support");
    chooseActionOrAsk(
      selectedOrderLocation,
      code,
      sortActionsForMode(supportOriginMatches, "support"),
      { activeMode: "support", forceMenu: true, note: supportContextNote(selectedOrderLocation, code, supportOriginMatches) },
    );
    return;
  }
  const activeMatches = activeModeActionsForCode(selectedOrderLocation, code);
  const allMatches = actionsForCode(selectedOrderLocation, code);
  const tacticalMatches = allMatches.filter((action) => ["support", "convoy", "convoy-move"].includes(action.kind));
  const localMatches = allMatches.filter((action) => actionMode(action) === "local");
  if (
    orderableLocation &&
    orderableLocation !== selectedOrderLocation &&
    !activeMatches.length &&
    !tacticalMatches.length
  ) {
    selectOrderLocation(orderableLocation);
    return;
  }

  let modeForChoice = activeMode;
  let matchingActions = [];
  if (activeMatches.length) {
    matchingActions = sortActionsForMode(allMatches, activeMode);
  } else if (tacticalMatches.length) {
    modeForChoice = actionMode(tacticalMatches[0]);
    orderModeByLocation.set(selectedOrderLocation, modeForChoice);
    matchingActions = sortActionsForMode(tacticalMatches, modeForChoice);
  } else if (activeMode === "local") {
    matchingActions = localMatches;
  }
  if (!matchingActions.length) {
    if (allMatches.length) {
      const mode = actionMode(allMatches[0]);
      showToast(`No ${kindLabel(activeMode).toLowerCase()} order for ${provinceName(code)}. Switch to ${kindLabel(mode)} mode first.`);
      return;
    }
    if (activeMode === "support") {
      showToast(supportRuleHint(selectedOrderLocation, code));
      return;
    }
    if (activeMode === "convoy") {
      showToast(`No convoy order for ${provinceName(code)}. Convoys need an army move by convoy and fleet convoy orders on the route.`);
      return;
    }
    cancelOrderSelection(`${provinceName(code)} is not legal for ${provinceName(selectedOrderLocation)}. Selection cancelled.`);
    return;
  }
  chooseActionOrAsk(selectedOrderLocation, code, matchingActions, { activeMode: modeForChoice });
}

function chooseActionOrAsk(location, code, actions, options = {}) {
  const needsMapConfirmation =
    options.forceMenu ||
    options.activeMode === "support" ||
    options.activeMode === "convoy" ||
    actions.some((action) => ["support", "convoy", "convoy-move"].includes(action.kind));
  if (actions.length === 1 && !needsMapConfirmation) {
    setDirectOrder(location, actions[0].order, actions[0]);
    return;
  }
  pendingActionChoices = actionChoicePayload(location, code, actions, { note: options.note || "" });
  hoveredActionChoices = null;
  selectedOrderLocation = location;
  renderMapActionTray();
  renderMap();
  showToast(`${provinceName(code)}: choose the exact order.`);
}

function supportRuleHint(location, code) {
  const unit = unitAtBase(location);
  const province = gameState.provinces?.[provinceBaseCode(code)];
  if (unit?.type === "Army" && province?.type === "sea") {
    return `No support order for ${provinceName(code)}. Armies can support fleets into coastal land provinces, but cannot support attacks into sea provinces.`;
  }
  return `No support order for ${provinceName(code)}. A unit can support only an action into a province it could legally enter.`;
}

function setDirectOrder(location, order, action = null) {
  const companionResult = stageCompanionOrders(action || orderAction(location, order));
  setOrderDraft(location, order);
  selectedOrderLocation = null;
  pendingActionChoices = null;
  hoveredActionChoices = null;
  updateOrderHint();
  renderMapActionTray();
  renderTurnProgress();
  renderOrders();
  renderTurnStatus();
  renderMap();
  renderOrderArrows();
  updateButtons();
  showToast(orderToast(order, companionResult));
}

function clearOrder(location) {
  draftOrdersByLocation.delete(location);
  explicitOrderLocations.delete(location);
  pendingActionChoices = null;
  hoveredActionChoices = null;
  renderOrders();
  renderTurnStatus();
  renderTurnProgress();
  renderMapActionTray();
  renderMap();
  renderOrderArrows();
  updateButtons();
  showToast(`${provinceName(location)} reset.`);
}

function updateOrderHint() {
  const hint = el("orderModeHint");
  if (!hint) return;
  if (!(gameState.orderableLocations || []).length) {
    hint.textContent = noOrderReason();
    return;
  }
  if (!selectedOrderLocation) {
    hint.textContent =
      gameState.phaseType === "A"
        ? adjustmentHelpText()
        : gameState.phaseType === "R"
          ? "Pick a highlighted unit, then choose where it retreats."
          : "Pick a highlighted unit. Legal destinations turn green.";
    return;
  }
  const actions = orderActionsForLocation(selectedOrderLocation);
  const mapActions = actions.filter((action) => action.coord);
  const tacticalActions = actions.filter((action) => ["support", "convoy"].includes(action.kind));
  hint.textContent = mapActions.length || tacticalActions.length
    ? `${provinceName(selectedOrderLocation)} selected. Pick a mode, hover targets, then click a province to choose.`
    : `${provinceName(selectedOrderLocation)} selected. Choose a legal order.`;
}

function renderTurnStatus() {
  const card = el("turnStatusCard");
  if (!card) return;
  const orderable = gameState.orderableLocations || [];
  const required = requiredOrderCount();
  const selectedCount = selectedOrderCount();
  const phase = displayPhase(gameState.phase);

  if (pendingResolve || gameState.busy) {
    card.className = "turn-status-card resolving";
    card.innerHTML = `<strong>AI players are moving</strong><span>Keep this open. The board updates when every country finishes.</span>`;
    return;
  }
  if (gameState.isGameDone) {
    card.className = "turn-status-card done";
    card.innerHTML = `<strong>Game complete</strong><span>${gameState.winner ? `${powerLabel(gameState.winner)} controls 18 centers.` : "The game has ended."}</span>`;
    return;
  }
  const human = powerLabel(gameState.humanPower);
  if (!orderable.length || !required) {
    card.className = "turn-status-card waiting no-action";
    card.innerHTML = `
      <strong>Nothing to choose</strong>
      <span>${escapeHtml(noOrderReason())}</span>
      <span>The orders below are only the last turn report. Press Continue to advance.</span>
    `;
    return;
  }
  const ready = allOrdersChosen();
  const tooMany = gameState.phaseType === "A" && selectedOrderCount() > required;
  card.className = ready ? "turn-status-card ready" : "turn-status-card active needs-action";
  const noun = gameState.phaseType === "A" ? "adjustments" : gameState.phaseType === "R" ? "retreats" : "units";
  if (gameState.phaseType === "M") {
    card.innerHTML = `
      <strong>Your movement turn</strong>
      <span>${selectedCount ? `${selectedCount} ${human} unit${selectedCount === 1 ? "" : "s"} changed.` : "No changes selected."} Other units hold automatically. Finish Turn sends orders and waits for the AI powers.</span>
    `;
    return;
  }
  const defaultText =
    gameState.phaseType === "A"
      ? adjustmentHelpText()
      : gameState.phaseType === "R"
        ? "Choose a retreat or disband for each highlighted unit."
        : "Holds are the default; change them on the map.";
  const contextText = gameState.phaseType === "A" ? `<span>${escapeHtml(adjustmentContextText())}</span>` : "";
  card.innerHTML = `
    <strong>${ready ? "Ready to finish" : tooMany ? "Too many choices" : gameState.phaseType === "R" ? "Retreat needed" : "Build choices needed"}</strong>
    <span>${selectedCount} of ${required} ${escapeHtml(human)} ${noun} ${gameState.phaseType === "M" ? "changed" : "chosen"}. ${defaultText}</span>
    ${contextText}
  `;
}

function renderLastOutcome() {
  const card = el("lastOutcomeCard");
  if (!card) return;
  const phase = gameState.lastPhase;
  const orders = phase?.submitted?.[gameState.humanPower] || phase?.orders?.[gameState.humanPower] || [];
  if (!phase || !orders.length) {
    card.innerHTML = "";
    card.className = "last-outcome-card is-empty";
    return;
  }

  const rows = orders.map((order) => ({
    order,
    outcome: outcomeForOrder(order, phase),
  }));
  const visibleRows = rows.filter((row) => !row.outcome.quiet);
  const blocked = visibleRows.filter((row) => row.outcome.severity === "blocked").length;
  const warned = visibleRows.filter((row) => row.outcome.severity === "warning").length;
  const positive = visibleRows.length - blocked - warned;
  card.className = `last-outcome-card ${blocked ? "has-blocked" : warned ? "has-warning" : "all-clear"}`;
  if (!visibleRows.length) {
    card.innerHTML = `
      <div class="outcome-head">
        <strong>${escapeHtml(displayPhase(phase.name))}</strong>
        <span>No notable order results</span>
      </div>
    `;
    return;
  }
  card.innerHTML = `
    <div class="outcome-head">
      <strong>${escapeHtml(displayPhase(phase.name))}</strong>
      <span>${positive} resolved / ${blocked + warned} blocked</span>
    </div>
    <div class="outcome-list">
      ${visibleRows.map((row) => `
        <div class="outcome-row ${row.outcome.severity}">
          <span>${escapeHtml(row.outcome.label)}</span>
          <span>${escapeHtml(describeOrder(row.order))}</span>
          <small>${escapeHtml(row.outcome.reason)}</small>
        </div>
      `).join("")}
    </div>
  `;
}

function outcomeForOrder(order, phase) {
  const results = phase?.results || {};
  const key = orderResultKey(order);
  const rawResults = Array.isArray(results[key]) ? results[key] : [];
  const tags = rawResults.flat().map((tag) => String(tag || "").trim()).filter(Boolean);
  if (!tags.length) {
    const defended = defendedHoldOutcome(order, phase);
    if (defended) return defended;
    if (isHoldOrder(order)) {
      return { label: "Hold", reason: "No attack to report.", severity: "quiet", quiet: true };
    }
    if (moveEndpoints(order)) {
      return { label: "Moved", reason: "Arrived at the destination.", severity: "ok" };
    }
    const relation = orderRelationEndpoints(order);
    if (relation?.kind === "support") {
      return { label: "Supported", reason: "Support was not cut.", severity: "ok" };
    }
    if (relation?.kind === "convoy") {
      return { label: "Convoyed", reason: "Convoy order was available for the route.", severity: "ok" };
    }
    if (isRetreatOrder(order)) {
      return { label: "Retreated", reason: "Retreat completed.", severity: "ok" };
    }
    if (String(order || "").trim().endsWith(" B")) {
      return { label: "Built", reason: "Adjustment completed.", severity: "ok" };
    }
    if (String(order || "").trim().endsWith(" D")) {
      return { label: "Disbanded", reason: "Adjustment completed.", severity: "ok" };
    }
    return { label: "Resolved", reason: "Order completed.", severity: "ok" };
  }
  if (tags.includes("bounce")) {
    return { label: "Blocked", reason: bounceReason(order), severity: "blocked" };
  }
  if (tags.includes("no convoy")) {
    return { label: "No convoy", reason: "Convoy is manual: the army orders the move, and every fleet on the sea route must order Convoy. Support is separate.", severity: "blocked" };
  }
  if (tags.includes("void")) {
    return { label: "Void", reason: "The order had no legal effect after adjudication.", severity: "blocked" };
  }
  if (tags.includes("cut")) {
    return { label: "Cut", reason: "Support was cut by an attack.", severity: "warning" };
  }
  if (tags.includes("dislodged")) {
    return { label: "Dislodged", reason: "The unit was forced to retreat.", severity: "blocked" };
  }
  if (tags.includes("disrupted")) {
    return { label: "Disrupted", reason: "The convoy was disrupted by combat.", severity: "warning" };
  }
  if (tags.includes("disband")) {
    return { label: "Disbanded", reason: "The unit was removed during adjudication.", severity: "blocked" };
  }
  if (tags.includes("maybe")) {
    return { label: "Uncertain", reason: "The engine marked this result as conditional.", severity: "warning" };
  }
  return { label: tags.join(", "), reason: "Resolved with an engine note.", severity: "warning" };
}

function isHoldOrder(order) {
  return String(order || "").trim().endsWith(" H");
}

function isRetreatOrder(order) {
  return String(order || "").trim().split(/\s+/).includes("R");
}

function defendedHoldOutcome(order, phase) {
  if (!isHoldOrder(order) || !phase?.submitted || !phase?.results) return null;
  const parts = String(order || "").trim().split(/\s+/);
  const heldLocation = provinceBaseCode(parts[1]);
  if (!heldLocation) return null;
  const attackers = [];
  for (const [power, powerOrders] of Object.entries(phase.submitted || {})) {
    if (power === gameState.humanPower) continue;
    for (const candidate of powerOrders || []) {
      const move = moveEndpoints(candidate);
      if (provinceBaseCode(move?.to) !== heldLocation) continue;
      const resultKey = orderResultKey(candidate);
      const tags = Array.isArray(phase.results[resultKey])
        ? phase.results[resultKey].flat().map((tag) => String(tag || "").trim())
        : [];
      if (tags.includes("bounce")) attackers.push(provinceName(move.from));
    }
  }
  if (!attackers.length) return null;
  return {
    label: "Defended",
    reason: `Held against ${attackers.join(", ")}.`,
    severity: "ok",
  };
}

function orderResultKey(order) {
  const parts = String(order || "").trim().split(/\s+/);
  return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : String(order || "");
}

function bounceReason(order) {
  const move = moveEndpoints(order);
  if (!move) return "The order was blocked by another unit or equal strength.";
  const last = gameState.lastPhase;
  const humanOrders = last?.submitted?.[gameState.humanPower] || [];
  const sameTarget = humanOrders.filter((candidate) => {
    const candidateMove = moveEndpoints(candidate);
    return provinceBaseCode(candidateMove?.to) === provinceBaseCode(move.to);
  });
  if (sameTarget.length > 1) {
    return `Two ${powerLabel(gameState.humanPower)} units tried to enter ${provinceName(move.to)}. Use one move and one support instead.`;
  }
  return `${provinceName(move.to)} was defended or contested with equal strength. Add support to break through.`;
}

function renderTurnProgress() {
  const progress = el("turnProgress");
  const list = el("plannedOrdersList");
  if (!progress || !list) return;
  const rows = orderPlanRows();
  const needed = requiredOrderCount();
  const selectedCount = selectedOrderCount();
  if (!(gameState.orderableLocations || []).length || !needed) {
    progress.innerHTML = `<span>No choices needed now.</span>`;
    list.innerHTML = "";
    return;
  }
  if (gameState.phaseType === "M") {
    progress.innerHTML = `<span>${selectedCount} planned change${selectedCount === 1 ? "" : "s"}. Other units hold.</span>`;
  } else {
    const progressLabel = gameState.phaseType === "R" ? "retreats" : "chosen";
    progress.innerHTML = needed
      ? `<span>${selectedCount}/${needed} ${progressLabel}</span><i style="--progress:${Math.min(100, (selectedCount / needed) * 100)}%"></i>`
      : "";
  }
  list.innerHTML = "";
  if (!rows.length) return;
  for (const { loc, order, explicit, companions = [] } of rows) {
    const item = document.createElement("div");
    item.className = `planned-order ${explicit ? "" : "default-order"}`;
    const action = orderAction(loc, order);
    const move = moveEndpoints(order);
    const kind = action?.kind || (order === "WAIVE" ? "waive" : move ? "move" : order.includes(" R ") ? "retreat" : order.endsWith(" H") ? "hold" : order.endsWith(" B") ? "build" : order.endsWith(" D") ? "disband" : "order");
    const planKind = explicit ? kind : "default";
    const companionText = companions.length
      ? `<small class="planned-companion">Fleet route: ${escapeHtml(companions.map((item) => provinceName(item.loc)).join(", "))}</small>`
      : "";
    item.innerHTML = `
      <span class="planned-icon ${planKind}">
        ${orderIconSvg(planKind, "planned-svg")}
        <small>${escapeHtml(explicit ? kindLabel(kind) : "Default")}</small>
      </span>
      <span class="planned-main">${escapeHtml(describeOrder(order))}${companionText}</span>
    `;
    list.appendChild(item);
  }
}

function orderPlanRows() {
  const locations = gameState.orderableLocations || [];
  if (gameState.phaseType !== "M") {
    return locations
      .filter((loc) => explicitOrderLocations.has(loc) && draftOrdersByLocation.get(loc))
      .map((loc) => ({ loc, order: draftOrdersByLocation.get(loc), explicit: true }));
  }
  const convoyMoves = new Map();
  const convoyOrders = new Map();
  for (const loc of locations) {
    if (!explicitOrderLocations.has(loc)) continue;
    const order = draftOrdersByLocation.get(loc);
    if (!order) continue;
    const move = moveEndpoints(order);
    if (move && String(order).trim().endsWith(" VIA")) {
      convoyMoves.set(convoyMoveKey(move.from, move.to), { loc, order });
      continue;
    }
    const relation = orderRelationEndpoints(order);
    if (relation?.kind === "convoy") {
      const key = convoyMoveKey(relation.carryFrom, relation.to);
      if (!convoyOrders.has(key)) convoyOrders.set(key, []);
      convoyOrders.get(key).push({ loc, order });
    }
  }

  return locations
    .filter((loc) => explicitOrderLocations.has(loc) && draftOrdersByLocation.get(loc))
    .flatMap((loc) => {
      const order = draftOrdersByLocation.get(loc);
      const relation = orderRelationEndpoints(order);
      if (relation?.kind === "convoy" && convoyMoves.has(convoyMoveKey(relation.carryFrom, relation.to))) {
        return [];
      }
      const move = moveEndpoints(order);
      const companions = move && String(order).trim().endsWith(" VIA")
        ? convoyOrders.get(convoyMoveKey(move.from, move.to)) || []
        : [];
      return [{ loc, order, explicit: true, companions }];
    });
}

function kindLabel(kind) {
  return {
    move: "Move",
    "convoy-move": "Convoy",
    retreat: "Retreat",
    hold: "Hold",
    build: "Build",
    disband: "Disband",
    support: "Support",
    convoy: "Convoy",
    local: "Local",
    waive: "Waive",
    order: "Order",
  }[kind] || "Order";
}

function orderIconId(kind) {
  return {
    move: "order-move",
    "convoy-move": "order-convoy",
    retreat: "order-retreat",
    hold: "order-hold",
    build: "order-build",
    disband: "order-disband",
    support: "order-support",
    convoy: "order-convoy",
    waive: "order-waive",
    clear: "order-clear",
    cancel: "order-cancel",
    default: "order-default",
    order: "order-default",
    local: "order-hold",
  }[kind] || "order-default";
}

function orderIconSvg(kind, className = "order-svg") {
  return `<svg class="${className}" viewBox="0 0 24 24" focusable="false" aria-hidden="true"><use href="/assets/order-icons.svg#${orderIconId(kind)}"></use></svg>`;
}

function renderMapActionTray() {
  const tray = el("mapActionTray");
  if (!tray) return;
  tray.innerHTML = "";
  if (!gameState) return;

  if (!selectedOrderLocation) {
    if (!(gameState.orderableLocations || []).length) return;
    if (gameState.phaseType === "A") {
      tray.innerHTML = `
        <span class="tray-note">${escapeHtml(adjustmentHelpText())}</span>
        <span class="tray-note">${escapeHtml(adjustmentContextText())}</span>
      `;
      const row = document.createElement("div");
      row.className = "tray-actions";
      for (const loc of gameState.orderableLocations) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tray-action-button";
        button.textContent = provinceName(loc);
        button.addEventListener("click", () => selectOrderLocation(loc));
        row.appendChild(button);
      }
      tray.appendChild(row);
      return;
    }
    tray.innerHTML = `<span class="tray-note">Select a unit on the map.</span>`;
    return;
  }

  const actions = orderActionsForLocation(selectedOrderLocation);
  const activeMode = ensureOrderMode(selectedOrderLocation);
  const choicePrompt = pendingActionChoices?.location === selectedOrderLocation ? pendingActionChoices : null;
  if (choicePrompt) {
    tray.innerHTML = `
      <span class="tray-title">Choose exact order on the map</span>
      <span class="tray-note">${escapeHtml(provinceName(choicePrompt.code))} has ${choicePrompt.actions.length} legal options.</span>
    `;
    return;
  }

  const modes = actionModes(actions);
  const selectedOrder = draftOrdersByLocation.get(selectedOrderLocation);
  tray.innerHTML = `
    <span class="tray-title">${escapeHtml(selectedLocationTitle(selectedOrderLocation))}</span>
    <span class="tray-note">${escapeHtml(trayGuidance(actions, activeMode))}</span>
    <div class="tray-type-strip" aria-label="Available order modes">
      ${modes.map((entry) => `
        <button class="${entry.mode} ${entry.mode === activeMode ? "active" : ""}" type="button" data-order-mode="${entry.mode}">
          <span>${escapeHtml(entry.label)}</span><b>${entry.count}</b>
        </button>
      `).join("")}
    </div>
    ${selectedOrder ? `<div class="tray-current-order"><span>Selected</span><strong>${escapeHtml(describeOrder(selectedOrder))}</strong></div>` : ""}
  `;
  for (const button of tray.querySelectorAll("[data-order-mode]")) {
    button.addEventListener("click", () => {
      orderModeByLocation.set(selectedOrderLocation, button.dataset.orderMode);
      pendingActionChoices = null;
      hoveredActionChoices = null;
      renderMapActionTray();
      renderMap();
    });
  }
  if (gameState.phaseType === "A" && !selectedOrder) {
    appendActionGroup(
      tray,
      "",
      actions.filter((action) => actionMode(action) === "local"),
      "tray-action-button",
    );
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "tray-action-button cancel";
  cancel.innerHTML = `<span class="action-icon">${orderIconSvg("cancel", "action-svg")}</span><span>Cancel selection</span>`;
  cancel.addEventListener("click", () => cancelOrderSelection());
  const row = document.createElement("div");
  row.className = "tray-actions";
  row.appendChild(cancel);
  if (explicitOrderLocations.has(selectedOrderLocation)) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "tray-action-button clear";
    clear.innerHTML = `<span class="action-icon">${orderIconSvg("clear", "action-svg")}</span><span>Clear</span>`;
    clear.addEventListener("click", () => clearOrder(selectedOrderLocation));
    row.appendChild(clear);
  }
  tray.appendChild(row);
}

function actionModes(actions) {
  const labels = {
    move: "Move",
    retreat: "Retreat",
    local: "Local",
    support: "Support",
    convoy: "Convoy",
  };
  const order = ["move", "convoy", "retreat", "support", "local"];
  const counts = new Map();
  for (const action of actions) {
    const mode = actionMode(action);
    counts.set(mode, (counts.get(mode) || 0) + 1);
  }
  return order
    .filter((mode) => counts.has(mode))
    .map((mode) => ({ mode, label: labels[mode] || kindLabel(mode), count: counts.get(mode) }));
}

function actionMode(action) {
  if (!action) return "local";
  if (action.kind === "support") return "support";
  if (action.kind === "convoy") return "convoy";
  if (action.kind === "convoy-move") return "convoy";
  if (action.kind === "retreat") return "retreat";
  if (action.kind === "move") return "move";
  return "local";
}

function ensureOrderMode(location) {
  const actions = orderActionsForLocation(location);
  const modes = actionModes(actions).map((entry) => entry.mode);
  const current = orderModeByLocation.get(location);
  if (current && modes.includes(current)) return current;
  const preferred = modes.includes("move")
    ? "move"
    : modes.includes("retreat")
      ? "retreat"
      : modes.includes("local")
        ? "local"
        : modes[0] || "local";
  orderModeByLocation.set(location, preferred);
  return preferred;
}

function appendActionGroup(container, title, actions, className) {
  const group = document.createElement("div");
  group.className = "tray-group";
  if (title) {
    const label = document.createElement("span");
    label.className = "tray-group-title";
    label.textContent = title;
    group.appendChild(label);
  }
  const row = document.createElement("div");
  row.className = "tray-actions";
  for (const action of actions) {
    row.appendChild(actionButton(action, className));
  }
  group.appendChild(row);
  container.appendChild(group);
}

function trayGuidance(actions, activeMode = null) {
  if (gameState.phaseType === "A") return adjustmentHelpText();
  if (gameState.phaseType === "R") return "Retreat or disband this unit.";
  if (activeMode === "support") {
    return "Support is optional. A unit can support an action into a province it could enter, so armies can support fleets into coastal land but not into sea.";
  }
  if (activeMode === "convoy") {
    return "Pick the convoy destination from the army. Matching fleet convoy orders are added automatically when clear.";
  }
  if (actions.some((action) => ["support", "convoy"].includes(action.kind))) {
    return "Pick a mode, hover highlighted provinces to preview orders, then click a province to choose.";
  }
  return actions.some((action) => action.coord) ? "Hover highlighted provinces to preview; click one to choose." : "Choose one legal order.";
}

function moveDestinationsForLocation(location) {
  const destinations = new Set();
  for (const order of gameState.possibleOrders?.[location] || []) {
    const move = moveEndpoints(order);
    if (move) destinations.add(provinceBaseCode(move.to));
  }
  return destinations;
}

function moveOrderForDestination(location, destinationCode) {
  return (gameState.possibleOrders?.[location] || []).find((order) => {
    const move = moveEndpoints(order);
    return move && provinceBaseCode(move.to) === destinationCode;
  });
}

function setHoldOrder(location) {
  const hold = (gameState.possibleOrders?.[location] || []).find((order) => order.endsWith(" H"));
  if (hold) {
    setDirectOrder(location, hold);
  }
}

function renderMapChoices() {
  const overlay = el("mapChoiceOverlay");
  if (!overlay) return;
  overlay.innerHTML = "";
  if (isReviewingBoard()) return;
  if (!gameState?.mapViewBox) return;
  if (!selectedOrderLocation) {
    renderRecentOutcomeBadges(overlay);
    return;
  }

  const clickPrompt = pendingActionChoices?.location === selectedOrderLocation ? pendingActionChoices : null;
  if (clickPrompt) {
    renderMapActionMenu(overlay, clickPrompt);
    return;
  }

  const hoverPrompt = hoveredActionChoices?.location === selectedOrderLocation ? hoveredActionChoices : null;
  if (hoverPrompt) {
    renderMapActionPreview(overlay, hoverPrompt);
    return;
  }

  renderMapModeMenu(overlay);
}

function renderRecentOutcomeBadges(overlay) {
  const outcomes = recentHumanMoveOutcomes();
  if (!outcomes.length) return;
  for (const outcome of outcomes) {
    const coord = coordinateForLocation(outcome.to);
    if (!coord) continue;
    const badge = document.createElement("div");
    badge.className = `move-outcome-badge ${outcome.kind}`;
    badge.style.left = `${(coord.x / gameState.mapViewBox.width) * 100}%`;
    badge.style.top = `${(coord.y / gameState.mapViewBox.height) * 100}%`;
    badge.title = outcome.title;
    badge.innerHTML = `
      ${flagImage(gameState.humanPower, "outcome-flag")}
      <span>${escapeHtml(outcome.label)}</span>
      ${outcome.defeatedPower ? flagImage(outcome.defeatedPower, "outcome-flag defeated") : ""}
    `;
    overlay.appendChild(badge);
  }
}

function recentHumanMoveOutcomes() {
  const phase = activeHistoryPhase();
  if (!phase?.boardAfter?.unitViews || !phase?.boardBefore?.unitViews || !phaseHasMovementOrders(phase)) return [];
  const orders = phase.submitted?.[gameState.humanPower] || phase.orders?.[gameState.humanPower] || [];
  const beforeUnits = phase.boardBefore.unitViews || [];
  const afterUnits = phase.boardAfter.unitViews || [];
  const outcomes = [];
  for (const order of orders) {
    const move = moveEndpoints(order);
    if (!move) continue;
    const destination = provinceBaseCode(move.to);
    const arrived = afterUnits.find(
      (unit) => unit.power === gameState.humanPower && !unit.dislodged && provinceBaseCode(unit.location) === destination,
    );
    if (!arrived) continue;
    const defeated = afterUnits.find(
      (unit) => unit.power !== gameState.humanPower && unit.dislodged && provinceBaseCode(unit.location) === destination,
    ) || beforeUnits.find(
      (unit) => unit.power !== gameState.humanPower && provinceBaseCode(unit.location) === destination,
    );
    outcomes.push({
      kind: defeated ? "victory" : "arrived",
      label: defeated ? "Won" : "Arrived",
      to: move.to,
      defeatedPower: defeated?.power || "",
      title: defeated
        ? `${describeOrder(order)}. ${powerLabel(defeated.power)} must retreat.`
        : describeOrder(order),
    });
  }
  return outcomes.slice(-4);
}

function renderMapActionPreview(overlay, prompt) {
  if (!prompt?.coord) return;
  const preview = document.createElement("div");
  preview.className = "map-action-preview";
  preview.style.left = `${(prompt.coord.x / gameState.mapViewBox.width) * 100}%`;
  preview.style.top = `${(prompt.coord.y / gameState.mapViewBox.height) * 100}%`;
  const visibleActions = prompt.actions.slice(0, 3);
  const extra = prompt.actions.length - visibleActions.length;
  const summary = prompt.actions.length
    ? `${prompt.actions.length} legal ${prompt.actions.length === 1 ? "order" : "orders"}. Click to choose.`
    : "No legal support order.";
  preview.innerHTML = `
    <strong>${escapeHtml(provinceName(prompt.code))}</strong>
    <span>${escapeHtml(prompt.note || summary)}</span>
    <div class="map-action-preview-list">
      ${visibleActions.map((action) => `<small>${escapeHtml(action.label)}${action.subtitle ? `: ${escapeHtml(action.subtitle)}` : ""}</small>`).join("")}
      ${extra > 0 ? `<small>+${extra} more</small>` : ""}
    </div>
  `;
  overlay.appendChild(preview);
}

function renderMapActionMenu(overlay, prompt = pendingActionChoices) {
  if (!prompt || prompt.location !== selectedOrderLocation || !prompt.coord) return;
  const menu = document.createElement("div");
  menu.className = "map-action-menu";
  menu.style.left = `${(prompt.coord.x / gameState.mapViewBox.width) * 100}%`;
  menu.style.top = `${(prompt.coord.y / gameState.mapViewBox.height) * 100}%`;
  const summary = prompt.actions.length
    ? `${prompt.actions.length} legal ${prompt.actions.length === 1 ? "order" : "orders"}`
    : "No legal order";
  menu.innerHTML = `
    <strong>${escapeHtml(provinceName(prompt.code))}</strong>
    <span>${escapeHtml(summary)}</span>
    ${prompt.note ? `<small class="map-action-note">${escapeHtml(prompt.note)}</small>` : ""}
  `;
  for (const action of prompt.actions) {
    menu.appendChild(actionButton(action, "map-action-menu-button"));
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "map-action-menu-button cancel";
  cancel.innerHTML = `
    <span class="action-icon">${orderIconSvg("cancel", "action-svg")}</span>
    <span class="action-copy"><span>Cancel</span><small>Keep current order</small></span>
  `;
  cancel.addEventListener("click", (event) => {
    event.stopPropagation();
    cancelOrderSelection();
  });
  menu.appendChild(cancel);
  overlay.appendChild(menu);
}

function renderMapModeMenu(overlay) {
  if (!selectedOrderLocation || pendingActionChoices || hoveredActionChoices) return;
  const coord = coordinateForLocation(selectedOrderLocation);
  if (!coord) return;
  const actions = orderActionsForLocation(selectedOrderLocation);
  const modes = actionModes(actions);
  if (!modes.length) return;
  const activeMode = ensureOrderMode(selectedOrderLocation);
  const menu = document.createElement("div");
  menu.className = "map-mode-menu";
  menu.style.left = `${(coord.x / gameState.mapViewBox.width) * 100}%`;
  menu.style.top = `${(coord.y / gameState.mapViewBox.height) * 100}%`;
  menu.innerHTML = `
    <strong>${escapeHtml(provinceName(selectedOrderLocation))}</strong>
    <span>${escapeHtml(selectedLocationTitle(selectedOrderLocation))}</span>
  `;
  for (const entry of modes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `map-mode-button ${entry.mode} ${entry.mode === activeMode ? "active" : ""}`;
    button.innerHTML = `
      <span class="action-icon">${orderIconSvg(entry.mode, "action-svg")}</span>
      <span>${escapeHtml(entry.label)}</span>
      <b>${entry.count}</b>
    `;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      orderModeByLocation.set(selectedOrderLocation, entry.mode);
      pendingActionChoices = null;
      hoveredActionChoices = null;
      renderMapActionTray();
      renderMap();
      showToast(`${entry.label} mode.`);
    });
    menu.appendChild(button);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "map-mode-button cancel";
  cancel.innerHTML = `
    <span class="action-icon">${orderIconSvg("cancel", "action-svg")}</span>
    <span>Cancel</span>
  `;
  cancel.addEventListener("click", (event) => {
    event.stopPropagation();
    cancelOrderSelection();
  });
  menu.appendChild(cancel);
  overlay.appendChild(menu);
}

function actionButton(action, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${className} ${action.kind} ${action.foreign ? "foreign-action" : ""}`;
  button.title = action.title || action.label;
  const flags = (action.flagPowers || [])
    .filter(Boolean)
    .map((power) => flagImage(power, "action-flag"))
    .join("");
  button.innerHTML = `
    <span class="action-icon">${orderIconSvg(action.kind, "action-svg")}</span>
    <span class="action-copy">
      <span class="action-head">${flags}<span>${escapeHtml(action.label)}</span></span>
      ${action.subtitle ? `<small>${escapeHtml(action.subtitle)}</small>` : ""}
    </span>
  `;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    setDirectOrder(action.location, action.order, action);
  });
  return button;
}

function actionChoicePayload(location, code, actions, options = {}) {
  return {
    location,
    code,
    actions,
    note: options.note || "",
    coord: coordinateForLocation(code) || actions.find((action) => action.coord)?.coord || coordinateForLocation(location),
  };
}

function sameActionChoicePayload(left, right) {
  if (!left || !right) return false;
  return left.location === right.location &&
    left.code === right.code &&
    left.note === right.note &&
    left.actions.length === right.actions.length &&
    left.actions.every((action, index) => action.order === right.actions[index]?.order);
}

function contextualActionsForCode(location, code) {
  const activeMode = ensureOrderMode(location);
  if (activeMode === "support") {
    const supportMatches = supportOriginActionsForCode(location, code);
    if (supportMatches.length) {
      return {
        actions: sortActionsForMode(supportMatches, "support"),
        note: supportContextNote(location, code, supportMatches),
      };
    }
    const unit = unitAtBase(location);
    const province = gameState.provinces?.[provinceBaseCode(code)];
    const note = unit?.type === "Army" && province?.type === "sea" ? supportRuleHint(location, code) : "";
    return { actions: [], note };
  }
  const clickedUnit = unitAtBase(code);
  const supportMatches = supportOriginActionsForCode(location, code);
  if (clickedUnit?.power === gameState.humanPower && supportMatches.length) {
    return {
      actions: sortActionsForMode(supportMatches, "support"),
      note: supportContextNote(location, code, supportMatches),
    };
  }
  return { actions: activeModeActionsForCode(location, code), note: "" };
}

function supportContextNote(location, code, actions) {
  const unit = unitAtBase(location);
  const supported = unitAtBase(code);
  if (unit?.type === "Army" && supported?.type === "Fleet") {
    const seaAttacks = actions.filter((action) => {
      const target = actionTargetCode(action);
      return gameState.provinces?.[provinceBaseCode(target)]?.type === "sea";
    });
    if (!seaAttacks.length) {
      return "Army support is legal here only for fleet hold or attacks into land provinces the army can enter.";
    }
  }
  return "";
}

function activeModeActionsForCode(location, code) {
  const activeMode = ensureOrderMode(location);
  if (activeMode === "support") {
    const originMatches = supportOriginActionsForCode(location, code);
    if (originMatches.length) return sortActionsForMode(originMatches, "support");
  }
  return orderActionsForLocation(location).filter(
    (action) => actionMode(action) === activeMode && actionMatchesMapCode(action, code),
  );
}

function actionsForCode(location, code) {
  return sortActionsForMode(
    orderActionsForLocation(location).filter((action) => actionMatchesMapCode(action, code)),
    ensureOrderMode(location),
  );
}

function sortActionsForMode(actions, activeMode) {
  return [...actions].sort((left, right) => {
    const leftMode = actionMode(left);
    const rightMode = actionMode(right);
    const leftActive = leftMode === activeMode ? 0 : 1;
    const rightActive = rightMode === activeMode ? 0 : 1;
    return leftActive - rightActive || left.priority - right.priority || left.label.localeCompare(right.label);
  });
}

function orderActionsForLocation(location) {
  const actions = [];
  for (const order of gameState.possibleOrders?.[location] || []) {
    const action = orderAction(location, order);
    if (action) actions.push(action);
  }
  return actions.sort((left, right) => left.priority - right.priority || left.label.localeCompare(right.label));
}

function orderAction(location, order) {
  const raw = String(order || "").trim();
  if (!raw) return null;
  if (raw.toUpperCase() === "WAIVE") {
    return {
      location,
      order,
      kind: "waive",
      label: "Waive",
      icon: "○",
      subtitle: "No build",
      title: "Waive this build",
      coord: coordinateForLocation(location),
      flagPowers: [gameState.humanPower],
      priority: 60,
    };
  }

  const parts = raw.split(/\s+/);
  const loc = parts[1] || location;
  const sourceCoord = coordinateForLocation(loc);
  if (raw.endsWith(" H")) {
    return {
      location,
      order,
      kind: "hold",
      label: "Hold",
      icon: "●",
      subtitle: provinceName(loc),
      title: describeOrder(order),
      coord: sourceCoord,
      flagPowers: [gameState.humanPower],
      priority: 20,
    };
  }
  if (raw.endsWith(" D")) {
    return {
      location,
      order,
      kind: "disband",
      label: "Disband",
      icon: "×",
      subtitle: provinceName(loc),
      title: describeOrder(order),
      coord: sourceCoord,
      flagPowers: [gameState.humanPower],
      priority: 35,
    };
  }
  if (raw.endsWith(" B")) {
    return {
      location,
      order,
      kind: "build",
      label: `Build ${unitWord(parts[0])}`,
      icon: "+",
      subtitle: provinceName(loc),
      title: describeOrder(order),
      coord: coordinateForLocation(loc),
      flagPowers: [gameState.humanPower],
      priority: 30,
    };
  }

  const retreatIndex = parts.indexOf("R");
  if (retreatIndex > -1) {
    const destination = parts[retreatIndex + 1];
    return {
      location,
      order,
      kind: "retreat",
      label: "Retreat",
      icon: "↙",
      subtitle: provinceName(destination),
      title: describeOrder(order),
      coord: coordinateForLocation(destination),
      flagPowers: [gameState.humanPower],
      priority: 10,
    };
  }

  const move = moveEndpoints(order);
  if (move) {
    const via = raw.endsWith(" VIA");
    return {
      location,
      order,
      kind: via ? "convoy-move" : "move",
      label: via ? "Convoy move" : "Move",
      icon: via ? "⇢" : "↗",
      subtitle: via ? `${provinceName(move.from)} → ${provinceName(move.to)}` : provinceName(move.to),
      title: describeOrder(order),
      coord: coordinateForLocation(move.to),
      flagPowers: [gameState.humanPower],
      priority: via ? 7 : 5,
    };
  }

  const supportIndex = parts.indexOf("S");
  if (supportIndex > -1) {
    const supportedUnit = unitWord(parts[supportIndex + 1]).toLowerCase();
    const supportedLoc = parts[supportIndex + 2];
    const moveIndex = parts.indexOf("-", supportIndex);
    const isMoveSupport = moveIndex > -1;
    const targetLoc = isMoveSupport ? parts[moveIndex + 1] : supportedLoc;
    const supportedPower = unitAtBase(supportedLoc)?.power;
    const targetUnit = unitAtBase(targetLoc);
    const targetOwnNote =
      isMoveSupport && targetUnit?.power === gameState.humanPower && supportedPower !== gameState.humanPower
        ? "your unit there"
        : "";
    const supportPowerLabel = supportedPower && supportedPower !== gameState.humanPower ? `${powerLabel(supportedPower)} ` : "";
    const supportedLabel = [supportedPower ? powerLabel(supportedPower) : "", supportedUnit, provinceName(supportedLoc)]
      .filter(Boolean)
      .join(" ");
    return {
      location,
      order,
      kind: "support",
      label: isMoveSupport
        ? `Support ${supportPowerLabel}${supportedUnit} attack`
        : `Support ${supportPowerLabel}${supportedUnit} hold`,
      icon: "S",
      subtitle: isMoveSupport
        ? `${provinceName(supportedLoc)} → ${provinceName(parts[moveIndex + 1])}${targetOwnNote ? ` (${targetOwnNote})` : ""}`
        : supportedLabel,
      title: `${describeOrder(order)}${targetOwnNote ? ". This targets a province with your own unit." : ""}`,
      coord: coordinateForLocation(targetLoc),
      flagPowers: supportedPower ? [supportedPower] : [],
      foreign: Boolean(supportedPower && supportedPower !== gameState.humanPower),
      priority: isMoveSupport ? 42 : 44,
    };
  }

  const convoyIndex = parts.indexOf("C");
  if (convoyIndex > -1) {
    const convoyedLoc = parts[convoyIndex + 2];
    const moveIndex = parts.indexOf("-", convoyIndex);
    const targetLoc = parts[moveIndex + 1];
    const convoyedPower = unitAtBase(convoyedLoc)?.power;
    return {
      location,
      order,
      kind: "convoy",
      label: "Convoy army",
      icon: "C",
      subtitle: `${convoyedPower ? `${powerLabel(convoyedPower)} ` : ""}${provinceName(convoyedLoc)} → ${provinceName(targetLoc)}`,
      title: describeOrder(order),
      coord: coordinateForLocation(targetLoc),
      flagPowers: convoyedPower ? [convoyedPower] : [],
      foreign: Boolean(convoyedPower && convoyedPower !== gameState.humanPower),
      priority: 85,
    };
  }
  return null;
}

function actionTargetCode(action) {
  if (!action) return "";
  if (["hold", "build", "disband", "waive"].includes(action.kind)) {
    return provinceBaseCode(action.location);
  }
  if (["move", "retreat"].includes(action.kind)) {
    const parts = String(action.order).trim().split(/\s+/);
    const marker = action.kind === "retreat" ? "R" : "-";
    const index = parts.indexOf(marker);
    return provinceBaseCode(parts[index + 1]);
  }
  if (action.kind === "convoy-move") {
    const parts = String(action.order).trim().split(/\s+/);
    const index = parts.indexOf("-");
    return provinceBaseCode(parts[index + 1]);
  }
  if (action.kind === "support") {
    const parts = String(action.order).trim().split(/\s+/);
    const supportIndex = parts.indexOf("S");
    const moveIndex = parts.indexOf("-", supportIndex);
    return provinceBaseCode(moveIndex > -1 ? parts[moveIndex + 1] : parts[supportIndex + 2]);
  }
  if (action.kind === "convoy") {
    const parts = String(action.order).trim().split(/\s+/);
    const convoyIndex = parts.indexOf("C");
    const moveIndex = parts.indexOf("-", convoyIndex);
    return provinceBaseCode(parts[moveIndex + 1]);
  }
  return "";
}

function actionMatchesMapCode(action, code) {
  const base = provinceBaseCode(code);
  return actionMapCodes(action).includes(base);
}

function supportOriginActionsForCode(location, code) {
  const base = provinceBaseCode(code);
  return orderActionsForLocation(location).filter(
    (action) => action.kind === "support" && supportOriginCode(action) === base,
  );
}

function supportOriginCode(action) {
  if (!action || action.kind !== "support") return "";
  const parts = String(action.order).trim().split(/\s+/);
  const supportIndex = parts.indexOf("S");
  return provinceBaseCode(parts[supportIndex + 2]);
}

function actionMapCodes(action) {
  if (!action) return [];
  const codes = [actionTargetCode(action)].filter(Boolean);
  if (action.kind === "support") {
    codes.push(supportOriginCode(action));
  }
  if (action.kind === "convoy") {
    const parts = String(action.order).trim().split(/\s+/);
    const convoyIndex = parts.indexOf("C");
    codes.push(provinceBaseCode(parts[convoyIndex + 2]));
  }
  return [...new Set(codes.filter(Boolean))];
}

function setOrderDraft(location, order) {
  draftOrdersByLocation.set(location, order);
  explicitOrderLocations.add(location);
  const select = Array.from(document.querySelectorAll("#ordersList select")).find(
    (candidate) => candidate.dataset.location === location,
  );
  if (select) {
    select.value = order;
    select.closest(".order-row")?.classList.add("order-row-updated");
    setTimeout(() => select.closest(".order-row")?.classList.remove("order-row-updated"), 600);
  }
}

function setOrderSelect(location, order) {
  const companionResult = stageCompanionOrders(orderAction(location, order));
  setOrderDraft(location, order);
  renderOrders();
  renderTurnStatus();
  renderTurnProgress();
  renderMapActionTray();
  renderMap();
  renderOrderArrows();
  updateButtons();
  if (gameState.phaseType === "A" && selectedOrderCount() > requiredOrderCount()) {
    showToast(`Only ${requiredOrderCount()} adjustment choice${requiredOrderCount() === 1 ? "" : "s"} needed. Clear one choice.`);
  } else {
    showToast(orderToast(order, companionResult));
  }
}

function stageCompanionOrders(action) {
  const result = { added: [], conflicts: [] };
  if (!action || action.kind !== "convoy-move") return result;
  for (const companion of convoyCompanionOrders(action.order)) {
    const existing = draftOrdersByLocation.get(companion.location);
    if (existing && existing !== companion.order && explicitOrderLocations.has(companion.location)) {
      result.conflicts.push(companion);
      continue;
    }
    setOrderDraft(companion.location, companion.order);
    result.added.push(companion);
  }
  return result;
}

function convoyCompanionOrders(armyOrder) {
  const move = moveEndpoints(armyOrder);
  if (!move || !String(armyOrder || "").trim().endsWith(" VIA")) return [];
  const targetKey = convoyMoveKey(move.from, move.to);
  const companions = [];
  for (const loc of gameState.orderableLocations || []) {
    const unit = unitAtBase(loc);
    if (!unit || unit.power !== gameState.humanPower || unit.type !== "Fleet") continue;
    for (const order of gameState.possibleOrders?.[loc] || []) {
      const relation = orderRelationEndpoints(order);
      if (
        relation?.kind === "convoy" &&
        convoyMoveKey(relation.carryFrom, relation.to) === targetKey
      ) {
        companions.push({ location: loc, order });
      }
    }
  }
  return companions.sort((left, right) => provinceName(left.location).localeCompare(provinceName(right.location)));
}

function convoyMoveKey(from, to) {
  return `${provinceBaseCode(from)}>${provinceBaseCode(to)}`;
}

function orderToast(order, companionResult = { added: [], conflicts: [] }) {
  const text = describeOrder(order);
  const relation = orderRelationEndpoints(order);
  if (String(order || "").trim().endsWith(" VIA")) {
    const added = companionResult.added || [];
    const conflicts = companionResult.conflicts || [];
    if (added.length && !conflicts.length) {
      return `${text}. Added ${added.map((item) => provinceName(item.location)).join(", ")} convoy order${added.length === 1 ? "" : "s"}.`;
    }
    if (added.length && conflicts.length) {
      return `${text}. Added ${added.length} convoy order${added.length === 1 ? "" : "s"}; ${conflicts.map((item) => provinceName(item.location)).join(", ")} already has another order.`;
    }
    if (conflicts.length) {
      return `${text}. ${conflicts.map((item) => provinceName(item.location)).join(", ")} already has another order; clear it or choose the fleet convoy manually.`;
    }
    return `${text}. No matching fleet convoy order was available; choose the fleet convoy manually.`;
  }
  if (relation?.kind === "convoy") {
    return `${text}. The army must also order the move by convoy.`;
  }
  return text;
}

function renderOrderArrows() {
  const overlay = el("orderArrowOverlay");
  if (!overlay || !gameState?.mapViewBox) return;
  syncMapOverlayFrame();
  overlay.setAttribute("viewBox", `0 0 ${gameState.mapViewBox.width} ${gameState.mapViewBox.height}`);
  overlay.setAttribute("preserveAspectRatio", "none");
  overlay.innerHTML = "";
  if (!showArrows) return;

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <marker id="arrow-own" viewBox="0 0 16 16" markerWidth="22" markerHeight="22" refX="13" refY="8" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M2,3 L14,8 L2,13 Z"></path>
    </marker>
    <marker id="arrow-history" viewBox="0 0 16 16" markerWidth="18" markerHeight="18" refX="13" refY="8" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M2,3 L14,8 L2,13 Z"></path>
    </marker>
    <marker id="arrow-support" viewBox="0 0 16 16" markerWidth="16" markerHeight="16" refX="13" refY="8" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M2,3 L14,8 L2,13 Z"></path>
    </marker>
    <marker id="arrow-support-attack" viewBox="0 0 16 16" markerWidth="18" markerHeight="18" refX="13" refY="8" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M2,3 L14,8 L2,13 Z"></path>
    </marker>
    <marker id="arrow-convoy" viewBox="0 0 16 16" markerWidth="16" markerHeight="16" refX="13" refY="8" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M2,3 L14,8 L2,13 Z"></path>
    </marker>
  `;
  overlay.appendChild(defs);

  const reviewed = activeHistoryPhase();
  if (reviewed) {
    for (const orders of Object.values(reviewed.submitted || {})) {
      for (const order of orders) drawMoveArrow(overlay, order, "history");
    }
  }

  for (const order of selectedOrders()) {
    drawMoveArrow(overlay, order, "own");
    drawOrderRelation(overlay, order);
  }
}

function drawMoveArrow(overlay, order, kind) {
  const move = moveEndpoints(order);
  if (!move) return;
  const start = coordinateForLocation(move.from);
  const end = coordinateForLocation(move.to);
  if (!start || !end) return;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const curve = Math.min(80, length * 0.18);
  const bend = kind === "own" ? 1 : -1;
  const controlX = (start.x + end.x) / 2 + (-dy / length) * curve * bend;
  const controlY = (start.y + end.y) / 2 + (dx / length) * curve * bend;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.classList.add("move-arrow", `move-arrow-${kind}`);
  path.setAttribute("d", `M ${start.x} ${start.y} Q ${controlX} ${controlY} ${end.x} ${end.y}`);
  path.setAttribute("marker-end", `url(#arrow-${kind})`);
  overlay.appendChild(path);

  if (kind === "own") {
    const flow = document.createElementNS("http://www.w3.org/2000/svg", "path");
    flow.classList.add("move-arrow-flow", "move-arrow-flow-own");
    flow.setAttribute("d", path.getAttribute("d"));
    overlay.appendChild(flow);
    drawMoveEndpoint(overlay, start, "origin");
    drawMoveEndpoint(overlay, end, "target");
  }
}

function drawMoveEndpoint(overlay, coord, role) {
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.classList.add("move-endpoint", `move-endpoint-${role}`);
  group.setAttribute("transform", `translate(${coord.x} ${coord.y})`);
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("r", role === "target" ? "7" : "4.5");
  group.appendChild(circle);
  overlay.appendChild(group);
}

function drawOrderRelation(overlay, order) {
  const relation = orderRelationEndpoints(order);
  if (!relation) return;
  if (relation.kind === "support" && relation.supportFrom && provinceBaseCode(relation.supportFrom) !== provinceBaseCode(relation.to)) {
    if (drawSupportMoveRelation(overlay, relation)) return;
  }
  const start = coordinateForLocation(relation.from);
  const end = coordinateForLocation(relation.to);
  if (!start || !end) return;
  const carryStart = relation.kind === "convoy" ? coordinateForLocation(relation.carryFrom) : null;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.classList.add("move-arrow", `move-arrow-${relation.kind}`);
  path.setAttribute(
    "d",
    relation.kind === "convoy" && carryStart
      ? `M ${carryStart.x} ${carryStart.y} L ${start.x} ${start.y} L ${end.x} ${end.y}`
      : `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
  );
  path.setAttribute("marker-end", `url(#arrow-${relation.kind})`);
  overlay.appendChild(path);

  const flow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  flow.classList.add("move-arrow-flow", `move-arrow-flow-${relation.kind}`);
  flow.setAttribute("d", path.getAttribute("d"));
  overlay.appendChild(flow);

  drawRelationBadge(
    overlay,
    relation,
    relation.kind === "convoy"
      ? start
      : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
  );
}

function drawSupportMoveRelation(overlay, relation) {
  const support = coordinateForLocation(relation.from);
  const attacker = coordinateForLocation(relation.supportFrom);
  const target = coordinateForLocation(relation.to);
  if (!support || !attacker || !target) return false;

  const assistPath = `M ${support.x} ${support.y} L ${attacker.x} ${attacker.y}`;
  const attackPath = `M ${attacker.x} ${attacker.y} L ${target.x} ${target.y}`;

  const assist = document.createElementNS("http://www.w3.org/2000/svg", "path");
  assist.classList.add("move-arrow", "move-arrow-support", "move-arrow-support-link");
  assist.setAttribute("d", assistPath);
  assist.setAttribute("marker-end", "url(#arrow-support)");
  overlay.appendChild(assist);

  const attack = document.createElementNS("http://www.w3.org/2000/svg", "path");
  attack.classList.add("move-arrow", "move-arrow-support-attack");
  attack.setAttribute("d", attackPath);
  attack.setAttribute("marker-end", "url(#arrow-support-attack)");
  overlay.appendChild(attack);

  const assistFlow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  assistFlow.classList.add("move-arrow-flow", "move-arrow-flow-support");
  assistFlow.setAttribute("d", assistPath);
  overlay.appendChild(assistFlow);

  const attackFlow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  attackFlow.classList.add("move-arrow-flow", "move-arrow-flow-support-attack");
  attackFlow.setAttribute("d", attackPath);
  overlay.appendChild(attackFlow);

  drawMoveEndpoint(overlay, target, "target");
  drawRelationBadge(
    overlay,
    relation,
    { x: (support.x + attacker.x) / 2, y: (support.y + attacker.y) / 2 },
  );
  return true;
}

function drawRelationBadge(overlay, relation, coord) {
  const badge = document.createElementNS("http://www.w3.org/2000/svg", "g");
  badge.classList.add("order-relation-badge", `order-relation-badge-${relation.kind}`);
  badge.setAttribute("transform", `translate(${coord.x} ${coord.y})`);
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("r", "13");
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "central");
  text.textContent = relation.kind === "convoy" ? "C" : "+";
  badge.append(circle, text);
  overlay.appendChild(badge);
}

function moveEndpoints(order) {
  if (!order) return null;
  const parts = String(order).trim().split(/\s+/);
  const moveIndex = parts.indexOf("-");
  if (moveIndex < 0 || parts.includes("S") || parts.includes("C") || parts.includes("R")) return null;
  return { from: parts[1], to: parts[moveIndex + 1] };
}

function orderRelationEndpoints(order) {
  if (!order) return null;
  const parts = String(order).trim().split(/\s+/);
  const supportIndex = parts.indexOf("S");
  if (supportIndex > -1) {
    const moveIndex = parts.indexOf("-", supportIndex);
    return {
      kind: "support",
      from: parts[1],
      supportUnit: parts[supportIndex + 1],
      supportFrom: parts[supportIndex + 2],
      to: moveIndex > -1 ? parts[moveIndex + 1] : parts[supportIndex + 2],
    };
  }
  const convoyIndex = parts.indexOf("C");
  if (convoyIndex > -1) {
    const moveIndex = parts.indexOf("-", convoyIndex);
    return {
      kind: "convoy",
      from: parts[1],
      carryFrom: parts[convoyIndex + 2],
      to: parts[moveIndex + 1],
    };
  }
  return null;
}

function coordinateForLocation(location) {
  if (!location || !gameState?.unitCoordinates) return null;
  const raw = String(location).toUpperCase();
  const normalized = raw.replace(/[/-]/g, "_");
  const slashKey = raw.replace(/-/g, "/");
  const hyphenKey = raw.replace(/\//g, "-");
  const base = provinceBaseCode(raw);
  const aliasBase = aliasedProvinceCode(base);
  const keys = [
    raw,
    normalized,
    slashKey,
    hyphenKey,
    slashKey.replace(/[/-]/g, "_"),
    hyphenKey.replace(/[/-]/g, "_"),
    aliasBase,
    base,
  ];
  for (const key of keys) {
    if (gameState.unitCoordinates[key]) return gameState.unitCoordinates[key];
  }
  return null;
}

function renderOrders() {
  const container = el("ordersList");
  container.innerHTML = "";
  const locations = gameState.orderableLocations || [];
  if (!locations.length) {
    container.innerHTML = `<div class="empty-note">No moves needed for ${powerLabel(gameState.humanPower)} right now.</div>`;
    return;
  }
  if (gameState.phaseType === "A") {
    renderAdjustmentOrders(container, locations);
    return;
  }

  const pendingByLoc = new Map();
  for (const order of gameState.pendingHumanOrders || []) {
    const loc = orderableLocationForOrder(order);
    if (loc) pendingByLoc.set(loc, order);
  }

  for (const loc of locations) {
    const row = document.createElement("div");
    row.className = "order-row order-row-compact";

    const unit = unitAt(loc);
    const label = document.createElement("div");
    label.className = "order-location";
    const locationButton = document.createElement("button");
    locationButton.type = "button";
    locationButton.className = "order-location-button";
    locationButton.innerHTML = `
      <span class="order-unit">${escapeHtml(orderableLocationType(loc, unit))}</span>
      <span class="order-province">${escapeHtml(provinceName(loc))}</span>
    `;
    locationButton.addEventListener("click", () => selectOrderLocation(loc));
    label.appendChild(locationButton);

    const choices = gameState.possibleOrders[loc] || [];
    const pending = pendingByLoc.get(loc);
    if (pending && !draftOrdersByLocation.has(loc)) {
      draftOrdersByLocation.set(loc, pending);
      explicitOrderLocations.add(loc);
    }
    const selected = draftOrdersByLocation.get(loc) || defaultOrderForLocation(loc);
    const choicesPanel = document.createElement("div");
    choicesPanel.className = "advanced-order-choices";
    choicesPanel.setAttribute("role", "list");
    for (const order of choices) {
      const action = orderAction(loc, order);
      if (!action) continue;
      const button = actionButton(action, "advanced-order-button");
      button.classList.toggle("selected", order === selected);
      choicesPanel.appendChild(button);
    }

    row.append(label, choicesPanel);
    container.appendChild(row);
  }
}

function renderAdjustmentOrders(container, locations) {
  const full = selectedOrderCount() >= requiredOrderCount();
  for (const loc of locations) {
    const selected = draftOrdersByLocation.get(loc);
    const canPick = selected || !full;
    const row = document.createElement("div");
    row.className = `order-row adjustment-candidate ${selected ? "selected" : ""} ${canPick ? "" : "disabled"}`;

    const label = document.createElement("button");
    label.type = "button";
    label.className = "order-location-button";
    label.innerHTML = `
      <span class="order-unit">${escapeHtml(orderableLocationType(loc, unitAt(loc)))}</span>
      <span class="order-province">${escapeHtml(provinceName(loc))}</span>
      <small>${escapeHtml(selected ? describeOrder(selected) : canPick ? "Available" : "Clear another choice first")}</small>
    `;
    label.addEventListener("click", () => {
      if (canPick) selectOrderLocation(loc);
    });

    const actions = document.createElement("div");
    actions.className = "adjustment-actions";
    if (selected) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "tray-action-button clear";
      clear.innerHTML = `<span class="action-icon">${orderIconSvg("clear", "action-svg")}</span><span>Clear</span>`;
      clear.addEventListener("click", () => clearOrder(loc));
      actions.appendChild(clear);
    } else {
      for (const action of orderActionsForLocation(loc)) {
        const button = actionButton(action, "tray-action-button");
        button.disabled = !canPick;
        actions.appendChild(button);
      }
    }

    row.append(label, actions);
    container.appendChild(row);
  }
}

function renderChatTabs() {
  const tabs = el("chatTabs");
  tabs.innerHTML = "";
  const channels = ["GLOBAL", ...gameState.powers.filter((power) => power !== gameState.humanPower)];
  if (!channels.includes(activeChatChannel)) activeChatChannel = "GLOBAL";

  for (const channel of channels) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chat-tab ${channel === activeChatChannel ? "active" : ""} ${pendingReplies.has(channel) ? "pending" : ""}`;
    const last = lastMessageForChannel(channel);
    const label = channel === "GLOBAL" ? "Table" : powerLabel(channel);
    const preview = pendingReplies.has(channel)
      ? "Replying..."
      : last
        ? displayMessageContent(last.content)
        : channel === "GLOBAL"
          ? "Public table talk"
          : "No private messages";
    if (channel === "GLOBAL") {
      button.innerHTML = `
        <span class="tab-avatar table-dot" aria-hidden="true"></span>
        <span class="tab-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(preview)}</small></span>
      `;
    } else {
      button.innerHTML = `
        <span class="tab-avatar">${flagImage(channel, "tab-flag")}</span>
        <span class="tab-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(preview)}</small></span>
      `;
    }
    button.addEventListener("click", () => {
      activeChatChannel = channel;
      renderChatTabs();
      renderRecipients();
      renderMessages();
      updateButtons();
    });
    tabs.appendChild(button);
  }
}

function lastMessageForChannel(channel) {
  const messages = visibleMessagesForChannel(channel);
  return messages[messages.length - 1] || null;
}

function renderRecipients() {
  const select = el("recipientSelect");
  select.innerHTML = "";
  const publicOption = document.createElement("option");
  publicOption.value = "GLOBAL";
  publicOption.textContent = "Everyone";
  select.appendChild(publicOption);
  for (const power of gameState.powers) {
    if (power === gameState.humanPower) continue;
    const option = document.createElement("option");
    option.value = power;
    option.textContent = powerLabel(power);
    select.appendChild(option);
  }
  select.value = activeChatChannel;
}

function renderMessages() {
  const log = el("messageLog");
  log.innerHTML = "";
  const messages = visibleMessagesForChannel(activeChatChannel);
  if (!messages.length) {
    log.innerHTML = `<div class="empty-note">${activeChatChannel === "GLOBAL" ? "No table messages yet." : `No messages with ${powerLabel(activeChatChannel)} yet.`}</div>`;
    return;
  }

  for (const message of messages.slice(-100)) {
    const mine = message.sender === gameState.humanPower;
    const node = document.createElement("article");
    node.className = `message ${mine ? "mine" : ""} ${message.pending ? "pending" : ""}`;
    node.innerHTML = `
      <div class="message-meta">
        <span>${escapeHtml(messageHeading(message))}</span>
        <span>${escapeHtml(message.pending ? "Sending..." : displayPhase(message.phase))}</span>
      </div>
      <div class="message-body">${escapeHtml(displayMessageContent(message.content))}</div>
    `;
    log.appendChild(node);
  }
  log.scrollTop = log.scrollHeight;
}

function visibleMessagesForChannel(channel) {
  const messages = gameState.messages || [];
  if (channel === "GLOBAL") {
    return messages.filter((message) => message.recipient === "GLOBAL" || message.sender === "SYSTEM");
  }
  return messages.filter(
    (message) =>
      (message.sender === gameState.humanPower && message.recipient === channel) ||
      (message.sender === channel && message.recipient === gameState.humanPower),
  );
}

function displayMessageContent(content) {
  const raw = String(content || "").trim();
  if (!raw) return "";
  if (raw.startsWith("{") && raw.includes('"content"')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.content) {
        return String(parsed.content).trim();
      }
    } catch (_error) {
      const match = raw.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)/s);
      if (match) {
        return match[1]
          .replace(/\\"/g, '"')
          .replace(/\\n/g, "\n")
          .replace(/\\\//g, "/")
          .replace(/"\s*,?\s*"?send"?\s*:.*$/is, "")
          .replace(/"\s*}\s*$/s, "")
          .replace(/["}\s]+$/g, "")
          .trim();
      }
    }
  }
  return raw;
}

function renderCenters() {
  const board = el("centersBoard");
  board.innerHTML = "";
  const boardState = activeBoardState();
  const sortedPowers = [...gameState.powers].sort((left, right) => {
    const rightCount = (boardState.centers[right] || []).length;
    const leftCount = (boardState.centers[left] || []).length;
    return rightCount - leftCount || left.localeCompare(right);
  });
  for (const power of sortedPowers) {
    const centers = boardState.centers[power] || [];
    const visibleCenters = centers.map(provinceName).slice(0, 4).join(", ");
    const extra = centers.length > 4 ? ` +${centers.length - 4} more` : "";
    const row = document.createElement("div");
    row.className = `center-row ${power === gameState.humanPower ? "current-player" : ""}`;
    row.title = centers.map(provinceName).join(", ");
    row.innerHTML = `
      <span class="power-chip power-${power}">${flagImage(power, "chip-flag")}<span>${powerLabel(power)}</span></span>
      <span class="center-count">${centers.length}</span>
      <span class="muted">${escapeHtml(visibleCenters || "No centers")}${escapeHtml(extra)}</span>
    `;
    board.appendChild(row);
  }
}

function renderLastResult() {
  const phases = completedPhases();
  if (!phases.length) {
    historyIndex = null;
    el("historyLabel").textContent = "Latest";
    el("lastResult").textContent = "No turns finished yet.";
    return;
  }

  if (historyIndex === null || historyIndex >= phases.length) historyIndex = phases.length - 1;
  const phase = phases[historyIndex];
  el("historyLabel").textContent = `${historyIndex + 1} of ${phases.length}`;

  const boardPhase = phase.boardAfter?.phase ? `Board after: ${displayPhase(phase.boardAfter.phase)}` : "";
  const lines = [`${displayPhase(phase.name)}${boardPhase ? ` (${boardPhase})` : ""}`];
  for (const [power, orders] of Object.entries(phase.submitted || {})) {
    lines.push(`${powerLabel(power)}:`);
    for (const order of orders) {
      lines.push(`  ${describeOrder(order)}`);
    }
  }
  el("lastResult").textContent = lines.join("\n");
}

function completedPhases() {
  if (Array.isArray(gameState.phaseHistory)) return gameState.phaseHistory;
  return gameState.lastPhase ? [gameState.lastPhase] : [];
}

function activeHistoryPhase() {
  const phases = completedPhases();
  if (!phases.length) return null;
  if (!showBottomDock) return latestMovementPhase() || phases[phases.length - 1] || null;
  const index = historyIndex === null ? phases.length - 1 : Math.min(historyIndex, phases.length - 1);
  return phases[index] || null;
}

function latestMovementPhase() {
  const phases = completedPhases();
  for (let index = phases.length - 1; index >= 0; index -= 1) {
    if (phaseHasMovementOrders(phases[index])) return phases[index];
  }
  return null;
}

function phaseHasMovementOrders(phase) {
  for (const orders of Object.values(phase?.submitted || {})) {
    if ((orders || []).some((order) => moveEndpoints(order) || orderRelationEndpoints(order))) return true;
  }
  return false;
}

function moveHistory(delta) {
  const phases = completedPhases();
  if (!phases.length) return;
  const current = historyIndex === null ? phases.length - 1 : historyIndex;
  historyIndex = Math.max(0, Math.min(phases.length - 1, current + delta));
  renderLastResult();
  renderMap();
  renderOrderArrows();
  renderCenters();
  updateButtons();
}

function updateButtons() {
  const busy = isBusy();
  const serverBusy = busy || pendingReplies.size > 0 || replyWorkerRunning;
  const realAi = Boolean(gameState.aiStatus?.real);
  const needsOrders = (gameState.orderableLocations || []).length > 0;
  const hasAllOrders = allOrdersChosen();
  updateResolveButtonLabel();
  el("resolveButton").disabled = serverBusy || gameState.isGameDone || !realAi || !hasAllOrders;
  el("runPressButton").disabled = serverBusy || gameState.isGameDone || !gameState.phase.endsWith("M") || !realAi;
  el("sendMessageButton").disabled = pendingResolve || gameState.isGameDone;
  el("askReplyButton").disabled =
    serverBusy || gameState.isGameDone || activeChatChannel === "GLOBAL" || !realAi || pendingReplies.has(activeChatChannel);
  const phases = completedPhases();
  const currentHistory = historyIndex === null ? phases.length - 1 : historyIndex;
  el("historyPrevButton").disabled = busy || !phases.length || currentHistory <= 0;
  el("historyNextButton").disabled = busy || !phases.length || currentHistory >= phases.length - 1;
  el("zoomOutButton").disabled = busy || mapScale <= 1;
  el("zoomInButton").disabled = busy || mapScale >= 2;
  el("zoomResetButton").disabled = busy || mapScale === defaultMapScale;
  el("toggleArrowsButton").disabled = busy;
  el("toggleArrowsButton").classList.toggle("active", showArrows);
  el("toggleDockButton").disabled = busy;
  el("toggleDockButton").classList.toggle("active", showBottomDock);
}

function updateResolveButtonLabel() {
  const button = el("resolveButton");
  if (!button) return;
  const text = button.querySelector("span:last-child");
  if (!text) return;
  button.title = "Submit everyone and finish this turn";
  if (pendingResolve || gameState.busy) {
    text.textContent = "Resolving...";
  } else if (pendingReplies.size || replyWorkerRunning) {
    text.textContent = "Reply pending";
  } else if (!(gameState.orderableLocations || []).length) {
    text.textContent = "Continue";
    button.title = "No orders are needed from you. Continue to the next phase.";
  } else if (!allOrdersChosen()) {
    text.textContent = gameState.phaseType === "R" ? "Choose Retreats" : gameState.phaseType === "A" ? "Choose Builds" : "Choose Orders";
    button.title = "Choose the required orders before continuing.";
  } else {
    text.textContent = "Finish Turn";
  }
}

function applyMapZoom() {
  const viewport = el("mapViewport");
  if (!viewport) return;
  clampMapPan();
  viewport.style.setProperty("--token-scale", String(Math.round((1 / mapScale) * 1000) / 1000));
  viewport.style.transform = `translate3d(${mapPanX}px, ${mapPanY}px, 0) scale(${mapScale})`;
}

function changeZoom(delta) {
  mapScale = Math.max(1, Math.min(2, Math.round((mapScale + delta) * 100) / 100));
  applyMapZoom();
}

function resetZoom() {
  mapScale = defaultMapScale;
  mapPanX = 0;
  mapPanY = 0;
  applyMapZoom();
}

function toggleArrows() {
  showArrows = !showArrows;
  renderOrderArrows();
  updateButtons();
}

function toggleBottomDock() {
  showBottomDock = !showBottomDock;
  renderBottomDock();
  renderMap();
  renderOrderArrows();
  renderCenters();
  updateButtons();
}

function toggleSidePanel() {
  showSidePanel = !showSidePanel;
  renderBodyState();
}

function renderBottomDock() {
  const dock = el("bottomDock");
  if (!dock) return;
  dock.classList.toggle("is-hidden", !showBottomDock);
}

function clampMapPan() {
  const viewport = el("mapViewport");
  if (!viewport) return;
  const width = viewport.clientWidth || 1;
  const height = viewport.clientHeight || 1;
  const zoomAllowance = Math.max(0, mapScale - 1);
  const maxX = width * (0.16 + zoomAllowance * 0.48);
  const maxY = height * (0.12 + zoomAllowance * 0.48);
  mapPanX = Math.max(-maxX, Math.min(maxX, mapPanX));
  mapPanY = Math.max(-maxY, Math.min(maxY, mapPanY));
}

function installMapPanHandlers() {
  const frame = el("mapFrame");
  if (!frame) return;

  frame.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button, select, textarea, input, .unit-token")) return;
    panStart = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: mapPanX,
      panY: mapPanY,
      moved: false,
    };
    frame.setPointerCapture(event.pointerId);
    frame.classList.add("is-panning");
  });

  frame.addEventListener("pointermove", (event) => {
    if (!panStart || panStart.id !== event.pointerId) return;
    const dx = event.clientX - panStart.x;
    const dy = event.clientY - panStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) panStart.moved = true;
    mapPanX = panStart.panX + dx;
    mapPanY = panStart.panY + dy;
    applyMapZoom();
    event.preventDefault();
  });

  const finishPan = (event) => {
    if (!panStart || panStart.id !== event.pointerId) return;
    if (panStart.moved) {
      suppressMapClickUntil = Date.now() + 250;
    } else {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const provincePath = target?.closest?.("#MouseLayer path[id], #MapLayer path[id^='_']");
      if (provincePath) {
        suppressMapClickUntil = Date.now() + 250;
        handleMapPathClick(provincePath);
      }
    }
    panStart = null;
    frame.classList.remove("is-panning");
    if (frame.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
  };

  frame.addEventListener("pointerup", finishPan);
  frame.addEventListener("pointercancel", finishPan);
  frame.addEventListener("lostpointercapture", () => {
    panStart = null;
    frame.classList.remove("is-panning");
  });
}

function provinceName(code) {
  if (!code) return "";
  const normalized = String(code).replace(/[/-]/g, "_").toUpperCase();
  const [rawBase, coast] = normalized.split("_");
  const base = aliasedProvinceCode(rawBase);
  const name = gameState?.provinceNames?.[base] || base;
  if (!coast) return name;
  const coastName = coast === "NC" ? "North Coast" : coast === "SC" ? "South Coast" : coast === "EC" ? "East Coast" : coast;
  return `${name} (${coastName})`;
}

function unitAt(location) {
  const normalized = location.toUpperCase();
  return (gameState.unitViews || []).find((unit) => unit.location.toUpperCase() === normalized);
}

function unitAtBase(location) {
  const base = provinceBaseCode(location);
  return (gameState.unitViews || []).find((unit) => provinceBaseCode(unit.location) === base);
}

function describeOrder(order) {
  if (!order) return "";
  const raw = String(order).trim();
  if (raw.toUpperCase() === "WAIVE") return "Waive build";

  const parts = raw.split(/\s+/);
  const unit = unitWord(parts[0]);
  const loc = parts[1];

  if (raw.endsWith(" H")) {
    return `${unit} in ${provinceName(loc)} holds`;
  }
  if (raw.endsWith(" B")) {
    return `Build ${unit.toLowerCase()} in ${provinceName(loc)}`;
  }
  if (raw.endsWith(" D")) {
    return `Disband ${unit.toLowerCase()} in ${provinceName(loc)}`;
  }
  const retreatIndex = parts.indexOf("R");
  if (retreatIndex > -1) {
    return `${unit} retreats from ${provinceName(loc)} to ${provinceName(parts[retreatIndex + 1])}`;
  }

  const supportIndex = parts.indexOf("S");
  if (supportIndex > -1) {
    const supportedUnit = unitWord(parts[supportIndex + 1]);
    const supportedLoc = parts[supportIndex + 2];
    const moveIndex = parts.indexOf("-", supportIndex);
    if (moveIndex > -1) {
      return `${unit} in ${provinceName(loc)} supports ${supportedUnit.toLowerCase()} from ${provinceName(supportedLoc)} to ${provinceName(parts[moveIndex + 1])}`;
    }
    return `${unit} in ${provinceName(loc)} supports ${supportedUnit.toLowerCase()} in ${provinceName(supportedLoc)}`;
  }

  const convoyIndex = parts.indexOf("C");
  if (convoyIndex > -1) {
    const convoyedLoc = parts[convoyIndex + 2];
    const moveIndex = parts.indexOf("-", convoyIndex);
    return `${unit} in ${provinceName(loc)} convoys army from ${provinceName(convoyedLoc)} to ${provinceName(parts[moveIndex + 1])}`;
  }

  const moveIndex = parts.indexOf("-");
  if (moveIndex > -1) {
    const via = raw.endsWith(" VIA") ? " by convoy" : "";
    return `${unit} from ${provinceName(loc)} to ${provinceName(parts[moveIndex + 1])}${via}`;
  }

  return raw;
}

function noOrderReason() {
  if (!gameState) return "No moves needed right now.";
  const human = powerLabel(gameState.humanPower);
  if (gameState.phaseType === "R") return `No ${human} units were dislodged, so you have no retreat decision this phase.`;
  if (gameState.phaseType === "A") return `No ${human} build or disband decision is needed this phase.`;
  return `No ${human} move orders are needed this phase.`;
}

function selectedLocationTitle(location) {
  const unit = unitAt(location);
  if (gameState?.phaseType === "A" && adjustmentNeed() > 0) return `Build site ${provinceName(location)}`;
  if (gameState?.phaseType === "A" && adjustmentNeed() < 0) return `${unit?.type || "Unit"} to disband in ${provinceName(location)}`;
  return `${unit?.type || "Order"} ${provinceName(location)}`;
}

function orderableLocationType(location, unit = unitAt(location)) {
  if (gameState?.phaseType === "A" && adjustmentNeed() > 0) return "Home center";
  if (gameState?.phaseType === "A" && adjustmentNeed() < 0) return unit?.type || "Unit";
  if (gameState?.phaseType === "R") return unit?.type || "Retreat";
  return unit?.type || "Unit";
}

function unitWord(code) {
  return code === "F" ? "Fleet" : code === "A" ? "Army" : code || "Unit";
}

function orderLocation(order) {
  if (!order || order.toUpperCase() === "WAIVE") return null;
  const parts = order.trim().split(/\s+/);
  return parts.length > 1 ? parts[1] : null;
}

function orderableLocationForOrder(order) {
  const raw = String(order || "").trim();
  if (!raw || raw.toUpperCase() === "WAIVE") return null;
  const upper = raw.toUpperCase();
  for (const loc of gameState?.orderableLocations || []) {
    if ((gameState.possibleOrders?.[loc] || []).some((choice) => choice.toUpperCase() === upper)) {
      return loc;
    }
  }
  const loc = orderLocation(raw);
  if (!loc) return null;
  return (gameState?.orderableLocations || []).find((candidate) => provinceBaseCode(candidate) === provinceBaseCode(loc)) || loc;
}

function provinceBaseCode(value) {
  return String(value || "")
    .replace(/^_/, "")
    .toUpperCase()
    .split(/[\/_-]/)[0];
}

function provinceAliasMap() {
  return {
    ...defaultVisualProvinceAliases,
    ...(gameState?.visualProvinceAliases || {}),
  };
}

function aliasedProvinceCode(value) {
  const base = provinceBaseCode(value);
  return provinceAliasMap()[base] || base;
}

function mapProvinceCode(value) {
  return aliasedProvinceCode(value);
}

function selectedOrders() {
  return (gameState.orderableLocations || [])
    .filter((loc) => explicitOrderLocations.has(loc))
    .map((loc) => draftOrdersByLocation.get(loc))
    .filter(Boolean);
}

function defaultOrderForLocation(location) {
  const choices = gameState?.possibleOrders?.[location] || [];
  if (gameState?.phaseType !== "M") return "";
  return choices.find((choice) => choice.endsWith(" H")) || choices[0] || "";
}

function adjustmentNeed() {
  const raw = gameState?.builds?.[gameState.humanPower]?.count;
  const count = Number(raw);
  return Number.isFinite(count) ? count : 0;
}

function requiredOrderCount() {
  const locations = gameState?.orderableLocations || [];
  if (!locations.length) return 0;
  if (gameState?.phaseType === "A") return Math.abs(adjustmentNeed());
  return locations.length;
}

function selectedOrderCount() {
  if (gameState?.phaseType === "M") return explicitOrderLocations.size;
  return selectedOrders().length;
}

function adjustmentHelpText() {
  const need = adjustmentNeed();
  const required = Math.abs(need);
  const remaining = Math.max(0, required - selectedOrders().length);
  if (need > 0) {
    return remaining
      ? `Winter builds: choose ${remaining} more build or waive choice${remaining === 1 ? "" : "s"}.`
      : `Winter builds: ${required} build or waive choice${required === 1 ? "" : "s"} selected.`;
  }
  if (need < 0) {
    return remaining
      ? `Winter disbands: choose ${remaining} more unit${remaining === 1 ? "" : "s"} to disband.`
      : `Winter disbands: ${required} unit${required === 1 ? "" : "s"} selected.`;
  }
  return "No builds or disbands are needed.";
}

function adjustmentContextText() {
  if (gameState?.phaseType !== "A") return "";
  const unitLocations = (gameState.unitViews || [])
    .filter((unit) => unit.power === gameState.humanPower)
    .map((unit) => provinceName(unit.location));
  if (adjustmentNeed() > 0) {
    const sites = gameState.orderableLocations || [];
    return `Existing units stay in ${joinNames(unitLocations)}. New units can only be built at empty home centers: ${joinNames(sites.map(provinceName))}.`;
  }
  if (adjustmentNeed() < 0) {
    return `Existing units are over the supply limit; choose which units to remove.`;
  }
  return "Existing units stay where they are.";
}

function joinNames(names) {
  const clean = names.filter(Boolean);
  if (!clean.length) return "";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")}, and ${clean[clean.length - 1]}`;
}

function orderRequirementMessage() {
  if (gameState?.phaseType === "A") return adjustmentHelpText();
  if (gameState?.phaseType === "R") return "Choose a retreat or disband for every highlighted unit.";
  return "Holds are automatic; choose only the units you want to change.";
}

async function saveOrders() {
  if (!allOrdersChosen()) {
    showToast(orderRequirementMessage());
    return;
  }
  try {
    setWorking("Saving moves...");
    gameState = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({ orders: selectedOrders() }),
    });
    render();
    showToast("Moves saved.");
  } catch (error) {
    await recover(error);
  }
}

async function sendMessage() {
  const content = el("messageInput").value.trim();
  if (!content) {
    showToast("Write a message first.");
    return;
  }
  const recipient = el("recipientSelect").value;
  const localMessage = {
    phase: gameState.phase,
    sender: gameState.humanPower,
    recipient,
    content,
    pending: true,
  };
  try {
    activeChatChannel = recipient;
    gameState.messages = [...(gameState.messages || []), localMessage];
    el("messageInput").value = "";
    render();
    showToast("Message sent.");
    el("sendMessageButton").disabled = true;
    el("statusText").textContent = "Saving message...";
    gameState = await api("/api/message", {
      method: "POST",
      body: JSON.stringify({ recipient, content }),
    });
    activeChatChannel = recipient;
    render();
    if (recipient !== "GLOBAL" && !gameState.isGameDone) {
      if (!gameState.aiStatus?.real) {
        showToast("Real LLM agents are not connected.");
        return;
      }
      requestReplyInBackground(recipient);
    }
  } catch (error) {
    await recover(error);
  } finally {
    updateButtons();
  }
}

async function askReply() {
  if (activeChatChannel === "GLOBAL") return;
  requestReplyInBackground(activeChatChannel);
}

function requestReplyInBackground(channel) {
  if (!channel || channel === "GLOBAL" || pendingReplies.has(channel)) return;
  pendingReplies.add(channel);
  replyQueue.push(channel);
  clientBusyText = replyWorkerRunning ? `${pendingReplies.size} replies pending...` : `${powerLabel(channel)} is replying...`;
  renderChatTabs();
  updateButtons();
  processReplyQueue();
}

async function processReplyQueue() {
  if (replyWorkerRunning) return;
  replyWorkerRunning = true;
  try {
    while (replyQueue.length) {
      const channel = replyQueue.shift();
      if (!pendingReplies.has(channel)) continue;
      clientBusyText = `${powerLabel(channel)} is replying...`;
      renderChatTabs();
      updateButtons();
      try {
        const beforeCount = visibleMessagesForChannel(channel).length;
        gameState = await api("/api/reply", {
          method: "POST",
          body: JSON.stringify({ power: channel }),
        });
        render();
        const afterCount = visibleMessagesForChannel(channel).length;
        showToast(afterCount > beforeCount ? `${powerLabel(channel)} replied.` : `${powerLabel(channel)} did not reply.`);
      } catch (error) {
        await recover(error);
      } finally {
        pendingReplies.delete(channel);
      }
    }
  } finally {
    replyWorkerRunning = false;
    clientBusyText = "";
    render();
  }
}

async function runPress() {
  try {
    setWorking("Other players are talking...");
    gameState = await api("/api/press", {
      method: "POST",
      body: JSON.stringify({ rounds: 1 }),
    });
    render();
    showToast("Other players finished talking.");
  } catch (error) {
    await recover(error);
  }
}

async function resolvePhase() {
  if (pendingResolve) return;
  if (!allOrdersChosen()) {
    showToast(orderRequirementMessage());
    return;
  }
  try {
    pendingResolve = true;
    clientBusyText = "AI players are choosing orders...";
    render();
    const nextState = await api("/api/resolve", {
      method: "POST",
      body: JSON.stringify({ orders: selectedOrders() }),
    });
    gameState = nextState;
    historyIndex = null;
    pendingResolve = false;
    clientBusyText = "";
    render();
    showToast("Turn finished.");
  } catch (error) {
    pendingResolve = false;
    clientBusyText = "";
    await recover(error);
  }
}

function allOrdersChosen() {
  const needed = (gameState?.orderableLocations || []).length;
  if (!needed) return true;
  if (gameState?.phaseType === "M") return true;
  const required = requiredOrderCount();
  const selected = selectedOrders().length;
  if (gameState?.phaseType === "A") return selected === required;
  return selected >= required;
}

async function connectOpenRouter() {
  const model = el("openRouterModelSelect").value;
  try {
    setWorking("Connecting OpenRouter...");
    gameState = await api("/api/connect-openrouter", {
      method: "POST",
      body: JSON.stringify({ model }),
    });
    render();
    showToast("OpenRouter connected. Future replies and moves use real LLM calls.");
  } catch (error) {
    await recover(error);
  }
}

function setWorking(text) {
  el("statusText").textContent = text;
  for (const button of document.querySelectorAll("button")) {
    button.disabled = true;
  }
}

async function recover(error) {
  showToast(error.message || String(error));
  await refresh().catch(() => {});
}

function showToast(message) {
  const toast = el("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

function powerLabel(power) {
  if (!power) return "";
  return String(power)
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function flagImage(power, className) {
  const code = flagCodes[power];
  if (!code) return "";
  return `<img class="${className}" src="/assets/flags/${code}.svg" alt="" aria-hidden="true" />`;
}

function statusLabel(status) {
  const normalized = String(status || "").toLowerCase();
  if (!normalized || normalized === "ready") return "Ready";
  if (normalized.startsWith("resumed")) return "Ready";
  if (normalized.startsWith("saved")) return "Moves saved";
  if (normalized.startsWith("sent message")) return "Message sent";
  if (normalized.startsWith("completed")) return "Press done";
  if (normalized.startsWith("resolved")) return "Turn done";
  if (normalized.includes("error")) return "Needs attention";
  return powerLabel(normalized.replaceAll("_", " ")).slice(0, 42);
}

function messageHeading(message) {
  if (message.sender === "SYSTEM") return "Game";
  if (message.sender === gameState.humanPower) {
    return message.recipient === "GLOBAL" ? "You to everyone" : `You to ${powerLabel(message.recipient)}`;
  }
  if (message.recipient === "GLOBAL") return `${powerLabel(message.sender)} to everyone`;
  return powerLabel(message.sender);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

el("refreshButton").addEventListener("click", () => refresh().catch((error) => showToast(error.message)));
el("saveOrdersButton")?.addEventListener("click", saveOrders);
el("sendMessageButton").addEventListener("click", sendMessage);
el("askReplyButton").addEventListener("click", askReply);
el("runPressButton").addEventListener("click", runPress);
el("resolveButton").addEventListener("click", resolvePhase);
el("connectOpenRouterButton").addEventListener("click", connectOpenRouter);
el("zoomOutButton").addEventListener("click", () => changeZoom(-0.25));
el("zoomInButton").addEventListener("click", () => changeZoom(0.25));
el("zoomResetButton").addEventListener("click", resetZoom);
el("toggleArrowsButton").addEventListener("click", toggleArrows);
el("toggleDockButton").addEventListener("click", toggleBottomDock);
el("togglePanelButton").addEventListener("click", toggleSidePanel);
el("historyPrevButton").addEventListener("click", () => moveHistory(-1));
el("historyNextButton").addEventListener("click", () => moveHistory(1));
el("recipientSelect").addEventListener("change", (event) => {
  activeChatChannel = event.target.value;
  renderChatTabs();
  renderMessages();
  updateButtons();
});
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    syncMapOverlayFrame();
    clampMapPan();
    applyMapZoom();
    renderOrderArrows();
  }, 80);
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  cancelOrderSelection();
});

async function init() {
  await loadMapSvg();
  installMapPanHandlers();
  await refresh();
}

init().catch((error) => showToast(error.message));
setInterval(() => {
  if (!gameState || gameState.busy) {
    refresh().catch(() => {});
  }
}, 5000);
