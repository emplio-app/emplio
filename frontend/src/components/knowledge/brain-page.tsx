"use client";

import type { BrainGraph } from "@emplio/shared";
import { useQuery } from "@tanstack/react-query";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from "d3-force";
import {
  BriefcaseBusinessIcon,
  Building2Icon,
  CalendarDaysIcon,
  CogIcon,
  ContactRoundIcon,
  FileTextIcon,
  FolderKanbanIcon,
  LightbulbIcon,
  MaximizeIcon,
  MinusIcon,
  NotebookPenIcon,
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  UserRoundIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { AskFloat, useAskOpen } from "@/components/chat/composer";
import { useTeam } from "@/components/clients/clients-page";
import { MemoryTabs } from "@/components/knowledge/memory-tabs";
import { thingHref } from "@/components/things/things";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, useClients, useContacts, useProjects, useServices } from "@/lib/api";

// The Brain: everything the business knows as one map. Each dot is a note, or a client, contact, project, service or
// teammate; a line is a [[link]] in a note or a link between records (a project's client, a client's handlers…).
// Drawn on one canvas with a force layout, so a few thousand dots stay smooth; the layout is kept for the session.

// --- the map's contents ---

// each kind: its icon, and its colour as hue and strength (lightness follows the theme, colourOf)
const GROUPS = {
  clients: { label: "Clients", icon: Building2Icon, hue: 160, chroma: 0.12 },
  projects: { label: "Projects", icon: FolderKanbanIcon, hue: 65, chroma: 0.13 },
  contacts: { label: "Contacts", icon: ContactRoundIcon, hue: 250, chroma: 0.11 },
  team: { label: "Team", icon: UserRoundIcon, hue: 295, chroma: 0.11 },
  services: { label: "Services", icon: BriefcaseBusinessIcon, hue: 195, chroma: 0.09 },
  meetings: { label: "Meetings", icon: CalendarDaysIcon, hue: 15, chroma: 0.12 },
  knowledge: { label: "Knowledge", icon: LightbulbIcon, hue: 95, chroma: 0.1 },
  processes: { label: "Processes", icon: WorkflowIcon, hue: 225, chroma: 0.07 },
  mine: { label: "Your notes", icon: NotebookPenIcon, hue: 330, chroma: 0.08 },
  notes: { label: "Other notes", icon: FileTextIcon, hue: 260, chroma: 0.02 },
  system: { label: "Emplio's own files", icon: CogIcon, hue: 260, chroma: 0.01 },
} as const;
type Group = keyof typeof GROUPS;
const colourOf = (g: Group, dark: boolean, alpha = 1) =>
  `oklch(${dark ? (g === "system" ? 0.6 : 0.76) : g === "system" ? 0.6 : 0.55} ${GROUPS[g].chroma} ${GROUPS[g].hue} / ${alpha})`;
const RECORDS = new Set(["clients", "contacts", "team", "services", "projects"]);
// Emplio's working files: hidden until asked for, they'd crowd out the business
const SYSTEM = new Set(["agents", "skillset", "toolset", "journal", "automations", "AGENT.md", "heartbeat.md", "journal.md", "README.md", "profile.md", "preferences.md"]);
const REPO_LABEL = (repo: string) => (repo === "company" ? "Company" : repo === "restricted" ? "Restricted" : "Yours");

type Node = SimulationNodeDatum & {
  id: string;
  i: number;
  label: string;
  lower: string;
  group: Group;
  note?: { repo: string; path: string };
  record?: string;
  // linked to, but not written yet (or not one you can see)
  ghost: boolean;
  nb: number[];
  r: number;
};
type Edge = { source: Node; target: Node };
type Graph = { nodes: Node[]; edges: Edge[] };

const pretty = (s: string) => s.replace(/\.md$/, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const agentPath = (n: { repo: string; path: string }) => `${n.repo.startsWith("me-") ? "me" : n.repo}/${n.path}`;
function groupOf(repo: string, path: string): Group {
  const top = path.split("/")[0]!;
  if (SYSTEM.has(top)) return "system";
  if (repo.startsWith("me-")) return "mine";
  if (path.includes("/") && top in GROUPS) return top as Group;
  return "notes";
}

function useGraph() {
  const graph = useQuery({ queryKey: ["knowledge", "graph"], queryFn: () => api<BrainGraph>("/knowledge/graph") });
  // the same lists (and cache) the rest of the app uses; private ones are already left out for staff
  const clients = useClients().data;
  const contacts = useContacts().data;
  const projects = useProjects({ all: true }).data;
  const services = useServices().data;
  const team = useTeam().data;
  const data = useMemo((): Graph | null => {
    if (!graph.data) return null;
    const byId = new Map<string, Node>();
    const put = (id: string, label: string, group: Group, more: Partial<Node> = {}) => {
      const n = byId.get(id) ?? { id, i: byId.size, label, lower: "", group, ghost: false, nb: [], r: 0 };
      Object.assign(n, more);
      byId.set(id, n);
      return n;
    };
    const person = new Map((team ?? []).map((m) => [m.id, m.slug ? `team/${m.slug}` : `team/@${m.id}`]));
    for (const m of team ?? []) put(person.get(m.id)!, m.name ?? m.email, "team", { record: m.slug ? person.get(m.id) : undefined });
    for (const c of clients ?? []) put(`clients/${c.slug}`, c.name, "clients", { record: `clients/${c.slug}` });
    for (const c of contacts ?? []) put(`contacts/${c.slug}`, c.name, "contacts", { record: `contacts/${c.slug}` });
    for (const p of projects ?? []) put(`projects/${p.slug}`, p.name, "projects", { record: `projects/${p.slug}` });
    for (const s of services ?? []) put(`services/${s.slug}`, s.name, "services", { record: `services/${s.slug}` });
    for (const n of graph.data.nodes) {
      const own = byId.get(n.id);
      const title = n.title && !/^me-[0-9a-f-]{36}$/.test(n.title) ? n.title : null;
      if (own) own.note = { repo: n.repo, path: n.path };
      else {
        const kind = n.id.split("/")[0]!;
        // a record's page whose record isn't in the lists (archived, or gone): still its record's dot
        if (RECORDS.has(kind) && !n.id.endsWith(".md")) put(n.id, title ?? pretty(n.id.split("/")[1]!), kind as Group, { note: n, record: n.id });
        else put(n.id, title ?? pretty(n.path.replace(/\/index\.md$/, "").split("/").pop()!), groupOf(n.repo, n.path), { note: n });
      }
    }
    const seen = new Set<string>();
    const edges: Edge[] = [];
    const join = (a: string, b: string) => {
      if (a === b) return;
      const key = a < b ? a + " " + b : b + " " + a;
      if (seen.has(key)) return;
      seen.add(key);
      const end = (id: string) => {
        const kind = id.split("/")[0]!;
        return byId.get(id) ?? put(id, pretty((RECORDS.has(kind) ? id.split("/")[1] : id.split("/").pop()) ?? id), RECORDS.has(kind) ? (kind as Group) : groupOf(id.split("/")[0]!, id.split("/").slice(1).join("/")), { ghost: true });
      };
      edges.push({ source: end(a), target: end(b) });
    };
    for (const [a, b] of graph.data.edges) join(a, b);
    for (const c of clients ?? []) for (const h of c.handlers) if (person.has(h.id)) join(`clients/${c.slug}`, person.get(h.id)!);
    for (const c of contacts ?? []) for (const at of c.clients) join(`contacts/${c.slug}`, `clients/${at.slug}`);
    for (const p of projects ?? []) {
      join(`projects/${p.slug}`, `clients/${p.client.slug}`);
      if (p.service) join(`projects/${p.slug}`, `services/${p.service.slug}`);
      if (p.lead && person.has(p.lead.id)) join(`projects/${p.slug}`, person.get(p.lead.id)!);
    }
    for (const m of team ?? []) if (m.reportsTo && person.has(m.reportsTo)) join(person.get(m.id)!, person.get(m.reportsTo)!);
    const nodes = [...byId.values()];
    for (const e of edges) (e.source.nb.push(e.target.i), e.target.nb.push(e.source.i));
    for (const n of nodes) {
      n.lower = n.label.toLowerCase();
      n.r = Math.min(10 + Math.sqrt(n.nb.length) * 2.6, 26);
    }
    return { nodes, edges };
  }, [graph.data, clients, contacts, projects, services, team]);
  return { data, error: graph.error, pending: graph.isPending };
}

// --- the drawing ---

type View = { k: number; x: number; y: number };
// kept for the session: coming back to the tab shows the map as it was, with no settling again
const placed = new Map<string, { x: number; y: number }>();
let lastView: View | null = null;
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

class Brain {
  nodes: Node[] = [];
  edges: Edge[] = [];
  all: Node[] = [];
  // set once per setData, not per frame: the dots by kind, and biggest first for names
  byGroup = new Map<Group, Node[]>();
  bySize: Node[] = [];
  sim: Simulation<Node, undefined> | null = null;
  view: View = lastView ?? { k: 1, x: 0, y: 0 };
  w = 0;
  h = 0;
  dpr = 1;
  hover: Node | null = null;
  sel: Node | null = null;
  match: Set<number> | null = null;
  colors = { dark: true, bg: "", fg: "", muted: "", lit: "", font: "" };
  // each kind's icon as a picture in its colour, drawn inside its dots
  icons = {} as Partial<Record<Group, HTMLCanvasElement>>;
  // someone moved or zoomed the map: don't jump it to fit any more
  touched = false;
  fitted = !!lastView;
  private ctx: CanvasRenderingContext2D;
  private frame = 0;
  private tween = 0;
  private off: (() => void)[] = [];
  constructor(
    private canvas: HTMLCanvasElement,
    private on: { pick: (n: Node | null) => void; open: (n: Node) => void },
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.touched = !!lastView;
    this.readColors();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement!);
    const mo = new MutationObserver(() => (this.readColors(), this.draw()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    this.off.push(() => ro.disconnect(), () => mo.disconnect());
    this.listen();
    this.resize();
  }

  readColors() {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const dark = document.documentElement.classList.contains("dark");
    this.colors = { dark, bg: v("--background"), fg: v("--foreground"), muted: v("--muted-foreground"), lit: v("--primary"), font: getComputedStyle(document.body).fontFamily };
    // the hidden icons the page renders (BrainPage), as pictures in this theme's colours
    for (const svg of document.querySelectorAll<SVGElement>("[data-brain-icon]")) {
      const g = svg.dataset.brainIcon as Group;
      const img = new Image();
      // drawn once onto a small canvas: copying pixels each frame is cheap, redrawing an SVG thousands of times isn't
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = 64;
        c.getContext("2d")!.drawImage(img, 0, 0, 64, 64);
        this.icons[g] = c;
        this.draw();
      };
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg.outerHTML.replaceAll("currentColor", colourOf(g, dark)).replace('width="24" height="24"', 'width="64" height="64"'));
    }
  }

  resize() {
    const box = this.canvas.parentElement!.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = box.width;
    this.h = box.height;
    this.canvas.width = Math.round(box.width * this.dpr);
    this.canvas.height = Math.round(box.height * this.dpr);
    if (!this.fitted && lastView === null && this.view.x === 0) this.view = { k: 1, x: this.w / 2, y: this.h / 2 };
    this.draw();
  }

  // the dots to show: kept objects keep their places; new ones start beside a placed neighbour
  setData(all: Node[], nodes: Node[], edges: Edge[]) {
    this.all = all;
    this.sim?.stop();
    let fresh = 0;
    for (const n of nodes) {
      const p = placed.get(n.id);
      if (p) ((n.x = p.x), (n.y = p.y));
      else if (n.x === undefined) {
        fresh++;
        const near = n.nb.map((i) => all[i]!).find((m) => placed.has(m.id));
        if (near) {
          const q = placed.get(near.id)!;
          n.x = q.x + (Math.random() - 0.5) * 40;
          n.y = q.y + (Math.random() - 0.5) * 40;
        }
      }
    }
    this.nodes = nodes;
    this.edges = edges;
    this.byGroup = new Map();
    for (const n of nodes) this.byGroup.set(n.group, [...(this.byGroup.get(n.group) ?? []), n]);
    this.bySize = [...nodes].sort((a, b) => b.r - a.r);
    const big = nodes.length > 1500;
    const sim = forceSimulation<Node>(nodes)
      .force("link", forceLink<Node, Edge>(edges).distance((e) => 40 + e.source.r + e.target.r))
      .force("charge", forceManyBody<Node>().strength(big ? -45 : -110).theta(0.9).distanceMax(600))
      // loose ones (no links) pulled in harder, so they ring the rest instead of drifting off
      .force("x", forceX<Node>(0).strength((d) => (d.nb.length ? 0.04 : 0.11)))
      .force("y", forceY<Node>(0).strength((d) => (d.nb.length ? 0.04 : 0.11)))
      .force("collide", forceCollide<Node>((d) => d.r + 6))
      .alphaDecay(0.03)
      .velocityDecay(0.38)
      .stop();
    // mostly placed already: a gentle nudge; mostly new: settle a while before the first frame, the rest animates
    const settled = fresh < nodes.length * 0.2;
    sim.alpha(settled ? 0.15 : 1);
    if (reduced()) sim.tick(300);
    else if (!settled) sim.tick(Math.min(80, Math.round(40000 / Math.max(nodes.length, 1))));
    sim.on("tick", () => this.draw()).on("end", () => this.keep());
    if (!reduced()) sim.restart();
    this.sim = sim;
    if (!this.fitted) this.fit(false);
    this.draw();
  }

  keep() {
    for (const n of this.nodes) if (n.x !== undefined) placed.set(n.id, { x: n.x, y: n.y! });
    // the first layout grew while settling: frame it again, unless someone's already moving around
    if (!this.touched) this.fit(true);
  }

  // --- view ---

  bounds(list = this.nodes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of list) {
      x0 = Math.min(x0, n.x! - n.r);
      y0 = Math.min(y0, n.y! - n.r);
      x1 = Math.max(x1, n.x! + n.r);
      y1 = Math.max(y1, n.y! + n.r);
    }
    return { x0, y0, x1, y1 };
  }
  fit(animate = true, list = this.nodes) {
    if (!list.length || !this.w) return;
    this.fitted = true;
    const b = this.bounds(list);
    // room for the toolbar above and Emplio's box below
    const top = 64, bottom = 120, side = 32;
    const k = Math.max(0.08, Math.min(2, (this.w - side * 2) / (b.x1 - b.x0 || 1), (this.h - top - bottom) / (b.y1 - b.y0 || 1)));
    this.go({ k, x: this.w / 2 - ((b.x0 + b.x1) / 2) * k, y: top + (this.h - top - bottom) / 2 - ((b.y0 + b.y1) / 2) * k }, animate);
  }
  focusOn(n: Node) {
    const k = Math.max(this.view.k, 1.4);
    this.go({ k, x: this.w / 2 - n.x! * k, y: this.h / 2.4 - n.y! * k }, true);
  }
  zoom(f: number, cx = this.w / 2, cy = this.h / 2, animate = false) {
    const k = Math.max(0.05, Math.min(8, this.view.k * f));
    const r = k / this.view.k;
    this.go({ k, x: cx - (cx - this.view.x) * r, y: cy - (cy - this.view.y) * r }, animate);
  }
  go(to: View, animate: boolean) {
    cancelAnimationFrame(this.tween);
    if (!animate || reduced()) return this.set(to);
    const from = { ...this.view };
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 420);
      const e = 1 - (1 - p) ** 3;
      this.set({ k: from.k + (to.k - from.k) * e, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
      if (p < 1) this.tween = requestAnimationFrame(step);
    };
    this.tween = requestAnimationFrame(step);
  }
  set(v: View) {
    this.view = v;
    lastView = v;
    // the dotted paper moves and scales with the map (CSS, BrainPage)
    const s = this.canvas.parentElement!.style;
    const step = 28 * v.k * (v.k < 0.5 ? 4 : v.k < 1 ? 2 : 1);
    s.backgroundSize = `${step}px ${step}px`;
    s.backgroundPosition = `${v.x}px ${v.y}px`;
    this.draw();
  }

  // --- pointer ---

  at(sx: number, sy: number) {
    const { k, x, y } = this.view;
    const wx = (sx - x) / k, wy = (sy - y) / k;
    let best: Node | null = null;
    let bd = Infinity;
    for (const n of this.nodes) {
      const d = (n.x! - wx) ** 2 + (n.y! - wy) ** 2;
      const reach = n.r + 6 / k;
      if (d < reach * reach && d < bd) ((best = n), (bd = d));
    }
    return best;
  }
  listen() {
    const c = this.canvas;
    const pts = new Map<number, { x: number; y: number }>();
    let drag: Node | null = null;
    let moved = 0;
    let pinch = 0;
    const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const b = c.getBoundingClientRect();
      return { x: e.clientX - b.left, y: e.clientY - b.top };
    };
    const down = (e: PointerEvent) => {
      this.touched = true;
      c.setPointerCapture(e.pointerId);
      cancelAnimationFrame(this.tween);
      pts.set(e.pointerId, local(e));
      moved = 0;
      if (pts.size === 1) {
        const p = local(e);
        drag = this.at(p.x, p.y);
        if (drag) ((drag.fx = drag.x), (drag.fy = drag.y));
      } else if (drag) ((drag.fx = drag.fy = null), (drag = null));
    };
    const move = (e: PointerEvent) => {
      const p = local(e);
      if (!pts.has(e.pointerId)) {
        const h = this.at(p.x, p.y);
        if (h !== this.hover) ((this.hover = h), (c.style.cursor = h ? "pointer" : "grab"), this.draw());
        return;
      }
      const last = pts.get(e.pointerId)!;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const before = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        pts.set(e.pointerId, p);
        const [a2, b2] = [...pts.values()];
        const after = Math.hypot(a2!.x - b2!.x, a2!.y - b2!.y);
        const mid = { x: (a2!.x + b2!.x) / 2, y: (a2!.y + b2!.y) / 2 };
        if (before > 0) this.zoom(after / before, mid.x, mid.y);
        pinch = 1;
        return;
      }
      pts.set(e.pointerId, p);
      moved += Math.abs(p.x - last.x) + Math.abs(p.y - last.y);
      if (drag) {
        if (moved < 3) return;
        drag.fx = (p.x - this.view.x) / this.view.k;
        drag.fy = (p.y - this.view.y) / this.view.k;
        this.sim?.alphaTarget(0.25).restart();
      } else {
        c.style.cursor = "grabbing";
        this.set({ ...this.view, x: this.view.x + p.x - last.x, y: this.view.y + p.y - last.y });
      }
    };
    const up = (e: PointerEvent) => {
      const was = pts.size;
      pts.delete(e.pointerId);
      if (was > 1 || pinch) {
        if (!pts.size) pinch = 0;
        return;
      }
      if (drag) {
        drag.fx = drag.fy = null;
        this.sim?.alphaTarget(0);
      }
      if (moved < 5) this.on.pick(drag ?? null);
      drag = null;
      c.style.cursor = this.hover ? "pointer" : "grab";
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.touched = true;
      cancelAnimationFrame(this.tween);
      const p = local(e);
      // a trackpad pinch comes as a wheel with ctrl held; two fingers on a trackpad (small, smooth steps) move the map;
      // a mouse wheel (big notches) zooms. ponytail: guessed from step size, as browsers don't say which it is
      if (e.ctrlKey) this.zoom(Math.exp(-e.deltaY * 0.012), p.x, p.y);
      else if (e.deltaMode === 0 && (Math.abs(e.deltaY) < 40 || e.deltaX !== 0)) this.set({ ...this.view, x: this.view.x - e.deltaX, y: this.view.y - e.deltaY });
      else this.zoom(Math.exp(-e.deltaY * 0.0018), p.x, p.y);
    };
    const dbl = (e: MouseEvent) => {
      const p = local(e);
      const n = this.at(p.x, p.y);
      if (n) this.on.open(n);
      else this.zoom(1.8, p.x, p.y, true);
    };
    const leave = () => {
      if (this.hover) ((this.hover = null), this.draw());
    };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("pointerleave", leave);
    c.addEventListener("wheel", wheel, { passive: false });
    c.addEventListener("dblclick", dbl);
    this.off.push(() => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      c.removeEventListener("pointercancel", up);
      c.removeEventListener("pointerleave", leave);
      c.removeEventListener("wheel", wheel);
      c.removeEventListener("dblclick", dbl);
    });
  }

  // --- paint: one frame per change, nothing while still ---

  draw() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.paint());
  }
  private paint() {
    this.frame = 0;
    const { ctx, w, h, dpr, colors } = this;
    const { k, x, y } = this.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.nodes.length) return;
    // what's on screen, in the map's own units, with a margin so lines into the edge still show
    const m = 40 / k;
    const x0 = -x / k - m, y0 = -y / k - m, x1 = (w - x) / k + m, y1 = (h - y) / k + m;
    const inView = (n: Node) => n.x! > x0 && n.x! < x1 && n.y! > y0 && n.y! < y1;
    const focus = this.hover ?? this.sel;
    const lit = focus ? new Set([focus.i, ...focus.nb]) : this.match;
    const dark = colors.dark;

    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
    ctx.lineCap = "round";
    // lines: every one in one stroke, then the focused dot's on top
    ctx.lineWidth = 1.2 / k;
    ctx.strokeStyle = colors.muted;
    ctx.globalAlpha = lit ? 0.07 : dark ? 0.32 : 0.4;
    ctx.beginPath();
    for (const e of this.edges) {
      if (!inView(e.source) && !inView(e.target)) continue;
      ctx.moveTo(e.source.x!, e.source.y!);
      ctx.lineTo(e.target.x!, e.target.y!);
    }
    ctx.stroke();
    if (focus) {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = colourOf(focus.group, dark);
      ctx.lineWidth = 2 / k;
      ctx.beginPath();
      for (const e of this.edges)
        if (e.source === focus || e.target === focus) {
          ctx.moveTo(e.source.x!, e.source.y!);
          ctx.lineTo(e.target.x!, e.target.y!);
        }
      ctx.stroke();
    }

    // dots: a tinted disc with a ring and the kind's icon; far out, plain dots. One path per kind, faded ones first
    const circles = (list: Node[], grow = 0) => {
      ctx.beginPath();
      for (const n of list) {
        ctx.moveTo(n.x! + n.r + grow, n.y!);
        ctx.arc(n.x!, n.y!, n.r + grow, 0, Math.PI * 2);
      }
    };
    const disc = (list: Node[]) => {
      const p = new Path2D();
      for (const n of list) {
        p.moveTo(n.x! + n.r, n.y!);
        p.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
      }
      return p;
    };
    if (focus) {
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = colourOf(focus.group, dark);
      circles([focus], 7 / k);
      ctx.fill();
    }
    for (const pass of lit ? [false, true] : [true]) {
      const fade = pass ? 1 : 0.16;
      for (const g of Object.keys(GROUPS) as Group[]) {
        const list = (this.byGroup.get(g) ?? []).filter((n) => inView(n) && (!lit || lit.has(n.i) === pass));
        if (!list.length) continue;
        // far out (a dot a few pixels wide): one plain fill, which is most of the cost saved on big maps
        if (list.every((n) => n.r * k < 8)) {
          ctx.globalAlpha = fade * 0.9;
          ctx.fillStyle = colourOf(g, dark);
          ctx.fill(disc(list));
          continue;
        }
        const real = list.filter((n) => !n.ghost);
        const ghosts = list.filter((n) => n.ghost);
        // under the tint: the page's own colour, so lines don't show through
        const all = disc(list);
        const solid = ghosts.length ? disc(real) : all;
        ctx.globalAlpha = fade;
        ctx.fillStyle = colors.bg;
        ctx.fill(all);
        ctx.fillStyle = colourOf(g, dark, dark ? 0.2 : 0.14);
        ctx.fill(solid);
        ctx.lineWidth = 1.5 / k;
        ctx.strokeStyle = colourOf(g, dark, 0.9);
        ctx.stroke(solid);
        if (ghosts.length) {
          ctx.setLineDash([3 / k, 3 / k]);
          ctx.strokeStyle = colourOf(g, dark, 0.6);
          circles(ghosts);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        const icon = this.icons[g];
        if (icon) {
          ctx.globalAlpha = fade * (list === ghosts ? 0.5 : 1);
          for (const n of list) {
            if (n.r * k < 7) continue;
            const s = n.r * 1.05;
            ctx.globalAlpha = fade * (n.ghost ? 0.5 : 1);
            ctx.drawImage(icon, n.x! - s / 2, n.y! - s / 2, s, s);
          }
        }
      }
    }
    if (this.sel) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = colors.fg;
      ctx.lineWidth = 2 / k;
      circles([this.sel], 4 / k);
      ctx.stroke();
    }

    // names, in screen pixels so they stay sharp: big dots first as you zoom in, always for what's in focus;
    // one never written over another
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // what's taken, in 48px cells so a check looks at its neighbours only; dots count, so a name never covers one
    type Box = [number, number, number, number];
    const cells = new Map<number, { b: Box; dot: boolean }[]>();
    const keys = (b: Box) => {
      const out: number[] = [];
      for (let cx = Math.floor(b[0] / 48); cx <= Math.floor(b[2] / 48); cx++) for (let cy = Math.floor(b[1] / 48); cy <= Math.floor(b[3] / 48); cy++) out.push(cx * 100003 + cy);
      return out;
    };
    const take = (b: Box, dot: boolean) => keys(b).forEach((c) => cells.set(c, [...(cells.get(c) ?? []), { b, dot }]));
    const free = (a: Box, overDots: boolean) =>
      !keys(a).some((c) => cells.get(c)?.some(({ b, dot }) => !(overDots && dot) && a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]));
    const seen = this.bySize.filter(inView);
    for (const n of seen) {
      const sx = n.x! * k + x, sy = n.y! * k + y, r = n.r * k;
      if (r > 3) take([sx - r, sy - r, sx + r, sy + r], true);
    }
    let names = 0;
    // what's in focus first, then the biggest
    const order = lit ? [...seen.filter((n) => n === focus), ...seen.filter((n) => n !== focus && lit.has(n.i)), ...seen.filter((n) => !lit.has(n.i))] : seen;
    for (const n of order) {
      const on = !!lit?.has(n.i);
      const a = on ? 1 : lit ? 0 : Math.min(1, (n.r * k - 9) / 6);
      if (a <= 0.02) continue;
      if (names > 300) break;
      const text = n.label.length > 30 ? n.label.slice(0, 29) + "…" : n.label;
      ctx.font = `${n === focus ? 600 : 500} ${n === focus ? 13 : 12}px ${colors.font}`;
      const tw = ctx.measureText(text).width;
      const sx = n.x! * k + x, sy = (n.y! + n.r) * k + y + 6;
      const box: [number, number, number, number] = [sx - tw / 2 - 4, sy - 2, sx + tw / 2 + 4, sy + 16];
      if (!free(box, on)) continue;
      take(box, false);
      names++;
      ctx.globalAlpha = a;
      ctx.fillStyle = colors.bg;
      ctx.globalAlpha = a * 0.75;
      ctx.beginPath();
      ctx.roundRect(box[0], box[1], box[2] - box[0], box[3] - box[1], 5);
      ctx.fill();
      ctx.globalAlpha = a;
      ctx.fillStyle = n === focus || on ? colors.fg : colors.muted;
      ctx.fillText(text, sx, sy);
    }
    ctx.globalAlpha = 1;
  }

  destroy() {
    this.keep();
    this.sim?.stop();
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.tween);
    this.off.forEach((f) => f());
  }
}

// --- the page ---

const HIDDEN_KEY = "brain-hidden";

export function BrainPage() {
  const router = useRouter();
  const { data, error, pending } = useGraph();
  const canvas = useRef<HTMLCanvasElement>(null);
  const brain = useRef<Brain | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<Group>>(() => new Set(["system"]));
  const [orphans, setOrphans] = useState(true);
  const [local, setLocal] = useState(false);
  const [q, setQ] = useState("");
  const words = useDeferredValue(q.trim().toLowerCase());

  useEffect(() => {
    const saved = localStorage.getItem(HIDDEN_KEY);
    if (saved) setHidden(new Set(JSON.parse(saved) as Group[]));
  }, []);
  const toggle = (g: Group, on: boolean) => {
    const next = new Set(hidden);
    if (on) next.delete(g);
    else next.add(g);
    setHidden(next);
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
  };

  const sel = (selId && data?.nodes.find((n) => n.id === selId)) || null;
  const open = (n: Node) => {
    if (n.note) router.push(`/knowledge?file=${encodeURIComponent(agentPath(n.note))}`);
    else if (n.record && thingHref(n.record)) router.push(thingHref(n.record)!);
  };
  const openRef = useRef(open);
  openRef.current = open;

  // what's drawn: the groups asked for, loose dots if wanted, or just the picked one and its links
  const shown = useMemo(() => {
    if (!data) return null;
    const near = local && sel ? new Set([sel.i, ...sel.nb]) : null;
    const nodes = data.nodes.filter((n) => (near ? near.has(n.i) : !hidden.has(n.group) && (orphans || n.nb.length > 0)));
    const keep = new Set(nodes);
    return { nodes, edges: data.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
  }, [data, hidden, orphans, local, sel]);

  useEffect(() => {
    const b = new Brain(canvas.current!, { pick: (n) => setSelId(n?.id ?? null), open: (n) => openRef.current(n) });
    brain.current = b;
    return () => b.destroy();
  }, []);
  useEffect(() => {
    if (data && shown) brain.current?.setData(data.nodes, shown.nodes, shown.edges);
  }, [data, shown]);
  useEffect(() => {
    if (!brain.current) return;
    brain.current.sel = sel;
    brain.current.draw();
  }, [sel]);
  // just this and its links: frame them
  useEffect(() => {
    if (local && shown) setTimeout(() => brain.current?.fit(true, shown.nodes), 350);
  }, [local, shown]);

  const hits = useMemo(() => {
    if (!words || !shown) return [];
    return shown.nodes
      .filter((n) => n.lower.includes(words))
      .sort((a, b) => Number(b.lower.startsWith(words)) - Number(a.lower.startsWith(words)) || b.nb.length - a.nb.length)
      .slice(0, 8);
  }, [words, shown]);
  useEffect(() => {
    if (!brain.current) return;
    brain.current.match = words && shown ? new Set(shown.nodes.filter((n) => n.lower.includes(words)).map((n) => n.i)) : null;
    brain.current.draw();
  }, [words, shown]);
  const pick = (n: Node) => {
    setSelId(n.id);
    setQ("");
    brain.current?.focusOn(n);
  };

  // keys: / to search, Esc to let go, + − 0 to zoom
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable=true]")) {
        if (e.key === "Escape" && t === searchBox.current) (setQ(""), t.blur());
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") (e.preventDefault(), searchBox.current?.focus());
      else if (e.key === "Escape") (setSelId(null), setLocal(false));
      else if (e.key === "+" || e.key === "=") brain.current?.zoom(1.4, undefined, undefined, true);
      else if (e.key === "-") brain.current?.zoom(1 / 1.4, undefined, undefined, true);
      else if (e.key === "0") brain.current?.fit(true);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  useAskOpen(sel?.note ? { kind: "note", title: sel.label, ref: agentPath(sel.note) } : null);

  const counts = useMemo(() => {
    const c = {} as Record<Group, number>;
    for (const n of data?.nodes ?? []) c[n.group] = (c[n.group] ?? 0) + 1;
    return c;
  }, [data]);
  const neighbours = sel && data ? sel.nb.map((i) => data.nodes[i]!).sort((a, b) => a.label.localeCompare(b.label)) : [];
  // a kind's icon in its colour, for the lists and the card (both themes: a variable each, picked by .dark)
  const dot = (g: Group, size = "size-6") => {
    const Icon = GROUPS[g].icon;
    return (
      <span
        className={`${size} flex shrink-0 items-center justify-center rounded-full border border-(--c-l)/40 bg-(--c-l)/12 text-(--c-l) dark:border-(--c-d)/40 dark:bg-(--c-d)/15 dark:text-(--c-d)`}
        style={{ "--c-l": colourOf(g, false), "--c-d": colourOf(g, true) } as React.CSSProperties}
      >
        <Icon className="size-3.5" />
      </span>
    );
  };
  const empty = data && !data.nodes.length;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <AskFloat />
      {/* the icons the map draws inside its dots (Brain.readColors reads them) */}
      <div hidden aria-hidden>
        {(Object.keys(GROUPS) as Group[]).map((g) => {
          const Icon = GROUPS[g].icon;
          return <Icon key={g} data-brain-icon={g} strokeWidth={1.75} />;
        })}
      </div>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <h1 className="sr-only">Brain</h1>
        <MemoryTabs />
        {shown && !empty && (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums max-md:hidden">
            {shown.nodes.length} {shown.nodes.length === 1 ? "thing" : "things"} · {shown.edges.length} {shown.edges.length === 1 ? "link" : "links"}
          </span>
        )}
      </header>

      <div
        className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1.2px)] dark:bg-[radial-gradient(circle,oklch(1_0_0/7%)_1px,transparent_1.2px)]"
        style={{ backgroundSize: "28px 28px" }}
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,var(--color-background)_100%)]" />
        <canvas
          ref={canvas}
          tabIndex={0}
          aria-label="A map of the business's notes, clients, projects, contacts and team, and how they link. Search to find one."
          className="absolute inset-0 size-full cursor-grab touch-none outline-none"
        />
        {pending && <Skeleton className="absolute inset-6 rounded-xl" />}
        {error && <p className="absolute inset-x-0 top-1/3 text-center text-sm text-destructive">{error.message}</p>}
        {empty && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <FileTextIcon className="size-8 opacity-40" />
            Nothing to map yet. Notes, clients, projects and people show up here as they&apos;re added.
          </div>
        )}

        {/* search, top left */}
        <div className="absolute top-3 left-3 z-10 w-72 max-md:right-14 max-md:w-auto">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchBox}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && hits[0] && pick(hits[0])}
              placeholder="Find a client, person or note"
              aria-label="Find on the map"
              className="material h-10 rounded-xl pl-9 text-sm shadow-sm"
            />
          </div>
          {!!words && (
            <Card className="mt-1.5 gap-0 p-1 shadow-lg">
              {hits.map((n) => (
                <Button key={n.id} variant="ghost" size="sm" className="w-full justify-start gap-2 font-normal" onClick={() => pick(n)}>
                  {dot(n.group)}
                  <span className="truncate">{n.label}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{GROUPS[n.group].label}</span>
                </Button>
              ))}
              {!hits.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">Nothing by that name.</p>}
            </Card>
          )}
        </div>

        {/* zoom and what to show, top right */}
        <div className="absolute top-3 right-3 z-10 flex gap-2">
          <ButtonGroup className="max-md:hidden">
            <Button variant="outline" size="icon-sm" className="material" aria-label="Zoom out" onClick={() => brain.current?.zoom(1 / 1.4, undefined, undefined, true)}>
              <MinusIcon />
            </Button>
            <Button variant="outline" size="icon-sm" className="material" aria-label="Show everything" onClick={() => brain.current?.fit(true)}>
              <MaximizeIcon />
            </Button>
            <Button variant="outline" size="icon-sm" className="material" aria-label="Zoom in" onClick={() => brain.current?.zoom(1.4, undefined, undefined, true)}>
              <PlusIcon />
            </Button>
          </ButtonGroup>
          <Popover>
            <PopoverTrigger render={<Button variant="outline" size="icon-sm" className="material relative" aria-label="What to show" />}>
              <SlidersHorizontalIcon />
              {hidden.size > 0 && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary" />}
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 gap-1 p-2">
              <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">Show</p>
              {(Object.keys(GROUPS) as Group[])
                .filter((g) => counts[g])
                .map((g) => (
                  <Label key={g} className="flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 font-normal hover:bg-muted">
                    <Checkbox checked={!hidden.has(g)} onCheckedChange={(on) => toggle(g, on)} />
                    {dot(g)}
                    <span className="flex-1 truncate">{GROUPS[g].label}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{counts[g]}</span>
                  </Label>
                ))}
              <Label className="mt-1 flex h-9 cursor-pointer items-center justify-between gap-2 border-t px-2 pt-1 font-normal">
                Things with no links
                <Switch checked={orphans} onCheckedChange={setOrphans} />
              </Label>
            </PopoverContent>
          </Popover>
        </div>

        {/* the picked one: what it is, what it links to, and the way in */}
        {sel && (
          <Card className="material absolute top-16 right-3 z-10 flex max-h-[calc(100%-12rem)] w-80 flex-col gap-0 p-0 shadow-lg max-md:inset-x-3 max-md:w-auto">
            <div className="flex items-start gap-2 border-b p-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  {dot(sel.group, "size-5")}
                  {GROUPS[sel.group].label}
                  {sel.note && sel.note.repo !== "company" && ` · ${REPO_LABEL(sel.note.repo)}`}
                </p>
                <h2 className="mt-1 font-sans text-base font-medium tracking-normal break-words">{sel.label}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {sel.ghost ? "Linked to, not written yet" : `${sel.nb.length} ${sel.nb.length === 1 ? "link" : "links"}`}
                </p>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => (setSelId(null), setLocal(false))}>
                <XIcon />
              </Button>
            </div>
            <div className="flex flex-wrap gap-2 border-b p-3">
              {sel.note && (
                <Button size="sm" onClick={() => open(sel)}>
                  Read the note
                </Button>
              )}
              {sel.record && thingHref(sel.record) && (
                <Button size="sm" variant={sel.note ? "outline" : "default"} nativeButton={false} render={<Link href={thingHref(sel.record)!} />}>
                  Open {GROUPS[sel.group].label.replace(/s$/, "").replace(/^Team$/, "teammate").toLowerCase()}
                </Button>
              )}
              <Label className="ml-auto flex cursor-pointer items-center gap-2 text-xs font-normal">
                Only its links
                <Switch size="sm" checked={local} onCheckedChange={setLocal} />
              </Label>
            </div>
            {!!neighbours.length && (
              <div className="min-h-0 overflow-y-auto p-1">
                {neighbours.map((n) => (
                  <Button key={n.id} variant="ghost" size="sm" className="w-full justify-start gap-2 font-normal" onClick={() => pick(n)}>
                    {dot(n.group)}
                    <span className={`truncate ${n.ghost ? "text-muted-foreground" : ""}`}>{n.label}</span>
                  </Button>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
