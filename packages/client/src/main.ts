// Client bootstrap. Spins up the isometric renderer + simulation worker, builds the DOM
// UI (toolbar, HUD, RCI meter, budget, overlay selector, speed, query panel), and wires
// the message pipeline. The active tool determines what paint-dragging on the map does.

import { SpriteRenderer } from "./render/spriteRenderer.js";
import SimWorker from "./worker/simWorker.js?worker";
import type { FromWorker, ToWorker, OverlayKind, CityStatsMsg, QueryResult } from "./worker/messages.js";
import type { Command } from "@metro/sim-core";
import type { SaveFile } from "@metro/protocol";

const MAP_W = 96;
const MAP_H = 96;
const SEED = 1337;
const SAVE_KEY = "metropolis.save";

// Active map tool. Each maps to a command builder (or a special "query" mode).
type Tool =
  | { kind: "query" }
  | { kind: "bulldoze" }
  | { kind: "road" }
  | { kind: "powerline" }
  | { kind: "zone"; zone: number }
  | { kind: "build"; build: number };

const ZONE = { ResLight: 1, ResDense: 2, ComLight: 3, ComDense: 4, IndLight: 5, IndDense: 6 } as const;
const BUILD = { CoalPlant: 1, GasPlant: 2, Police: 3, Fire: 4, Park: 5 } as const;

const TOOLS: { label: string; tool: Tool; group: string }[] = [
  { label: "Query", tool: { kind: "query" }, group: "Tools" },
  { label: "Bulldoze", tool: { kind: "bulldoze" }, group: "Tools" },
  { label: "Road", tool: { kind: "road" }, group: "Transport" },
  { label: "Power Line", tool: { kind: "powerline" }, group: "Power" },
  { label: "Coal Plant", tool: { kind: "build", build: BUILD.CoalPlant }, group: "Power" },
  { label: "Gas Turbine", tool: { kind: "build", build: BUILD.GasPlant }, group: "Power" },
  { label: "R — Light", tool: { kind: "zone", zone: ZONE.ResLight }, group: "Zones" },
  { label: "R — Dense", tool: { kind: "zone", zone: ZONE.ResDense }, group: "Zones" },
  { label: "C — Light", tool: { kind: "zone", zone: ZONE.ComLight }, group: "Zones" },
  { label: "C — Dense", tool: { kind: "zone", zone: ZONE.ComDense }, group: "Zones" },
  { label: "I — Light", tool: { kind: "zone", zone: ZONE.IndLight }, group: "Zones" },
  { label: "I — Dense", tool: { kind: "zone", zone: ZONE.IndDense }, group: "Zones" },
  { label: "Police", tool: { kind: "build", build: BUILD.Police }, group: "Services" },
  { label: "Fire", tool: { kind: "build", build: BUILD.Fire }, group: "Services" },
  { label: "Park", tool: { kind: "build", build: BUILD.Park }, group: "Services" },
];

const OVERLAYS: { label: string; kind: OverlayKind }[] = [
  { label: "None", kind: "none" },
  { label: "Land Value", kind: "landvalue" },
  { label: "Pollution", kind: "pollution" },
  { label: "Crime", kind: "crime" },
  { label: "Power", kind: "power" },
  { label: "Police", kind: "police" },
  { label: "Fire", kind: "fire" },
];

const SPEEDS: { label: string; speed: number }[] = [
  { label: "⏸", speed: 0 },
  { label: "▶", speed: 1 },
  { label: "▶▶", speed: 4 },
  { label: "▶▶▶", speed: 16 },
];

let activeTool: Tool = { kind: "query" };

function toolToCommand(tool: Tool, x: number, y: number): Command | null {
  switch (tool.kind) {
    case "query":
      return null;
    case "bulldoze":
      return { kind: "bulldoze", x, y };
    case "road":
      return { kind: "road", x, y };
    case "powerline":
      return { kind: "powerline", x, y };
    case "zone":
      return { kind: "zone", x, y, zone: tool.zone };
    case "build":
      return { kind: "placeBuilding", x, y, build: tool.build };
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

async function main(): Promise<void> {
  const renderer = new SpriteRenderer();
  await renderer.init(document.getElementById("app")!);

  const worker = new SimWorker();
  const send = (msg: ToWorker, transfer?: Transferable[]): void => worker.postMessage(msg, transfer ?? []);

  // --- UI scaffolding ---
  const ui = document.getElementById("ui")!;

  // Top HUD bar
  const hudDate = el("span");
  const hudFunds = el("span");
  const hudPop = el("span");
  const hudJobs = el("span");
  const hudPower = el("span");
  const topbar = el("div", { className: "topbar" }, [hudDate, hudFunds, hudPop, hudJobs, hudPower]);

  // Speed controls live in the top bar.
  const speedBox = el("div", { className: "speeds" });
  const speedBtns: HTMLButtonElement[] = [];
  SPEEDS.forEach((s, i) => {
    const b = el("button", { textContent: s.label, title: `speed ${s.speed}` });
    b.onclick = () => {
      send({ type: "setSpeed", speed: s.speed });
      speedBtns.forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
    };
    if (i === 2) b.classList.add("on"); // Medium default
    speedBtns.push(b);
    speedBox.append(b);
  });
  topbar.append(speedBox);

  // Toolbar (grouped)
  const toolbar = el("div", { className: "toolbar" });
  const toolBtns = new Map<HTMLButtonElement, Tool>();
  let curGroup = "";
  for (const t of TOOLS) {
    if (t.group !== curGroup) {
      curGroup = t.group;
      toolbar.append(el("div", { className: "group-label", textContent: t.group }));
    }
    const b = el("button", { textContent: t.label });
    b.onclick = () => {
      activeTool = t.tool;
      toolBtns.forEach((_, btn) => btn.classList.remove("on"));
      b.classList.add("on");
    };
    if (t.tool.kind === "query") b.classList.add("on");
    toolBtns.set(b, t.tool);
    toolbar.append(b);
  }

  // Save / load
  const saveBtn = el("button", { textContent: "Save" });
  const loadBtn = el("button", { textContent: "Load" });
  saveBtn.onclick = () => send({ type: "save" });
  loadBtn.onclick = () => {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return alert("No saved city found.");
    try {
      send({ type: "load", save: JSON.parse(raw) as SaveFile });
    } catch {
      alert("Saved city is corrupt.");
    }
  };
  toolbar.append(el("div", { className: "group-label", textContent: "City" }), saveBtn, loadBtn);

  // Overlay selector
  const overlayBox = el("div", { className: "overlays" });
  const overlayBtns: HTMLButtonElement[] = [];
  OVERLAYS.forEach((o, i) => {
    const b = el("button", { textContent: o.label });
    b.onclick = () => {
      send({ type: "setOverlay", overlay: o.kind });
      overlayBtns.forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
    };
    if (i === 0) b.classList.add("on");
    overlayBtns.push(b);
    overlayBox.append(b);
  });

  // RCI demand meter
  const rciR = el("div", { className: "rci-bar r" });
  const rciC = el("div", { className: "rci-bar c" });
  const rciI = el("div", { className: "rci-bar i" });
  const rciBox = el("div", { className: "rci" }, [
    el("div", { className: "rci-col" }, [rciR, el("span", { textContent: "R" })]),
    el("div", { className: "rci-col" }, [rciC, el("span", { textContent: "C" })]),
    el("div", { className: "rci-col" }, [rciI, el("span", { textContent: "I" })]),
  ]);

  // Budget panel (tax + funding sliders)
  const budgetBody = el("div", { className: "budget-body" });
  const budgetPanel = el("div", { className: "panel budget" }, [
    el("div", { className: "panel-title", textContent: "Budget" }),
    budgetBody,
  ]);

  function slider(
    label: string,
    min: number,
    max: number,
    value: number,
    onInput: (v: number) => void,
  ): HTMLElement {
    const out = el("span", { className: "slider-val", textContent: String(value) });
    const input = el("input", { type: "range", min: String(min), max: String(max), value: String(value) });
    input.oninput = () => {
      const v = Number(input.value);
      out.textContent = String(v);
      onInput(v);
    };
    return el("label", { className: "slider" }, [el("span", { textContent: label }), input, out]);
  }

  const income = el("span", { textContent: "$0" });
  const expense = el("span", { textContent: "$0" });
  budgetBody.append(
    slider("Tax R %", 0, 20, 7, (v) => send({ type: "command", cmd: { kind: "setTax", cat: "R", rate: v } })),
    slider("Tax C %", 0, 20, 7, (v) => send({ type: "command", cmd: { kind: "setTax", cat: "C", rate: v } })),
    slider("Tax I %", 0, 20, 7, (v) => send({ type: "command", cmd: { kind: "setTax", cat: "I", rate: v } })),
    slider("Police %", 0, 100, 100, (v) =>
      send({ type: "command", cmd: { kind: "setFunding", service: "police", level: v } }),
    ),
    slider("Fire %", 0, 100, 100, (v) =>
      send({ type: "command", cmd: { kind: "setFunding", service: "fire", level: v } }),
    ),
    el("div", { className: "budget-row" }, [el("span", { textContent: "Income/mo" }), income]),
    el("div", { className: "budget-row" }, [el("span", { textContent: "Expense/mo" }), expense]),
  );

  // Query panel
  const queryBody = el("div", { className: "query-body", textContent: "Click a tile with the Query tool." });
  const queryPanel = el("div", { className: "panel query" }, [
    el("div", { className: "panel-title", textContent: "Query" }),
    queryBody,
  ]);

  const sidebar = el("div", { className: "sidebar" }, [
    el("div", { className: "panel-title", textContent: "Overlays" }),
    overlayBox,
    rciBox,
    budgetPanel,
    queryPanel,
  ]);

  ui.append(topbar, toolbar, sidebar);

  // --- message pipeline ---
  worker.onmessage = (ev: MessageEvent<FromWorker>) => {
    const msg = ev.data;
    if (msg.type === "snapshot") {
      renderer.setSnapshot(msg.width, msg.height, msg.terrain, msg.altitude);
    } else if (msg.type === "tick") {
      renderer.update(msg.zone, msg.stage, msg.net, msg.building, msg.power, msg.overlay, msg.overlayField);
      updateStats(msg.stats);
    } else if (msg.type === "queryResult") {
      showQuery(msg.result);
    } else if (msg.type === "saved") {
      localStorage.setItem(SAVE_KEY, JSON.stringify(msg.save));
      flash(saveBtn, "Saved!");
    }
  };

  function updateStats(s: CityStatsMsg): void {
    hudDate.textContent = `📅 ${String(s.month).padStart(2, "0")}/${s.year}`;
    hudFunds.textContent = `💰 $${s.funds.toLocaleString()}`;
    hudPop.textContent = `👥 ${s.population.toLocaleString()}`;
    hudJobs.textContent = `🏢 ${s.jobs.toLocaleString()}`;
    hudPower.textContent = s.brownout
      ? `⚡ ${s.powerSupply}/${s.powerDemand} ⚠`
      : `⚡ ${s.powerSupply}/${s.powerDemand}`;
    hudPower.className = s.brownout ? "warn" : "";
    income.textContent = `$${s.lastIncome.toLocaleString()}`;
    expense.textContent = `$${s.lastExpense.toLocaleString()}`;
    rciR.style.height = `${demandPx(s.rDemand)}px`;
    rciC.style.height = `${demandPx(s.cDemand)}px`;
    rciI.style.height = `${demandPx(s.iDemand)}px`;
  }

  function showQuery(r: QueryResult): void {
    const ZN = ["None", "R-light", "R-dense", "C-light", "C-dense", "I-light", "I-dense"];
    queryBody.innerHTML =
      `<b>(${r.x}, ${r.y})</b><br>` +
      `zone: ${ZN[r.zone] ?? r.zone} &middot; stage ${r.stage}<br>` +
      `powered: ${r.powered ? "yes" : "no"}<br>` +
      `land value: ${r.landValue} &middot; pollution: ${r.pollution}<br>` +
      `crime: ${r.crime} &middot; police: ${r.policeCov} &middot; fire: ${r.fireCov}`;
  }

  renderer.onPaintTile = (x, y) => {
    if (activeTool.kind === "query") {
      send({ type: "query", x, y });
      return;
    }
    const cmd = toolToCommand(activeTool, x, y);
    if (cmd) send({ type: "command", cmd });
  };

  send({ type: "init", width: MAP_W, height: MAP_H, seed: SEED });
}

function demandPx(d: number): number {
  // d is -1..1; map to a 0..60px bar (centered visual not needed, just magnitude of demand).
  return Math.round(Math.max(0, d) * 60);
}

function flash(btn: HTMLButtonElement, text: string): void {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 900);
}

void main();
