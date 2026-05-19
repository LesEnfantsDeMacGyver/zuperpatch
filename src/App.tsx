import {
  Cable,
  ChevronLeft,
  ChevronRight,
  CircuitBoard,
  Download,
  EthernetPort,
  FileUp,
  Gauge,
  GitBranch,
  Minus,
  MousePointer2,
  PencilRuler,
  PlugZap,
  Plus,
  Ruler,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { jsPDF } from "jspdf";
import * as pdfjsLib from "pdfjs-dist";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist/types/src/display/api";
import type { PointerEvent, PointerEventHandler, UIEvent, WheelEvent } from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).toString();

type Point = { x: number; y: number };
type CableType = "ethernet" | "power" | "xlr";
type DeviceType =
  | "powerstrip"
  | "switch"
  | "ethernetClient"
  | "producer"
  | "consumer";
type LabelPosition = "top" | "right" | "bottom" | "left";
type Mode = "select" | "scale" | "measure" | "cable" | "device";
type ConsumerSourceMode = "auto" | "manual";
type ConsumerSourceType = "producer" | "powerstrip" | "powerCable";
type ElectricalColorMode = "length" | "load";

type CableRoute = {
  id: string;
  type: CableType;
  page: number;
  points: Point[];
  branches?: CableBranch[];
  endpointDeviceIds?: CableEndpointDeviceIds;
};

type CableBranch = {
  id: string;
  points: Point[];
};

type CableEndpointDeviceIds = {
  start?: string;
  end?: string;
  branches?: Record<string, string | undefined>;
};

type Device = {
  id: string;
  type: DeviceType;
  page: number;
  point: Point;
  name?: string;
  availablePowerW?: number;
  powerW?: number;
  poePowerW?: number;
  desiredFreeSockets?: number;
  socketCapacity?: number;
  sourceMode?: ConsumerSourceMode;
  sourceType?: ConsumerSourceType;
  sourceId?: string;
  labelPosition?: LabelPosition;
};

type ConsumerSource = {
  id: string;
  type: ConsumerSourceType;
  label: string;
  page: number;
  point: Point;
  route?: CableRoute;
  targetPoints?: Point[];
};

type ResolvedConsumerSource = {
  consumer: Device;
  source?: ConsumerSource;
  targetPoint?: Point;
  distancePx?: number;
  autoAssigned: boolean;
};

type DeviceCableAttachment = {
  device: Device;
  route: CableRoute;
  targetPoint: Point;
  distancePx: number;
};

type AttachedCablePoint = {
  routeId: string;
  pointIndex?: number;
  branchId?: string;
  branchPointIndex?: number;
  startPoint: Point;
};

type DraggingDevice = {
  deviceId: string;
  startPoint: Point;
  attachedCablePoints: AttachedCablePoint[];
};

type DraggingCablePoint = {
  routeId: string;
  pointIndex?: number;
  branchId?: string;
  branchPointIndex?: number;
  detachedDeviceId?: string;
};

type CablePointReference = DraggingCablePoint & {
  page: number;
  point: Point;
};

type SelectedCablePoint = DraggingCablePoint;
type ViewPosition = { scrollLeft: number; scrollTop: number };
type SpacePanDrag = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
};
type Measurement = {
  id: string;
  page: number;
  start: Point;
  end: Point;
};
type RouteEndpointReference = ReturnType<typeof routeEndpointReferences>[number];

type FlowPath = {
  id: string;
  pathData: string;
  activeColor: string;
  inactiveColor: string;
  reuseAutoSourceId?: string;
  usesDisplayCoordinates?: boolean;
  segments?: FlowPathSegment[];
};

type FlowPathSegment = {
  activeEndColor: string;
  activeStartColor: string;
  end: Point;
  id: string;
  inactiveEndColor: string;
  inactiveStartColor: string;
  phase: number;
  start: Point;
};

type AutoSourceLinkRoute = {
  arcPixels: number;
  control: Point;
  end: Point;
  id: string;
  start: Point;
};

type CableColorPath = {
  loadRatio?: number;
  offsetPx: number;
  sourceBranchId?: string;
  sourcePointIndex?: number;
};

type CableConfig = {
  id: CableType;
  label: string;
  maxLengthM: number;
  colorStart: string;
  colorEnd: string;
  accent: string;
  note: string;
};

type DeviceConfig = {
  id: DeviceType;
  label: string;
  icon: typeof PlugZap;
  color: string;
  detail: string;
};

type PersistedProject = {
  version: 1;
  pdfName: string;
  pdfDataUrl?: string;
  pageNumber: number;
  pageCount: number;
  pageSize: { width: number; height: number };
  zoom: number;
  floorPlanOpacity: number;
  animateOrphans: boolean;
  electricalColorMode: ElectricalColorMode;
  mode: Mode;
  activeCable: CableType;
  activeDevice: DeviceType;
  knownDistance: string;
  calibration?: { start: Point; end: Point };
  cables: CableRoute[];
  devices: Device[];
  viewPosition: ViewPosition;
};

type UndoSnapshot = PersistedProject & {
  routeDraft: Point[];
  routeDraftDeviceIds: Array<string | undefined>;
  scaleDraft: Point | null;
  selectedId: string | null;
  selectedCablePoint: SelectedCablePoint | null;
};

const storageKey = "zuperpatch.project.v1";
const defaultViewPosition: ViewPosition = { scrollLeft: 0, scrollTop: 0 };
const minZoom = 0.6;
const maxZoom = 5;
const zoomStep = 0.2;
const maxUndoHistory = 160;
const flowDashCyclePx = 52;
const cablePointSnapRadiusPx = 11;
const defaultPowerSourceSockets = 4;
const defaultEthernetSwitchSockets = 8;
const desiredFreeSocketLoadW = 30;
const electricalReferenceVoltageV = 230;
const electricalCordMaxLoadA = 10;
const electricalCordMaxLoadW = electricalReferenceVoltageV * electricalCordMaxLoadA;

const cableTypes: Record<CableType, CableConfig> = {
  ethernet: {
    id: "ethernet",
    label: "Ethernet",
    maxLengthM: 100,
    colorStart: "#14b8a6",
    colorEnd: "#ef4444",
    accent: "#0f766e",
    note: "Typical copper Ethernet channel limit.",
  },
  power: {
    id: "power",
    label: "Electrical",
    maxLengthM: 30,
    colorStart: "#facc15",
    colorEnd: "#dc2626",
    accent: "#a16207",
    note: "Planning threshold only; verify code and voltage drop.",
  },
  xlr: {
    id: "xlr",
    label: "XLR",
    maxLengthM: 100,
    colorStart: "#a78bfa",
    colorEnd: "#ef4444",
    accent: "#6d28d9",
    note: "Planning target for balanced analog audio runs.",
  },
};

const cableTypeOrder = Object.keys(cableTypes) as CableType[];

const deviceTypes: Record<DeviceType, DeviceConfig> = {
  powerstrip: {
    id: "powerstrip",
    label: "Powerstrip",
    icon: PlugZap,
    color: "#ca8a04",
    detail: "Click to place",
  },
  switch: {
    id: "switch",
    label: "Ethernet switch",
    icon: EthernetPort,
    color: "#047857",
    detail: "Click to place",
  },
  ethernetClient: {
    id: "ethernetClient",
    label: "Ethernet client",
    icon: EthernetPort,
    color: "#0891b2",
    detail: "PoE load",
  },
  producer: {
    id: "producer",
    label: "Power source",
    icon: Gauge,
    color: "#9333ea",
    detail: "Supply capacity",
  },
  consumer: {
    id: "consumer",
    label: "Power consumer",
    icon: PlugZap,
    color: "#e11d48",
    detail: "Named load",
  },
};

const deviceTypeOrder = Object.keys(deviceTypes) as DeviceType[];

const unit = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});
const integerUnit = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function isTextEditingTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
    : false;
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clampPoint(point: Point, bounds: { width: number; height: number }) {
  return {
    x: Math.min(Math.max(point.x, 0), bounds.width),
    y: Math.min(Math.max(point.y, 0), bounds.height),
  };
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clampUnit(value: number) {
  return clampNumber(value, 0, 1);
}

function hexToRgb(color: string) {
  const hex = color.replace("#", "");
  const normalized =
    hex.length === 3
      ? hex.split("").map((part) => part + part).join("")
      : hex.padEnd(6, "0").slice(0, 6);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16) / 255,
    g: Number.parseInt(normalized.slice(2, 4), 16) / 255,
    b: Number.parseInt(normalized.slice(4, 6), 16) / 255,
  };
}

function rgbToHex(color: { r: number; g: number; b: number }) {
  const channel = (value: number) =>
    Math.round(clampUnit(value) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function rgbToHsv(color: { r: number; g: number; b: number }) {
  const value = Math.max(color.r, color.g, color.b);
  const low = Math.min(color.r, color.g, color.b);
  const delta = value - low;
  let hue = 0;

  if (delta > 0) {
    if (value === color.r) {
      hue = (((color.g - color.b) / delta) % 6) / 6;
    } else if (value === color.g) {
      hue = ((color.b - color.r) / delta + 2) / 6;
    } else {
      hue = ((color.r - color.g) / delta + 4) / 6;
    }
  }

  return {
    h: (hue + 1) % 1,
    s: value === 0 ? 0 : delta / value,
    v: value,
  };
}

function hsvToRgb(hue: number, saturation: number, value: number) {
  const scaledHue = ((hue % 1) + 1) % 1 * 6;
  const index = Math.floor(scaledHue);
  const fraction = scaledHue - index;
  const p = value * (1 - saturation);
  const q = value * (1 - fraction * saturation);
  const t = value * (1 - (1 - fraction) * saturation);

  if (index === 0) return { r: value, g: t, b: p };
  if (index === 1) return { r: q, g: value, b: p };
  if (index === 2) return { r: p, g: value, b: t };
  if (index === 3) return { r: p, g: q, b: value };
  if (index === 4) return { r: t, g: p, b: value };
  return { r: value, g: p, b: q };
}

function toneColor(color: { r: number; g: number; b: number }, multiplier: number) {
  const hsv = rgbToHsv(color);
  return hsvToRgb(hsv.h, Math.min(hsv.s * 0.95, 1), Math.min(0.66, hsv.v * multiplier));
}

function mixColor(
  first: { r: number; g: number; b: number },
  second: { r: number; g: number; b: number },
  amount: number,
) {
  const t = clampUnit(amount);
  return {
    r: first.r + (second.r - first.r) * t,
    g: first.g + (second.g - first.g) * t,
    b: first.b + (second.b - first.b) * t,
  };
}

function flowColorsForCable(baseColor: string) {
  const fill = hexToRgb(baseColor);
  const bed = { r: fill.r * 0.25, g: fill.g * 0.25, b: fill.b * 0.25 };
  const inactive = toneColor(bed, 2.5);
  const active = toneColor(fill, 0.38);
  return {
    inactiveColor: rgbToHex(mixColor(inactive, active, 0.12)),
    activeColor: rgbToHex(active),
  };
}

function flowColorsAtRatio(ratio: number) {
  return flowColorsForCable(colorAtRatio(ratio));
}

function flowSegmentsForPoints(
  points: Point[],
  maxLengthPx: number,
  offsetPx = 0,
): FlowPathSegment[] {
  let travelled = 0;
  return points.slice(1).map((point, index) => {
    const start = points[index];
    const segmentLength = distance(start, point);
    const startRatio = maxLengthPx ? (offsetPx + travelled) / maxLengthPx : 0;
    const endRatio = maxLengthPx
      ? (offsetPx + travelled + segmentLength) / maxLengthPx
      : startRatio;
    const startColors = flowColorsAtRatio(startRatio);
    const endColors = flowColorsAtRatio(endRatio);
    const segment: FlowPathSegment = {
      activeEndColor: endColors.activeColor,
      activeStartColor: startColors.activeColor,
      end: point,
      id: `${index}-${start.x}-${start.y}-${point.x}-${point.y}`,
      inactiveEndColor: endColors.inactiveColor,
      inactiveStartColor: startColors.inactiveColor,
      phase: travelled % flowDashCyclePx,
      start,
    };
    travelled += segmentLength;
    return segment;
  });
}

function nextOption<T extends string>(options: T[], current: T) {
  const currentIndex = options.indexOf(current);
  return options[(currentIndex + 1) % options.length] ?? options[0];
}

function routeEndpointReferences(route: CableRoute) {
  if (route.points.length === 0) return [];
  const endpoints: Array<{
    branchId?: string;
    branchPointIndex?: number;
    deviceId?: string;
    point: Point;
    pointIndex?: number;
  }> = [{ deviceId: route.endpointDeviceIds?.start, point: route.points[0], pointIndex: 0 }];
  const branches = route.branches ?? [];
  if (branches.length > 0) {
    branches.forEach((branch) => {
      if (branch.points.length === 0) return;
      endpoints.push({
        branchId: branch.id,
        branchPointIndex: branch.points.length - 1,
        deviceId: route.endpointDeviceIds?.branches?.[branch.id],
        point: branch.points[branch.points.length - 1],
      });
    });
    return endpoints;
  }
  endpoints.push({
    deviceId: route.endpointDeviceIds?.end,
    point: route.points[route.points.length - 1],
    pointIndex: route.points.length - 1,
  });
  return endpoints;
}

function closestPointOnSegment(point: Point, start: Point, end: Point) {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (!segmentLengthSquared) return start;
  const ratio = Math.min(
    Math.max(
      ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) /
        segmentLengthSquared,
      0,
    ),
    1,
  );
  return {
    x: start.x + ratio * segmentX,
    y: start.y + ratio * segmentY,
  };
}

function insertionPointForRoute(point: Point, route: CableRoute) {
  if (route.points.length < 2) return undefined;
  return route.points.slice(1).reduce(
    (closest, segmentEnd, index) => {
      const segmentStart = route.points[index];
      const projectedPoint = closestPointOnSegment(point, segmentStart, segmentEnd);
      const projectedDistance = distance(point, projectedPoint);
      return projectedDistance < closest.distance
        ? {
            distance: projectedDistance,
            point: projectedPoint,
            pointIndex: index + 1,
          }
        : closest;
    },
    {
      distance: Number.POSITIVE_INFINITY,
      point: route.points[1],
      pointIndex: 1,
    },
  );
}

function constrainTo45Degrees(origin: Point, target: Point) {
  const segmentLength = distance(origin, target);
  if (!segmentLength) return target;
  const angle = Math.atan2(target.y - origin.y, target.x - origin.x);
  const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
  return {
    x: origin.x + Math.cos(snappedAngle) * segmentLength,
    y: origin.y + Math.sin(snappedAngle) * segmentLength,
  };
}

function constrainEditedRoutePoint(points: Point[], pointIndex: number, target: Point) {
  const anchor = points[pointIndex - 1] ?? points[pointIndex + 1];
  return anchor ? constrainTo45Degrees(anchor, target) : target;
}

function attachedPointSnapAnchor(route: CableRoute, attachment: AttachedCablePoint) {
  if (attachment.branchId !== undefined && attachment.branchPointIndex !== undefined) {
    const branch = route.branches?.find((currentBranch) => currentBranch.id === attachment.branchId);
    if (!branch) return undefined;
    return branch.points[attachment.branchPointIndex - 1] ?? route.points[route.points.length - 1];
  }
  if (attachment.pointIndex === undefined) return undefined;
  return route.points[attachment.pointIndex - 1] ?? route.points[attachment.pointIndex + 1];
}

function routeWithEndpointDeviceId(
  route: CableRoute,
  point: DraggingCablePoint,
  deviceId?: string,
) {
  const endpointDeviceIds = route.endpointDeviceIds ?? {};
  if (point.branchId !== undefined) {
    return {
      ...route,
      endpointDeviceIds: {
        ...endpointDeviceIds,
        branches: {
          ...endpointDeviceIds.branches,
          [point.branchId]: deviceId,
        },
      },
    };
  }
  if (point.pointIndex === 0) {
    return {
      ...route,
      endpointDeviceIds: {
        ...endpointDeviceIds,
        start: deviceId,
      },
    };
  }
  if (point.pointIndex === route.points.length - 1) {
    return {
      ...route,
      endpointDeviceIds: {
        ...endpointDeviceIds,
        end: deviceId,
      },
    };
  }
  return route;
}

function cablePointKey(point: DraggingCablePoint) {
  return [
    point.routeId,
    point.branchId ?? "",
    point.branchPointIndex ?? "",
    point.pointIndex ?? "",
  ].join(":");
}

function cablePointReferencesForRoute(route: CableRoute): CablePointReference[] {
  return [
    ...route.points.map((point, pointIndex) => ({
      page: route.page,
      point,
      pointIndex,
      routeId: route.id,
    })),
    ...(route.branches ?? []).flatMap((branch) =>
      branch.points.map((point, branchPointIndex) => ({
        branchId: branch.id,
        branchPointIndex,
        page: route.page,
        point,
        routeId: route.id,
      })),
    ),
  ];
}

function cablePointReferencesForRoutes(routes: CableRoute[]) {
  return routes.flatMap(cablePointReferencesForRoute);
}

function cablePointForReference(route: CableRoute, reference: DraggingCablePoint) {
  if (reference.branchId !== undefined && reference.branchPointIndex !== undefined) {
    const branch = route.branches?.find(
      (currentBranch) => currentBranch.id === reference.branchId,
    );
    return branch?.points[reference.branchPointIndex];
  }
  return reference.pointIndex !== undefined ? route.points[reference.pointIndex] : undefined;
}

function isEndpointCablePoint(route: CableRoute, reference: DraggingCablePoint) {
  if (reference.branchId !== undefined && reference.branchPointIndex !== undefined) {
    const branch = route.branches?.find(
      (currentBranch) => currentBranch.id === reference.branchId,
    );
    return Boolean(branch && reference.branchPointIndex === branch.points.length - 1);
  }
  if (reference.pointIndex === undefined) return false;
  if ((route.branches ?? []).length > 0) return reference.pointIndex === 0;
  return reference.pointIndex === 0 || reference.pointIndex === route.points.length - 1;
}

function routeWithCablePoint(route: CableRoute, reference: DraggingCablePoint, point: Point) {
  if (reference.branchId !== undefined && reference.branchPointIndex !== undefined) {
    return {
      ...route,
      branches: route.branches?.map((branch) =>
        branch.id === reference.branchId
          ? {
              ...branch,
              points: branch.points.map((branchPoint, index) =>
                index === reference.branchPointIndex ? point : branchPoint,
              ),
            }
          : branch,
      ),
    };
  }
  if (reference.pointIndex === undefined) return route;
  return {
    ...route,
    points: route.points.map((routePoint, index) =>
      index === reference.pointIndex ? point : routePoint,
    ),
  };
}

function closestCablePointSnap(
  point: Point,
  routes: CableRoute[],
  page: number,
  excludedPointKeys: Set<string>,
  excludedRouteId: string,
  viewScale: number,
) {
  const snapDistance = cablePointSnapRadiusPx / viewScale;
  return cablePointReferencesForRoutes(routes)
    .filter(
      (reference) =>
        reference.page === page &&
        reference.routeId !== excludedRouteId &&
        !excludedPointKeys.has(cablePointKey(reference)),
    )
    .map((reference) => ({
      distancePx: distance(point, reference.point),
      point: reference.point,
    }))
    .filter((candidate) => candidate.distancePx <= snapDistance)
    .sort((a, b) => a.distancePx - b.distancePx)[0]?.point;
}

function adjacentCablePointsForReference(route: CableRoute, reference: DraggingCablePoint) {
  if (reference.branchId !== undefined && reference.branchPointIndex !== undefined) {
    const branch = route.branches?.find(
      (currentBranch) => currentBranch.id === reference.branchId,
    );
    if (!branch) return [];
    return [
      reference.branchPointIndex === 0
        ? route.points[route.points.length - 1]
        : branch.points[reference.branchPointIndex - 1],
      branch.points[reference.branchPointIndex + 1],
    ].filter((point): point is Point => Boolean(point));
  }
  if (reference.pointIndex === undefined) return [];
  return [
    route.points[reference.pointIndex - 1],
    route.points[reference.pointIndex + 1],
    ...(reference.pointIndex === route.points.length - 1
      ? (route.branches ?? []).map((branch) => branch.points[0])
      : []),
  ].filter((point): point is Point => Boolean(point));
}

function snapIntermediateCablePointToAxis(
  route: CableRoute,
  reference: DraggingCablePoint,
  target: Point,
  viewScale: number,
) {
  if (isEndpointCablePoint(route, reference)) return target;
  const snapDistance = cablePointSnapRadiusPx / viewScale;
  const anchors = adjacentCablePointsForReference(route, reference);
  const xCandidate = anchors
    .map((anchor) => ({ anchor, distancePx: Math.abs(target.x - anchor.x) }))
    .filter((candidate) => candidate.distancePx <= snapDistance)
    .sort((a, b) => a.distancePx - b.distancePx)[0];
  const yCandidate = anchors
    .map((anchor) => ({ anchor, distancePx: Math.abs(target.y - anchor.y) }))
    .filter((candidate) => candidate.distancePx <= snapDistance)
    .sort((a, b) => a.distancePx - b.distancePx)[0];

  if (xCandidate && yCandidate && xCandidate.anchor === yCandidate.anchor) {
    return xCandidate.distancePx <= yCandidate.distancePx
      ? { ...target, x: xCandidate.anchor.x }
      : { ...target, y: yCandidate.anchor.y };
  }

  return {
    x: xCandidate ? xCandidate.anchor.x : target.x,
    y: yCandidate ? yCandidate.anchor.y : target.y,
  };
}

function endpointDeviceIdsForDraft(deviceIds: Array<string | undefined>) {
  return {
    start: deviceIds[0],
    end: deviceIds[deviceIds.length - 1],
  };
}

function constrainAttachedDevicePoint(
  target: Point,
  attachments: AttachedCablePoint[],
  routes: CableRoute[],
  shouldConstrain: boolean,
  bounds: { width: number; height: number },
) {
  if (!shouldConstrain || attachments.length === 0) return clampPoint(target, bounds);
  const anchor = attachments
    .map((attachment) => {
      const route = routes.find((currentRoute) => currentRoute.id === attachment.routeId);
      return route ? attachedPointSnapAnchor(route, attachment) : undefined;
    })
    .find((point): point is Point => Boolean(point));
  return clampPoint(anchor ? constrainTo45Degrees(anchor, target) : target, bounds);
}

function scalePoint(point: Point, scale: number) {
  return {
    x: point.x * scale,
    y: point.y * scale,
  };
}

function scalePoints(points: Point[], scale: number) {
  return points.map((point) => scalePoint(point, scale));
}

function scaleBranches(branches: CableBranch[] | undefined, scale: number) {
  return (branches ?? []).map((branch) => ({
    ...branch,
    points: scalePoints(branch.points, scale),
  }));
}

function routePixels(points: Point[]) {
  return points.reduce((sum, point, index) => {
    if (index === 0) return 0;
    return sum + distance(points[index - 1], point);
  }, 0);
}

function branchPathPoints(route: CableRoute, branch: CableBranch) {
  const splitPoint = route.points[route.points.length - 1];
  return splitPoint ? [splitPoint, ...branch.points] : branch.points;
}

function routeCablePathPixels(route: CableRoute) {
  const branches = route.branches ?? [];
  if (branches.length === 0) return [routePixels(route.points)];
  const trunkPixels = routePixels(route.points);
  return branches.map((branch) => trunkPixels + routePixels(branchPathPoints(route, branch)));
}

function routeMaterialPixels(route: CableRoute) {
  return routeCablePathPixels(route).reduce((sum, pixels) => sum + pixels, 0);
}

function cumulativePixelsAtPoint(points: Point[], pointIndex: number) {
  return routePixels(points.slice(0, pointIndex + 1));
}

function deviceDisplayLabel(device: Device | undefined) {
  if (!device) return undefined;
  return device.name?.trim() || deviceTypes[device.type].label;
}

function routeEndpointLabel(
  endpoint: RouteEndpointReference | undefined,
  devicesById: Map<string, Device>,
  fallback: string,
) {
  if (!endpoint?.deviceId) return fallback;
  return deviceDisplayLabel(devicesById.get(endpoint.deviceId)) ?? fallback;
}

function cableBomEntries(route: CableRoute, devices: Device[]) {
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  const startEndpoint = routeEndpointReferences(route).find((endpoint) => endpoint.pointIndex === 0);
  const startLabel = routeEndpointLabel(startEndpoint, devicesById, "Cable start");
  const branches = route.branches ?? [];
  if (branches.length > 0) {
    return branches.map((branch, index) => {
      const endpoint = branch.points.length
        ? {
            branchId: branch.id,
            branchPointIndex: branch.points.length - 1,
            deviceId: route.endpointDeviceIds?.branches?.[branch.id],
            point: branch.points[branch.points.length - 1],
          }
        : undefined;
      const endLabel = routeEndpointLabel(endpoint, devicesById, `Split end ${index + 1}`);
      return {
        label: `${startLabel} - ${endLabel}`,
        note: "Split route: includes shared trunk plus this branch.",
        pixels: routePixels(route.points) + routePixels(branchPathPoints(route, branch)),
      };
    });
  }
  const endEndpoint = routeEndpointReferences(route).find(
    (endpoint) => endpoint.pointIndex === route.points.length - 1,
  );
  return [{
    label: `${startLabel} - ${routeEndpointLabel(endEndpoint, devicesById, "Cable end")}`,
    note: undefined,
    pixels: routePixels(route.points),
  }];
}

function colorAtRatio(ratio: number) {
  if (ratio < 0.65) return "#10b981";
  if (ratio < 0.9) return "#f59e0b";
  if (ratio < 1) return "#f97316";
  return "#dc2626";
}

function routeMidpoint(points: Point[]) {
  const total = routePixels(points);
  if (!total || points.length < 2) return points[0] ?? { x: 0, y: 0 };
  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const segmentLength = distance(previous, current);
    if (travelled + segmentLength >= total / 2) {
      const ratio = (total / 2 - travelled) / segmentLength;
      return {
        x: previous.x + (current.x - previous.x) * ratio,
        y: previous.y + (current.y - previous.y) * ratio,
      };
    }
    travelled += segmentLength;
  }
  return points[points.length - 1];
}

function routePathData(points: Point[]) {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  return [
    `M ${first.x} ${first.y}`,
    ...rest.map((point) => `L ${point.x} ${point.y}`),
  ].join(" ");
}

function scalePathData(pathData: string, scale: number) {
  return pathData.replace(/-?\d+(?:\.\d+)?/g, (value) => `${Number(value) * scale}`);
}

function labelPathPoints(points: Point[]) {
  if (points.length < 2) return points;
  const longestSegment = points.slice(1).reduce(
    (longest, point, index) => {
      const start = points[index];
      const segmentLength = distance(start, point);
      return segmentLength > longest.length
        ? { length: segmentLength, points: [start, point] }
        : longest;
    },
    { length: 0, points: [points[0], points[1]] },
  );
  const [start, end] = longestSegment.points;
  const shouldReverse = start.x > end.x || (start.x === end.x && start.y > end.y);
  return shouldReverse ? [end, start] : [start, end];
}

function lengthLabel(meters: number) {
  return `${unit.format(meters)} m`;
}

function powerLabel(watts: number) {
  if (watts >= 1000) return `${unit.format(watts / 1000)} kW`;
  return `${unit.format(watts)} W`;
}

function electricalLoadRatioForWatts(watts: number) {
  return electricalCordMaxLoadW ? watts / electricalCordMaxLoadW : 0;
}

function countByDeviceType(devices: Device[], type: DeviceType) {
  return devices.filter((device) => device.type === type).length;
}

function commonDeviceValue<T>(
  devices: Device[],
  getValue: {
    // eslint-disable-next-line no-unused-vars
    (device: Device): T;
  },
) {
  if (devices.length === 0) return undefined;
  const firstValue = getValue(devices[0]);
  return devices.every((device) => Object.is(getValue(device), firstValue))
    ? firstValue
    : undefined;
}

function socketCapacityForDevice(device: Device) {
  if (device.type === "powerstrip") return 0;
  if (device.socketCapacity !== undefined) return Math.max(0, device.socketCapacity);
  if (device.type === "producer") return defaultPowerSourceSockets;
  if (device.type === "switch") return defaultEthernetSwitchSockets;
  return 0;
}

function canCableConnectDevice(cableType: CableType, deviceType: DeviceType) {
  if (cableType === "power") {
    return (
      deviceType === "producer" ||
      deviceType === "powerstrip" ||
      deviceType === "consumer" ||
      deviceType === "switch"
    );
  }
  if (cableType === "ethernet") {
    return deviceType === "switch" || deviceType === "ethernetClient" || deviceType === "consumer";
  }
  if (cableType === "xlr") {
    return deviceType === "consumer";
  }
  return false;
}

function canCableConnectDeviceTypes(
  cableType: CableType,
  firstType: DeviceType,
  secondType: DeviceType,
) {
  if (!canCableConnectDevice(cableType, firstType) || !canCableConnectDevice(cableType, secondType)) {
    return false;
  }
  const deviceTypes = [firstType, secondType].sort().join(":");
  if (cableType === "power") {
    return (
      deviceTypes === "consumer:powerstrip" ||
      deviceTypes === "consumer:producer" ||
      deviceTypes === "powerstrip:powerstrip" ||
      deviceTypes === "powerstrip:producer" ||
      deviceTypes === "powerstrip:switch" ||
      deviceTypes === "producer:switch"
    );
  }
  if (cableType === "ethernet") {
    return (
      deviceTypes === "consumer:switch" ||
      deviceTypes === "ethernetClient:switch" ||
      deviceTypes === "switch:switch"
    );
  }
  if (cableType === "xlr") {
    return deviceTypes === "consumer:consumer";
  }
  return false;
}

function canCableConnectDevices(cableType: CableType, startDevice: Device, endDevice: Device) {
  if (startDevice.id === endDevice.id) return false;
  return canCableConnectDeviceTypes(cableType, startDevice.type, endDevice.type);
}

function isSameEndpoint(
  endpoint: ReturnType<typeof routeEndpointReferences>[number],
  point: DraggingCablePoint,
) {
  if (point.branchId !== undefined) {
    return endpoint.branchId === point.branchId;
  }
  return endpoint.pointIndex === point.pointIndex;
}

function otherEndpointDevicesForPoint(
  route: CableRoute,
  point: DraggingCablePoint,
  devices: Device[],
) {
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  return routeEndpointReferences(route)
    .filter((endpoint) => !isSameEndpoint(endpoint, point))
    .map((endpoint) => (endpoint.deviceId ? deviceById.get(endpoint.deviceId) : undefined))
    .filter((device): device is Device => Boolean(device));
}

function endpointDeviceIdForPoint(route: CableRoute, point: DraggingCablePoint) {
  return routeEndpointReferences(route).find((endpoint) => isSameEndpoint(endpoint, point))
    ?.deviceId;
}

function canAttachEndpointToDevice(
  route: CableRoute,
  point: DraggingCablePoint | undefined,
  candidate: Device,
  devices: Device[],
) {
  if (!canCableConnectDevice(route.type, candidate.type)) return false;
  if (!point) return true;
  const otherDevices = otherEndpointDevicesForPoint(route, point, devices);
  return otherDevices.every((device) => canCableConnectDevices(route.type, candidate, device));
}

function deviceCableAttachmentCount(
  deviceId: string,
  routes: CableRoute[],
  cableType: CableType,
) {
  return routes
    .filter((route) => route.type === cableType)
    .reduce((count, route) => {
      const endpoints = routeEndpointReferences(route);
      return count + endpoints.filter((endpoint) => endpoint.deviceId === deviceId).length;
    }, 0);
}

function canAddCablePointForDevice(
  cableType: CableType,
  device: Device,
  routes: CableRoute[],
  draftDeviceIds: Array<string | undefined>,
) {
  if (!canCableConnectDevice(cableType, device.type)) return false;
  if (cableType !== "power" || (device.type !== "consumer" && device.type !== "switch")) {
    return true;
  }
  const existingAttachments = deviceCableAttachmentCount(device.id, routes, cableType);
  const draftAttachments = draftDeviceIds.filter((deviceId) => deviceId === device.id).length;
  return existingAttachments + draftAttachments === 0;
}

function sourceValue(source?: Pick<ConsumerSource, "type" | "id">) {
  return source ? `${source.type}:${source.id}` : "none";
}

function autoSourceLinkId(consumerId: string, source: Pick<ConsumerSource, "type" | "id">) {
  return `${consumerId}-${source.type}-${source.id}`;
}

function isManualProducerSourceAssignment(
  assignment: ResolvedConsumerSource & { source?: ConsumerSource },
) {
  return (
    !assignment.autoAssigned &&
    assignment.source?.type === "producer" &&
    assignment.consumer.sourceMode === "manual" &&
    assignment.consumer.sourceType === "producer"
  );
}

function sourceLabel(source?: ConsumerSource) {
  return source?.label ?? "Unassigned";
}

function consumerSourcePriority(source: ConsumerSource) {
  if (source.type === "powerstrip") return 0;
  if (source.type === "producer") return 1;
  return 2;
}

function sourceArcControl(
  start: Point,
  end: Point,
  options: { direction?: number; offsetScale?: number } = {},
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const segmentLength = Math.hypot(dx, dy) || 1;
  const midpoint = {
    x: start.x + dx / 2,
    y: start.y + dy / 2,
  };
  const direction = options.direction && options.direction < 0 ? -1 : 1;
  const offsetScale = options.offsetScale ?? 1;
  const offset = Math.min(96, Math.max(18, segmentLength * 0.45 * offsetScale));
  const control = {
    x: midpoint.x - (dy / segmentLength) * offset * direction,
    y: midpoint.y + (dx / segmentLength) * offset * direction,
  };
  return control;
}

function sourceArcPathThroughControl(start: Point, control: Point, end: Point) {
  return `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
}

function sourceArcPath(start: Point, end: Point) {
  return sourceArcPathThroughControl(start, sourceArcControl(start, end), end);
}

function sourceArcPointAt(start: Point, control: Point, end: Point, t: number) {
  const mt = 1 - t;
  return {
    x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
    y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y,
  };
}

function sourceArcSamplePoints(start: Point, control: Point, end: Point, steps = 16) {
  return Array.from({ length: steps + 1 }, (_item, index) =>
    sourceArcPointAt(start, control, end, index / steps),
  );
}

function sourceArcPixels(start: Point, end: Point, control = sourceArcControl(start, end)) {
  const points = sourceArcSamplePoints(start, control, end);
  let length = 0;
  let previous = points[0];
  for (const point of points.slice(1)) {
    length += distance(previous, point);
    previous = point;
  }
  return length;
}

function orientation(a: Point, b: Point, c: Point) {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}

function segmentsIntersect(firstStart: Point, firstEnd: Point, secondStart: Point, secondEnd: Point) {
  if (
    distance(firstStart, secondStart) < 1 ||
    distance(firstStart, secondEnd) < 1 ||
    distance(firstEnd, secondStart) < 1 ||
    distance(firstEnd, secondEnd) < 1
  ) {
    return false;
  }
  const firstOrientation = orientation(firstStart, firstEnd, secondStart);
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart);
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);
  return firstOrientation * secondOrientation < 0 && thirdOrientation * fourthOrientation < 0;
}

function pointToSegmentDistance(point: Point, segmentStart: Point, segmentEnd: Point) {
  const dx = segmentEnd.x - segmentStart.x;
  const dy = segmentEnd.y - segmentStart.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, segmentStart);
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - segmentStart.x) * dx + (point.y - segmentStart.y) * dy) / lengthSquared,
    ),
  );
  return distance(point, {
    x: segmentStart.x + dx * t,
    y: segmentStart.y + dy * t,
  });
}

function sampledPathDistance(first: Point[], second: Point[]) {
  let closest = Number.POSITIVE_INFINITY;
  for (const point of first.slice(1, -1)) {
    for (let index = 0; index < second.length - 1; index += 1) {
      closest = Math.min(closest, pointToSegmentDistance(point, second[index], second[index + 1]));
    }
  }
  return closest;
}

function sampledPathsIntersect(first: Point[], second: Point[]) {
  for (let firstIndex = 0; firstIndex < first.length - 1; firstIndex += 1) {
    for (let secondIndex = 0; secondIndex < second.length - 1; secondIndex += 1) {
      if (
        segmentsIntersect(
          first[firstIndex],
          first[firstIndex + 1],
          second[secondIndex],
          second[secondIndex + 1],
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function routeAutoSourceLinks(
  links: Array<{ end: Point; id: string; start: Point }>,
): Map<string, AutoSourceLinkRoute> {
  const routes = new Map<string, AutoSourceLinkRoute>();
  const placed: Array<{ points: Point[]; route: AutoSourceLinkRoute }> = [];
  const candidates = [
    { direction: 1, offsetScale: 0.85 },
    { direction: -1, offsetScale: 0.85 },
    { direction: 1, offsetScale: 1.15 },
    { direction: -1, offsetScale: 1.15 },
    { direction: 1, offsetScale: 0.55 },
    { direction: -1, offsetScale: 0.55 },
    { direction: 1, offsetScale: 1.45 },
    { direction: -1, offsetScale: 1.45 },
  ];

  [...links]
    .sort((first, second) => distance(second.start, second.end) - distance(first.start, first.end))
    .forEach((link) => {
      const best = candidates
        .map((candidate) => {
          const control = sourceArcControl(link.start, link.end, candidate);
          const points = sourceArcSamplePoints(link.start, control, link.end, 18);
          const score = placed.reduce((sum, existing) => {
            const crossingPenalty = sampledPathsIntersect(points, existing.points) ? 500 : 0;
            const proximity = sampledPathDistance(points, existing.points);
            const proximityPenalty = proximity < 24 ? 24 - proximity : 0;
            const sharedEndpointPenalty =
              distance(link.start, existing.route.start) < 1 ||
              distance(link.end, existing.route.end) < 1 ||
              distance(link.start, existing.route.end) < 1 ||
              distance(link.end, existing.route.start) < 1
                ? 8
                : 0;
            return sum + crossingPenalty + proximityPenalty + sharedEndpointPenalty;
          }, candidate.offsetScale * 0.2);
          return { control, points, score };
        })
        .sort((first, second) => first.score - second.score)[0];
      const route = {
        arcPixels: sourceArcPixels(link.start, link.end, best.control),
        control: best.control,
        end: link.end,
        id: link.id,
        start: link.start,
      };
      routes.set(link.id, route);
      placed.push({ points: best.points, route });
    });

  return routes;
}

function samePoint(first: Point, second: Point) {
  return distance(first, second) < 0.5;
}

function dedupeAdjacentPoints(points: Point[]) {
  return points.filter((point, index) => index === 0 || !samePoint(point, points[index - 1]));
}

function routePointsToEndpoint(route: CableRoute, endpoint: RouteEndpointReference) {
  if (endpoint.branchId) {
    const branch = route.branches?.find((currentBranch) => currentBranch.id === endpoint.branchId);
    return branch ? dedupeAdjacentPoints([...route.points, ...branch.points]) : route.points;
  }
  if (endpoint.pointIndex === 0) return [route.points[0]];
  if (endpoint.pointIndex !== undefined) return route.points.slice(0, endpoint.pointIndex + 1);
  return route.points;
}

function routePathBetweenEndpoints(
  route: CableRoute,
  from: RouteEndpointReference,
  to: RouteEndpointReference,
) {
  const fromPath = routePointsToEndpoint(route, from);
  const toPath = routePointsToEndpoint(route, to);
  let sharedIndex = 0;
  const sharedLength = Math.min(fromPath.length, toPath.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (!samePoint(fromPath[index], toPath[index])) break;
    sharedIndex = index;
  }
  return dedupeAdjacentPoints([
    ...fromPath.slice(sharedIndex).reverse(),
    ...toPath.slice(sharedIndex + 1),
  ]);
}

function endpointForDevice(route: CableRoute, deviceId: string) {
  return routeEndpointReferences(route).find((endpoint) => endpoint.deviceId === deviceId);
}

function preferredPowerSourceEndpoint(route: CableRoute, devicesById: Map<string, Device>) {
  const endpoints = routeEndpointReferences(route);
  return (
    endpoints.find((endpoint) => endpoint.deviceId && devicesById.get(endpoint.deviceId)?.type === "producer") ??
    endpoints.find((endpoint) => endpoint.deviceId && devicesById.get(endpoint.deviceId)?.type === "powerstrip") ??
    endpoints.find((endpoint) => {
      if (!endpoint.deviceId) return true;
      return devicesById.get(endpoint.deviceId)?.type !== "consumer";
    })
  );
}

function nearestRouteEndpoint(route: CableRoute, point: Point) {
  return routeEndpointReferences(route)
    .map((endpoint) => ({ endpoint, distancePx: distance(endpoint.point, point) }))
    .sort((a, b) => a.distancePx - b.distancePx)[0]?.endpoint;
}

function closestSourcePoint(point: Point, source: ConsumerSource) {
  const points = source.targetPoints ?? [source.point];
  return points.sort((a, b) => distance(point, a) - distance(point, b))[0];
}

function powerCableSourcePoints(route: CableRoute, devices: Device[]) {
  return routeEndpointReferences(route)
    .filter((endpoint) => {
      if (!endpoint.deviceId) return true;
      const endpointDevice = devices.find((device) => device.id === endpoint.deviceId);
      return endpointDevice?.type !== "consumer" && endpointDevice?.type !== "switch";
    })
    .map((endpoint) => endpoint.point);
}

function resolveConsumerSource(
  consumer: Device,
  sources: ConsumerSource[],
  pixelsPerMeter: number,
): ResolvedConsumerSource {
  if ((consumer.sourceMode ?? "auto") === "manual") {
    const source = sources.find(
      (candidate) =>
        candidate.id === consumer.sourceId && candidate.type === consumer.sourceType,
    );
    const targetPoint = source ? closestSourcePoint(consumer.point, source) : undefined;
    return {
      consumer,
      source,
      targetPoint,
      distancePx: targetPoint ? distance(consumer.point, targetPoint) : undefined,
      autoAssigned: false,
    };
  }

  if (!pixelsPerMeter) {
    return { consumer, autoAssigned: false };
  }

  const maxDistance = pixelsPerMeter * 1.5;
  const candidates = sources
    .filter(
      (source) =>
        source.type === "powerstrip" ||
        source.type === "producer" ||
        source.type === "powerCable",
    )
    .map((source) => {
      const targetPoint = closestSourcePoint(consumer.point, source);
      return {
        source,
        targetPoint,
        distancePx: targetPoint
          ? distance(consumer.point, targetPoint)
          : Number.POSITIVE_INFINITY,
      };
    })
    .filter((candidate) => Boolean(candidate.targetPoint) && candidate.distancePx <= maxDistance)
    .sort((a, b) => {
      if (a.source.type !== b.source.type) {
        return consumerSourcePriority(a.source) - consumerSourcePriority(b.source);
      }
      return a.distancePx - b.distancePx;
    });

  const closest = candidates[0];
  return {
    consumer,
    source: closest?.source,
    targetPoint: closest?.targetPoint,
    distancePx: closest?.distancePx,
    autoAssigned: Boolean(closest),
  };
}

function resolveDeviceCableAttachment(
  device: Device,
  routes: CableRoute[],
  cableType: CableType,
): DeviceCableAttachment | undefined {
  return resolveDeviceCableAttachments(device, routes, cableType)[0];
}

function resolveDeviceCableAttachments(
  device: Device,
  routes: CableRoute[],
  cableType: CableType,
): DeviceCableAttachment[] {
  return routes
    .filter((route) => route.page === device.page && route.type === cableType)
    .flatMap((route) =>
      routeEndpointReferences(route)
        .filter((endpoint) => endpoint.deviceId === device.id)
        .map((endpoint) => ({
          device,
          route,
          targetPoint: endpoint.point,
          distancePx: distance(device.point, endpoint.point),
        })),
    )
    .sort((a, b) => a.distancePx - b.distancePx);
}

function upstreamProducerIdForPowerRoute(
  route: CableRoute,
  devicesById: Map<string, Device>,
  routes: CableRoute[],
  visitedRouteIds = new Set<string>(),
  visitedPowerstripIds = new Set<string>(),
): string | undefined {
  if (visitedRouteIds.has(route.id)) return undefined;
  const nextVisitedRouteIds = new Set(visitedRouteIds);
  nextVisitedRouteIds.add(route.id);

  const endpoints = routeEndpointReferences(route);
  const directProducerEndpoint = endpoints.find(
    (endpoint) =>
      endpoint.deviceId && devicesById.get(endpoint.deviceId)?.type === "producer",
  );
  if (directProducerEndpoint?.deviceId) return directProducerEndpoint.deviceId;

  for (const endpoint of endpoints) {
    if (!endpoint.deviceId) continue;
    if (devicesById.get(endpoint.deviceId)?.type !== "powerstrip") continue;
    const producerId = upstreamProducerIdForPowerstrip(
      endpoint.deviceId,
      devicesById,
      routes,
      nextVisitedRouteIds,
      visitedPowerstripIds,
    );
    if (producerId) return producerId;
  }

  return undefined;
}

function upstreamProducerIdForPowerstrip(
  powerstripId: string,
  devicesById: Map<string, Device>,
  routes: CableRoute[],
  visitedRouteIds = new Set<string>(),
  visitedPowerstripIds = new Set<string>(),
): string | undefined {
  if (visitedPowerstripIds.has(powerstripId)) return undefined;
  const nextVisitedPowerstripIds = new Set(visitedPowerstripIds);
  nextVisitedPowerstripIds.add(powerstripId);

  const attachedRoutes = routes.filter(
    (route) =>
      route.type === "power" &&
      routeEndpointReferences(route).some(
        (endpoint) => endpoint.deviceId === powerstripId,
      ),
  );

  for (const route of attachedRoutes) {
    const producerEndpoint = routeEndpointReferences(route).find(
      (endpoint) =>
        endpoint.deviceId && devicesById.get(endpoint.deviceId)?.type === "producer",
    );
    if (producerEndpoint?.deviceId) return producerEndpoint.deviceId;
  }

  for (const route of attachedRoutes) {
    const producerId = upstreamProducerIdForPowerRoute(
      route,
      devicesById,
      routes,
      visitedRouteIds,
      nextVisitedPowerstripIds,
    );
    if (producerId) return producerId;
  }

  return undefined;
}

function upstreamEndpointForPowerRoute(
  route: CableRoute,
  targetDeviceId: string,
  devicesById: Map<string, Device>,
  routes: CableRoute[],
) {
  const endpoints = routeEndpointReferences(route);
  const targetEndpoint = endpoints.find((endpoint) => endpoint.deviceId === targetDeviceId);
  if (!targetEndpoint) return undefined;
  const candidateEndpoints = endpoints.filter(
    (endpoint) => endpoint.deviceId !== targetDeviceId,
  );
  const producerEndpoint = candidateEndpoints.find(
    (endpoint) =>
      endpoint.deviceId && devicesById.get(endpoint.deviceId)?.type === "producer",
  );
  if (producerEndpoint) return producerEndpoint;
  return candidateEndpoints.find((endpoint) => {
    if (!endpoint.deviceId) return true;
    if (devicesById.get(endpoint.deviceId)?.type !== "powerstrip") return false;
    return Boolean(
      upstreamProducerIdForPowerstrip(
        endpoint.deviceId,
        devicesById,
        routes,
        new Set([route.id]),
        new Set([targetDeviceId]),
      ),
    );
  });
}

function upstreamPowerPathPixelsToEndpoint(
  endpoint: RouteEndpointReference,
  devicesById: Map<string, Device>,
  routes: CableRoute[],
  visitedDeviceIds = new Set<string>(),
  visitedRouteIds = new Set<string>(),
): number | undefined {
  if (!endpoint.deviceId) return 0;
  const device = devicesById.get(endpoint.deviceId);
  if (!device) return undefined;
  if (device.type === "producer") return 0;
  return upstreamPowerPathPixelsToDevice(
    endpoint.deviceId,
    devicesById,
    routes,
    visitedDeviceIds,
    visitedRouteIds,
  );
}

function upstreamPowerPathPixelsToRouteEndpoint(
  route: CableRoute,
  targetEndpoint: RouteEndpointReference,
  devicesById: Map<string, Device>,
  routes: CableRoute[],
) {
  const endpointDevice = targetEndpoint.deviceId
    ? devicesById.get(targetEndpoint.deviceId)
    : undefined;
  if (endpointDevice?.type === "producer") return 0;
  if (endpointDevice?.type === "powerstrip") {
    return upstreamPowerPathPixelsToDevice(targetEndpoint.deviceId as string, devicesById, routes);
  }

  const sourceEndpoint = preferredPowerSourceEndpoint(route, devicesById);
  if (!sourceEndpoint) return undefined;
  const sourcePixels = upstreamPowerPathPixelsToEndpoint(sourceEndpoint, devicesById, routes);
  if (sourcePixels === undefined) return undefined;
  return sourcePixels + routePixels(routePathBetweenEndpoints(route, sourceEndpoint, targetEndpoint));
}

function upstreamPowerPathPixelsToDevice(
  deviceId: string,
  devicesById: Map<string, Device>,
  routes: CableRoute[],
  visitedDeviceIds = new Set<string>(),
  visitedRouteIds = new Set<string>(),
): number | undefined {
  if (visitedDeviceIds.has(deviceId)) return undefined;
  const device = devicesById.get(deviceId);
  if (!device) return undefined;
  if (device.type === "producer") return 0;

  const nextVisitedDeviceIds = new Set(visitedDeviceIds);
  nextVisitedDeviceIds.add(deviceId);
  const candidates = resolveDeviceCableAttachments(device, routes, "power")
    .map((attachment) => {
      if (visitedRouteIds.has(attachment.route.id)) return undefined;
      const sourceEndpoint = upstreamEndpointForPowerRoute(
        attachment.route,
        deviceId,
        devicesById,
        routes,
      );
      const targetEndpoint = endpointForDevice(attachment.route, deviceId);
      if (!sourceEndpoint || !targetEndpoint) return undefined;
      const nextVisitedRouteIds = new Set(visitedRouteIds);
      nextVisitedRouteIds.add(attachment.route.id);
      const sourcePixels = upstreamPowerPathPixelsToEndpoint(
        sourceEndpoint,
        devicesById,
        routes,
        nextVisitedDeviceIds,
        nextVisitedRouteIds,
      );
      if (sourcePixels === undefined) return undefined;
      return {
        pixels:
          sourcePixels +
          routePixels(
            routePathBetweenEndpoints(attachment.route, sourceEndpoint, targetEndpoint),
          ),
        reliableSource: Boolean(sourceEndpoint.deviceId),
      };
    })
    .filter((candidate): candidate is { pixels: number; reliableSource: boolean } =>
      Boolean(candidate),
    );
  const reliableCandidates = candidates.filter((candidate) => candidate.reliableSource);
  if (reliableCandidates.length > 0) {
    return reliableCandidates.sort((a, b) => a.pixels - b.pixels)[0].pixels;
  }
  if (device.type === "powerstrip" && candidates.length > 0) {
    return candidates.sort((a, b) => b.pixels - a.pixels)[0].pixels;
  }
  return candidates.sort((a, b) => a.pixels - b.pixels)[0]?.pixels;
}

function closestCompatibleDeviceForCablePoint(
  point: Point,
  route: CableRoute,
  devices: Device[],
  pixelsPerMeter: number,
  excludedDeviceIds: Set<string> = new Set(),
  endpoint?: DraggingCablePoint,
) {
  const maxDistance = pixelsPerMeter ? pixelsPerMeter * 1.5 : 48;
  return devices
    .filter(
      (device) =>
        device.page === route.page &&
        canAttachEndpointToDevice(route, endpoint, device, devices) &&
        !excludedDeviceIds.has(device.id),
    )
    .map((device) => ({
      device,
      distancePx: distance(device.point, point),
    }))
    .filter((candidate) => candidate.distancePx <= maxDistance)
    .sort((a, b) => a.distancePx - b.distancePx)[0]?.device;
}

function attachedCablePointsForDevice(device: Device, routes: CableRoute[]): AttachedCablePoint[] {
  return routes
    .filter((route) => route.page === device.page && route.points.length > 0)
    .flatMap((route) =>
      routeEndpointReferences(route)
        .filter((endpoint) => endpoint.deviceId === device.id)
        .map((endpoint) => ({
          routeId: route.id,
          pointIndex: endpoint.pointIndex,
          branchId: endpoint.branchId,
          branchPointIndex: endpoint.branchPointIndex,
          startPoint: endpoint.point,
        })),
    );
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

async function dataUrlToBytes(dataUrl: string) {
  const response = await fetch(dataUrl);
  return new Uint8Array(await response.arrayBuffer());
}

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function cloneCableRoute(route: CableRoute): CableRoute {
  return {
    ...route,
    points: route.points.map(clonePoint),
    branches: route.branches?.map((branch) => ({
      ...branch,
      points: branch.points.map(clonePoint),
    })),
    endpointDeviceIds: route.endpointDeviceIds
      ? {
          ...route.endpointDeviceIds,
          branches: route.endpointDeviceIds.branches
            ? { ...route.endpointDeviceIds.branches }
            : undefined,
        }
      : undefined,
  };
}

function cloneProject(project: PersistedProject): PersistedProject {
  return {
    ...project,
    pageSize: { ...project.pageSize },
    calibration: project.calibration
      ? {
          start: clonePoint(project.calibration.start),
          end: clonePoint(project.calibration.end),
        }
      : undefined,
    cables: project.cables.map(cloneCableRoute),
    devices: project.devices.map((device) => ({
      ...device,
      point: clonePoint(device.point),
    })),
    viewPosition: { ...project.viewPosition },
  };
}

function cloneUndoSnapshot(snapshot: UndoSnapshot): UndoSnapshot {
  return {
    ...cloneProject(snapshot),
    routeDraft: snapshot.routeDraft.map(clonePoint),
    routeDraftDeviceIds: [...snapshot.routeDraftDeviceIds],
    scaleDraft: snapshot.scaleDraft ? clonePoint(snapshot.scaleDraft) : null,
    selectedId: snapshot.selectedId,
    selectedCablePoint: snapshot.selectedCablePoint
      ? { ...snapshot.selectedCablePoint }
      : null,
  };
}

function undoSnapshotKey(snapshot: UndoSnapshot) {
  return JSON.stringify({
    ...snapshot,
    pdfDataUrl: undefined,
    pageCount: undefined,
    pageSize: undefined,
    viewPosition: undefined,
    selectedId: undefined,
    selectedCablePoint: undefined,
  });
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const projectLoadInputRef = useRef<HTMLInputElement | null>(null);
  const planScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingViewPositionRef = useRef<ViewPosition | null>(null);
  const spacePanDragRef = useRef<SpacePanDrag | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfName, setPdfName] = useState("");
  const [pdfDataUrl, setPdfDataUrl] = useState<string>();
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [pageSize, setPageSize] = useState({ width: 840, height: 640 });
  const [zoom, setZoom] = useState(1.1);
  const [floorPlanOpacity, setFloorPlanOpacity] = useState(1);
  const [animateOrphans, setAnimateOrphans] = useState(true);
  const [electricalColorMode, setElectricalColorMode] =
    useState<ElectricalColorMode>("length");
  const [rendering, setRendering] = useState(false);
  const [mode, setMode] = useState<Mode>("scale");
  const [activeCable, setActiveCable] = useState<CableType>("ethernet");
  const [activeDevice, setActiveDevice] = useState<DeviceType>("powerstrip");
  const [hoveredCableType, setHoveredCableType] = useState<CableType | null>(null);
  const [knownDistance, setKnownDistance] = useState("10");
  const [calibration, setCalibration] = useState<{ start: Point; end: Point }>();
  const [scaleDraft, setScaleDraft] = useState<Point | null>(null);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [measurementDraft, setMeasurementDraft] = useState<Measurement | null>(null);
  const [routeDraft, setRouteDraft] = useState<Point[]>([]);
  const [routeDraftDeviceIds, setRouteDraftDeviceIds] = useState<Array<string | undefined>>([]);
  const [cursorPoint, setCursorPoint] = useState<Point | null>(null);
  const [cables, setCables] = useState<CableRoute[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [draggingDevice, setDraggingDevice] = useState<DraggingDevice | null>(null);
  const [draggingCablePoint, setDraggingCablePoint] = useState<DraggingCablePoint | null>(null);
  const [selectedCablePoint, setSelectedCablePoint] = useState<SelectedCablePoint | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
  const [copiedDevice, setCopiedDevice] = useState<Device | null>(null);
  const [poppedDeviceId, setPoppedDeviceId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [storageNotice, setStorageNotice] = useState("");
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isPanningWithSpace, setIsPanningWithSpace] = useState(false);
  const [viewPosition, setViewPosition] = useState<ViewPosition>(defaultViewPosition);
  const undoHistoryRef = useRef<UndoSnapshot[]>([]);
  const lastUndoSnapshotRef = useRef<UndoSnapshot | null>(null);
  const lastUndoSnapshotKeyRef = useRef("");
  const applyingUndoRef = useRef(false);
  const undoGroupActiveRef = useRef(false);
  const undoGroupStartSnapshotRef = useRef<UndoSnapshot | null>(null);
  const undoGroupStartKeyRef = useRef("");
  const cableDraftContextRef = useRef({ activeCable, pageNumber });

  const scalePixels = calibration ? distance(calibration.start, calibration.end) : 0;
  const knownDistanceM = Number(knownDistance);
  const viewScale = pdfDoc ? zoom : 1;
  const modelPageSize = {
    width: pageSize.width / viewScale,
    height: pageSize.height / viewScale,
  };
  const toDisplayPoint = (point: Point) => scalePoint(point, viewScale);
  const toDisplayPoints = (points: Point[]) => scalePoints(points, viewScale);
  const pixelsPerMeter =
    scalePixels > 0 && Number.isFinite(knownDistanceM) && knownDistanceM > 0
      ? scalePixels / knownDistanceM
      : 0;

  function queueViewPositionRestore(position?: ViewPosition) {
    const nextPosition = position ?? defaultViewPosition;
    pendingViewPositionRef.current = nextPosition;
    setViewPosition(nextPosition);
  }

  useEffect(() => {
    let cancelled = false;

    async function restoreProject() {
      const stored = localStorage.getItem(storageKey);
      if (!stored) {
        setHydrated(true);
        return;
      }

      try {
        const project = JSON.parse(stored) as PersistedProject;
        if (project.version !== 1) {
          setHydrated(true);
          return;
        }

        setPdfName(project.pdfName || "");
        setPdfDataUrl(project.pdfDataUrl);
        setPageNumber(project.pageNumber || 1);
        setPageCount(project.pageCount || 0);
        setPageSize(project.pageSize || { width: 840, height: 640 });
        setZoom(project.zoom || 1.1);
        setFloorPlanOpacity(project.floorPlanOpacity ?? 1);
        setAnimateOrphans(project.animateOrphans ?? true);
        setElectricalColorMode(project.electricalColorMode ?? "length");
        setMode(project.mode || "scale");
        setActiveCable(project.activeCable || "ethernet");
        setActiveDevice(project.activeDevice || "powerstrip");
        setKnownDistance(project.knownDistance || "10");
        setCalibration(project.calibration);
        setCables(project.cables || []);
        setDevices(project.devices || []);
        queueViewPositionRestore(project.viewPosition);

        if (project.pdfDataUrl) {
          try {
            const document = await pdfjsLib.getDocument({
              data: await dataUrlToBytes(project.pdfDataUrl),
            }).promise;
            if (!cancelled) {
              setPdfDoc(document);
              setPageCount(document.numPages);
              setPageNumber((page) => Math.min(Math.max(page, 1), document.numPages));
            }
          } catch {
            if (!cancelled) {
              setStorageNotice("Project restored, but the saved PDF could not be reopened.");
            }
          }
        }
      } catch {
        setStorageNotice("Saved project data could not be restored.");
      } finally {
        if (!cancelled) setHydrated(true);
      }
    }

    restoreProject();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;

    const project: PersistedProject = {
      version: 1,
      pdfName,
      pdfDataUrl,
      pageNumber,
      pageCount,
      pageSize,
      zoom,
      floorPlanOpacity,
      animateOrphans,
      electricalColorMode,
      mode,
      activeCable,
      activeDevice,
      knownDistance,
      calibration,
      cables,
      devices,
      viewPosition,
    };

    try {
      localStorage.setItem(storageKey, JSON.stringify(project));
      setStorageNotice((notice) => (notice.startsWith("Autosaved") ? "" : notice));
    } catch {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ ...project, pdfDataUrl: undefined }));
        setStorageNotice(
          "Autosaved routes and devices. The PDF is too large for localStorage, so re-upload it after reload.",
        );
      } catch {
        setStorageNotice("Autosave failed because browser storage is full.");
      }
    }
  }, [
    activeCable,
    activeDevice,
    animateOrphans,
    cables,
    calibration,
    devices,
    electricalColorMode,
    floorPlanOpacity,
    hydrated,
    knownDistance,
    mode,
    pageCount,
    pageNumber,
    pageSize,
    pdfDataUrl,
    pdfName,
    viewPosition,
    zoom,
  ]);

  useEffect(() => {
    if (!hydrated || !pendingViewPositionRef.current) return;
    const element = planScrollRef.current;
    if (!element) return;
    const position = pendingViewPositionRef.current;

    const frameId = window.requestAnimationFrame(() => {
      element.scrollLeft = position.scrollLeft;
      element.scrollTop = position.scrollTop;
      pendingViewPositionRef.current = null;
      setViewPosition({
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [hydrated, pageSize.height, pageSize.width, pdfDoc, zoom]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let renderTask:
      | {
          cancel: () => void;
          promise: Promise<unknown>;
        }
      | undefined;
    async function renderPage(page: PDFPageProxy) {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const pixelRatio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: zoom });
      const context = canvas.getContext("2d");
      if (!context) return;
      if (cancelled) return;
      setPageSize({ width: viewport.width, height: viewport.height });
      canvas.width = Math.ceil(viewport.width * pixelRatio);
      canvas.height = Math.ceil(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, viewport.width, viewport.height);
      setRendering(true);
      renderTask = page.render({ canvasContext: context, viewport });
      try {
        await renderTask.promise;
      } catch (error) {
        if (!cancelled) {
          throw error;
        }
      }
      if (!cancelled) setRendering(false);
    }

    if (!pdfDoc) return;
    pdfDoc.getPage(pageNumber).then((page) => {
      if (cancelled) return undefined;
      return renderPage(page);
    }).catch(() => {
      if (!cancelled) setRendering(false);
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pageNumber, pdfDoc, zoom]);

  useEffect(() => {
    if (!poppedDeviceId) return undefined;
    const timeoutId = window.setTimeout(() => setPoppedDeviceId(null), 240);
    return () => window.clearTimeout(timeoutId);
  }, [poppedDeviceId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isTyping = isTextEditingTarget(event.target);
      if (event.key === "Shift") {
        setIsShiftPressed(true);
      }
      if (!isTyping && event.code === "Space") {
        event.preventDefault();
        setIsSpacePressed(true);
        return;
      }
      if (isTyping) return;
      if (event.key === "Enter" && routeDraft.length > 1) {
        finishRoute();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        const device =
          selectedDeviceIds.length === 1
            ? devices.find((currentDevice) => currentDevice.id === selectedDeviceIds[0])
            : undefined;
        if (device) {
          event.preventDefault();
          setCopiedDevice(device);
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
        const device = copiedDevice ?? devices.find((currentDevice) => currentDevice.id === selectedId);
        if (device) {
          event.preventDefault();
          pasteDevice(device);
        }
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        const shortcutKey = event.key.toLowerCase();
        if (shortcutKey === "v") {
          event.preventDefault();
          setMode("select");
          return;
        }
        if (shortcutKey === "m") {
          event.preventDefault();
          setMode("measure");
          return;
        }
        if (shortcutKey === "c") {
          event.preventDefault();
          setMode("cable");
          if (!event.repeat) {
            setActiveCable((currentCable) => nextOption(cableTypeOrder, currentCable));
          }
          return;
        }
        if (shortcutKey === "d") {
          event.preventDefault();
          setMode("device");
          if (!event.repeat) {
            setActiveDevice((currentDevice) => nextOption(deviceTypeOrder, currentDevice));
          }
          return;
        }
      }
      if (
        (event.key === "Backspace" || event.key === "Delete") &&
        selectedCablePoint
      ) {
        event.preventDefault();
        if (removeSelectedCablePoint()) {
          return;
        }
      }
      if (event.key === "Backspace" && mode === "cable" && routeDraft.length > 0) {
        event.preventDefault();
        setRouteDraft((current) => current.slice(0, -1));
        setRouteDraftDeviceIds((current) => current.slice(0, -1));
        setCursorPoint(null);
        return;
      }
      if (
        (event.key === "Backspace" || event.key === "Delete") &&
        (selectedDeviceIds.length > 0 ||
          devices.some((device) => device.id === selectedId) ||
          cables.some((route) => route.id === selectedId))
      ) {
        event.preventDefault();
        deleteSelected();
        return;
      }
      if (event.key === "Escape") {
        setRouteDraft([]);
        setRouteDraftDeviceIds([]);
        setScaleDraft(null);
        setMeasurements([]);
        setMeasurementDraft(null);
        setCursorPoint(null);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoLast();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        setIsShiftPressed(false);
      }
      if (event.code === "Space") {
        setIsSpacePressed(false);
      }
    };
    const onWindowBlur = () => {
      setIsShiftPressed(false);
      setIsSpacePressed(false);
      setIsPanningWithSpace(false);
      spacePanDragRef.current = null;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  });

  useEffect(() => {
    if (mode === "cable") return;
    if (routeDraft.length === 0 && routeDraftDeviceIds.length === 0 && !cursorPoint) return;
    setRouteDraft([]);
    setRouteDraftDeviceIds([]);
    setCursorPoint(null);
  }, [cursorPoint, mode, routeDraft.length, routeDraftDeviceIds.length]);

  useEffect(() => {
    if (mode === "measure") return;
    if (measurements.length === 0 && !measurementDraft) return;
    setMeasurements([]);
    setMeasurementDraft(null);
  }, [measurementDraft, measurements.length, mode]);

  useEffect(() => {
    const previousContext = cableDraftContextRef.current;
    const contextChanged =
      previousContext.activeCable !== activeCable ||
      previousContext.pageNumber !== pageNumber;
    cableDraftContextRef.current = { activeCable, pageNumber };
    if (!contextChanged) return;
    if (routeDraft.length === 0 && routeDraftDeviceIds.length === 0 && !cursorPoint) return;
    setRouteDraft([]);
    setRouteDraftDeviceIds([]);
    setCursorPoint(null);
  }, [activeCable, cursorPoint, pageNumber, routeDraft.length, routeDraftDeviceIds.length]);

  const planningMode = mode === "cable" || mode === "device";
  const currentCables = cables.filter((route) => route.page === pageNumber);
  const hoveredPlanCableType = planningMode ? hoveredCableType : null;
  const visiblePlanCables = hoveredPlanCableType
    ? currentCables.filter((route) => route.type === hoveredPlanCableType)
    : currentCables;
  const currentDevices = devices.filter((device) => device.page === pageNumber);
  const selectedDevices = selectedDeviceIds
    .map((deviceId) => devices.find((device) => device.id === deviceId))
    .filter((device): device is Device => Boolean(device));
  const selectedDevice = selectedDevices.length === 1 ? selectedDevices[0] : undefined;
  const selectedDeviceCount = selectedDevices.length;
  const selectedCommonDeviceType =
    selectedDevices.length > 0 && selectedDevices.every((device) => device.type === selectedDevices[0].type)
      ? selectedDevices[0].type
      : undefined;
  const selectedCommonPage =
    selectedDevices.length > 0 && selectedDevices.every((device) => device.page === selectedDevices[0].page)
      ? selectedDevices[0].page
      : undefined;
  const selectedDevicesAllHaveSocketCapacity =
    selectedDevices.length > 1 &&
    selectedDevices.every(
      (device) =>
        device.type === "producer" ||
        device.type === "switch",
    );
  const selectedCommonLabelPosition = commonDeviceValue(
    selectedDevices,
    (device) => device.labelPosition ?? "bottom",
  );
  const selectedCommonName = commonDeviceValue(
    selectedDevices,
    (device) => device.name ?? "",
  );
  const selectedCommonDesiredFreeSockets = commonDeviceValue(
    selectedDevices,
    (device) => device.desiredFreeSockets ?? 0,
  );
  const selectedCommonSocketCapacity = commonDeviceValue(
    selectedDevices,
    (device) => socketCapacityForDevice(device),
  );
  const selectedCommonAvailablePowerW = commonDeviceValue(
    selectedDevices,
    (device) => device.availablePowerW ?? 0,
  );
  const selectedCommonRequiredPowerW = commonDeviceValue(
    selectedDevices,
    (device) => device.powerW ?? 0,
  );
  const selectedCommonPoePowerW = commonDeviceValue(
    selectedDevices,
    (device) => device.poePowerW ?? 0,
  );
  const selectedCommonSourceSelection = commonDeviceValue(selectedDevices, (device) => {
    if ((device.sourceMode ?? "auto") === "auto") return "auto";
    if (device.sourceType && device.sourceId) {
      return sourceValue({ type: device.sourceType, id: device.sourceId });
    }
    return "none";
  });
  const producers = devices.filter((device) => device.type === "producer");
  const consumers = devices.filter((device) => device.type === "consumer");
  const switches = devices.filter((device) => device.type === "switch");
  const ethernetClients = devices.filter((device) => device.type === "ethernetClient");
  const powerLoadDevices = useMemo(
    () => devices.filter((device) => device.type === "consumer" || device.type === "switch"),
    [devices],
  );
  const devicesById = useMemo(
    () => new Map(devices.map((device) => [device.id, device])),
    [devices],
  );
  const directPowerConsumerAttachments = useMemo(
    () =>
      powerLoadDevices.map((consumer) => ({
        consumer,
        attachments: resolveDeviceCableAttachments(consumer, cables, "power"),
      })),
    [cables, powerLoadDevices],
  );
  const directlyPoweredConsumerIds = useMemo(
    () =>
      new Set(
        directPowerConsumerAttachments
          .filter((assignment) => assignment.attachments.length > 0)
          .map((assignment) => assignment.consumer.id),
      ),
    [directPowerConsumerAttachments],
  );
  const powerSources = useMemo<ConsumerSource[]>(() => {
    const producerSources = devices
      .filter((device) => device.type === "producer")
      .map((producer, index) => ({
        id: producer.id,
        type: "producer" as const,
        label: producer.name || `Power source ${index + 1}`,
        page: producer.page,
        point: producer.point,
      }));
    const powerstripSources = devices
      .filter((device) => device.type === "powerstrip")
      .map((powerstrip, index) => ({
        id: powerstrip.id,
        type: "powerstrip" as const,
        label: powerstrip.name || `Powerstrip ${index + 1}`,
        page: powerstrip.page,
        point: powerstrip.point,
      }));
    const cableSources = cables
      .filter((route) => route.type === "power")
      .flatMap((route, index) => {
        const targetPoints = powerCableSourcePoints(route, devices);
        if (targetPoints.length === 0) return [];
        return [{
          id: route.id,
          type: "powerCable" as const,
          label: `Electrical ${index + 1}`,
          page: route.page,
          point: routeMidpoint(targetPoints),
          route,
          targetPoints,
        }];
      });
    return [...powerstripSources, ...producerSources, ...cableSources];
  }, [cables, devices]);
  const consumerSourceAssignments = useMemo(
    () =>
      consumers.map((consumer) =>
        directlyPoweredConsumerIds.has(consumer.id)
          ? { consumer, autoAssigned: false }
          : resolveConsumerSource(
              consumer,
              powerSources.filter((source) => source.page === consumer.page),
              pixelsPerMeter,
            ),
      ),
    [consumers, directlyPoweredConsumerIds, pixelsPerMeter, powerSources],
  );
  const powerstripSourceAssignments = useMemo(
    () =>
      devices
        .filter((device) => device.type === "powerstrip")
        .map((powerstrip) =>
          upstreamProducerIdForPowerstrip(powerstrip.id, devicesById, cables)
            ? { consumer: powerstrip, autoAssigned: false }
            : resolveConsumerSource(
                powerstrip,
                powerSources.filter(
                  (source) =>
                    source.page === powerstrip.page &&
                    !(source.type === "powerstrip" && source.id === powerstrip.id),
                ),
                pixelsPerMeter,
              ),
        ),
    [cables, devices, devicesById, pixelsPerMeter, powerSources],
  );
  const producerIdForPowerstripWithAuto = useCallback(function resolveProducerIdForPowerstripWithAuto(
    powerstripId: string,
    visitedPowerstripIds = new Set<string>(),
  ): string | undefined {
    if (visitedPowerstripIds.has(powerstripId)) return undefined;
    const directProducerId = upstreamProducerIdForPowerstrip(powerstripId, devicesById, cables);
    if (directProducerId) return directProducerId;
    const nextVisitedPowerstripIds = new Set(visitedPowerstripIds);
    nextVisitedPowerstripIds.add(powerstripId);
    const assignment = powerstripSourceAssignments.find(
      (assignment) => assignment.consumer.id === powerstripId,
    );
    const source = assignment?.source;
    if (!source) return undefined;
    if (source.type === "producer") return source.id;
    if (source.type === "powerstrip") {
      return resolveProducerIdForPowerstripWithAuto(source.id, nextVisitedPowerstripIds);
    }
    return source.route
      ? upstreamProducerIdForPowerRoute(source.route, devicesById, cables)
      : undefined;
  }, [cables, devicesById, powerstripSourceAssignments]);
  const powerPathPixelsToPowerstripWithAuto = useCallback(function resolvePowerPathPixelsToPowerstripWithAuto(
    powerstripId: string,
    visitedPowerstripIds = new Set<string>(),
  ): number | undefined {
    if (visitedPowerstripIds.has(powerstripId)) return undefined;
    const directPixels = upstreamPowerPathPixelsToDevice(powerstripId, devicesById, cables);
    if (directPixels !== undefined) return directPixels;
    const powerstrip = devicesById.get(powerstripId);
    if (!powerstrip) return undefined;
    const assignment = powerstripSourceAssignments.find(
      (assignment) => assignment.consumer.id === powerstripId,
    );
    const source = assignment?.source;
    if (!source) return undefined;
    const nextVisitedPowerstripIds = new Set(visitedPowerstripIds);
    nextVisitedPowerstripIds.add(powerstripId);
    if (source.type === "producer") {
      return sourceArcPixels(source.point, powerstrip.point);
    }
    if (source.type === "powerstrip") {
      const sourcePixels = resolvePowerPathPixelsToPowerstripWithAuto(
        source.id,
        nextVisitedPowerstripIds,
      );
      return sourcePixels === undefined
        ? undefined
        : sourcePixels + sourceArcPixels(source.point, powerstrip.point);
    }
    if (source.route) {
      const targetPoint = assignment?.targetPoint ?? source.point;
      const targetEndpoint = nearestRouteEndpoint(source.route, targetPoint);
      const sourcePixels = targetEndpoint
        ? upstreamPowerPathPixelsToRouteEndpoint(source.route, targetEndpoint, devicesById, cables)
        : undefined;
      return sourcePixels === undefined
        ? undefined
        : sourcePixels + sourceArcPixels(targetPoint, powerstrip.point);
    }
    return undefined;
  }, [cables, devicesById, powerstripSourceAssignments]);
  const selectedConsumerAssignment =
    selectedDevice?.type === "consumer"
      ? consumerSourceAssignments.find(
          (assignment) => assignment.consumer.id === selectedDevice.id,
        )
      : undefined;
  const selectedConsumerHasDirectPower =
    selectedDevice?.type === "consumer" && directlyPoweredConsumerIds.has(selectedDevice.id);
  const currentConsumerSourceAssignments = consumerSourceAssignments.filter(
    (assignment) => assignment.consumer.page === pageNumber,
  );
  const currentPowerstripSourceAssignments = powerstripSourceAssignments.filter(
    (assignment) => assignment.consumer.page === pageNumber,
  );
  const ethernetSwitchAttachments = useMemo(
    () =>
      devices
        .filter((device) => device.type === "switch")
        .flatMap((device) =>
          resolveDeviceCableAttachments(device, cables, "ethernet"),
        ),
    [cables, devices],
  );
  const ethernetClientAttachments = useMemo(
    () =>
      ethernetClients
        .map((device) => resolveDeviceCableAttachment(device, cables, "ethernet"))
        .filter((attachment): attachment is DeviceCableAttachment => Boolean(attachment)),
    [cables, ethernetClients],
  );
  const ethernetClientSwitchAssignments = useMemo(
    () =>
      ethernetClientAttachments.flatMap((clientAttachment) => {
        const switchAttachment = ethernetSwitchAttachments
          .filter(
            (attachment) =>
              attachment.route.id === clientAttachment.route.id &&
              attachment.device.page === clientAttachment.device.page,
          )
          .sort((a, b) => a.distancePx - b.distancePx)[0];
        if (!switchAttachment) return [];
        return [{
          client: clientAttachment.device,
          clientAttachment,
          switchDevice: switchAttachment.device,
          switchAttachment,
        }];
      }),
    [ethernetClientAttachments, ethernetSwitchAttachments],
  );
  const ethernetSwitchPoeStats = useMemo(
    () =>
      devices
        .filter((device) => device.type === "switch")
        .map((switchDevice) => {
          const assignments = ethernetClientSwitchAssignments.filter(
            (assignment) => assignment.switchDevice?.id === switchDevice.id,
          );
          const poeLoadW = assignments.reduce(
            (sum, assignment) => sum + (assignment.client.poePowerW ?? 0),
            0,
          );
          const ownPowerW = switchDevice.powerW ?? 0;
          return {
            switchId: switchDevice.id,
            name: switchDevice.name || "Ethernet switch",
            cableCount: ethernetSwitchAttachments.filter(
              (attachment) => attachment.device.id === switchDevice.id,
            ).length,
            clientCount: assignments.length,
            ownPowerW,
            poeLoadW,
            totalRequiredPowerW: ownPowerW + poeLoadW,
            socketCapacity: socketCapacityForDevice(switchDevice),
          };
        }),
    [devices, ethernetClientSwitchAssignments, ethernetSwitchAttachments],
  );
  const selectedEthernetClientAssignment =
    selectedDevice?.type === "ethernetClient"
      ? ethernetClientSwitchAssignments.find(
          (assignment) => assignment.client.id === selectedDevice.id,
        )
      : undefined;
  const selectedSwitchPoeStats =
    selectedDevice?.type === "switch"
      ? ethernetSwitchPoeStats.find((stats) => stats.switchId === selectedDevice.id)
      : undefined;
  const selectedSwitchCableCount = selectedSwitchPoeStats?.cableCount ?? 0;
  const selectedSwitchSocketCapacity =
    selectedDevice?.type === "switch" ? socketCapacityForDevice(selectedDevice) : 0;
  const selectedSwitchOverSockets =
    selectedDevice?.type === "switch" &&
    selectedSwitchSocketCapacity > 0 &&
    selectedSwitchCableCount > selectedSwitchSocketCapacity;
  const switchRequiredPowerW = useCallback(
    (switchDevice: Device) =>
      ethernetSwitchPoeStats.find((stats) => stats.switchId === switchDevice.id)
        ?.totalRequiredPowerW ??
      switchDevice.powerW ??
      0,
    [ethernetSwitchPoeStats],
  );
  const powerLoadWattsForDevice = useCallback(
    (device: Device) => {
      if (device.type === "switch") return switchRequiredPowerW(device);
      if (device.type === "consumer") return device.powerW ?? 0;
      return 0;
    },
    [switchRequiredPowerW],
  );
  const currentEthernetAttachments = useMemo(
    () =>
      [
        ...ethernetSwitchAttachments,
        ...ethernetClientSwitchAssignments.map((assignment) => assignment.clientAttachment),
      ].filter(
        (attachment) => attachment.device.page === pageNumber,
      ),
    [ethernetClientSwitchAssignments, ethernetSwitchAttachments, pageNumber],
  );
  const producerPowerCableAttachments = useMemo(
    () =>
      producers.map((producer) => ({
        producerId: producer.id,
        attachments: resolveDeviceCableAttachments(producer, cables, "power"),
      })),
    [cables, producers],
  );
  const selectedProducerCableCount =
    selectedDevice?.type === "producer"
      ? (producerPowerCableAttachments.find(
          (producer) => producer.producerId === selectedDevice.id,
        )?.attachments.length ?? 0)
      : 0;
  const selectedProducerSocketCapacity =
    selectedDevice?.type === "producer" ? socketCapacityForDevice(selectedDevice) : 0;
  const selectedProducerOverSockets =
    selectedDevice?.type === "producer" &&
    selectedProducerSocketCapacity > 0 &&
    selectedProducerCableCount > selectedProducerSocketCapacity;
  const powerstripConnectionStats = useMemo(
    () =>
      devices
        .filter((device) => device.type === "powerstrip")
        .map((powerstrip) => {
          const electricalCableCount = resolveDeviceCableAttachments(
            powerstrip,
            cables,
            "power",
          ).length;
          const consumerCount = consumerSourceAssignments.filter(
            (assignment) =>
              assignment.source?.type === "powerstrip" &&
              assignment.source.id === powerstrip.id,
          ).length;
          const childPowerstripCount = powerstripSourceAssignments.filter(
            (assignment) =>
              assignment.source?.type === "powerstrip" &&
              assignment.source.id === powerstrip.id,
          ).length;
          const desiredFreeSockets = Math.max(0, powerstrip.desiredFreeSockets ?? 0);
          const hasAutoFeed = Boolean(
            powerstripSourceAssignments.find(
              (assignment) =>
                assignment.consumer.id === powerstrip.id && Boolean(assignment.source),
            ),
          );
          const feedCableCount = electricalCableCount > 0 || hasAutoFeed ? 1 : 0;
          const outletCableCount = Math.max(0, electricalCableCount - feedCableCount);
          const occupiedSocketCount = outletCableCount + consumerCount + childPowerstripCount;
          const socketCapacity = occupiedSocketCount + desiredFreeSockets;
          const freeSocketCount = desiredFreeSockets;
          return {
            powerstripId: powerstrip.id,
            electricalCableCount,
            feedCableCount,
            outletCableCount,
            consumerCount,
            childPowerstripCount,
            desiredFreeSockets,
            freeSocketCount,
            occupiedSocketCount,
            socketCapacity,
          };
        }),
    [cables, consumerSourceAssignments, devices, powerstripSourceAssignments],
  );
  const selectedPowerstripStats =
    selectedDevice?.type === "powerstrip"
      ? powerstripConnectionStats.find(
          (powerstrip) => powerstrip.powerstripId === selectedDevice.id,
        )
      : undefined;
  const powerstripLoadWattsById = useMemo(() => {
    const loadCache = new Map<string, number>();

    const loadForPowerstrip = (
      powerstripId: string,
      visitedPowerstripIds = new Set<string>(),
    ): number => {
      if (visitedPowerstripIds.has(powerstripId)) return 0;
      if (loadCache.has(powerstripId)) return loadCache.get(powerstripId) ?? 0;

      const nextVisitedPowerstripIds = new Set(visitedPowerstripIds);
      nextVisitedPowerstripIds.add(powerstripId);
      const powerstrip = devicesById.get(powerstripId);
      const countedDeviceIds = new Set<string>();
      let totalW = Math.max(0, powerstrip?.desiredFreeSockets ?? 0) * desiredFreeSocketLoadW;

      const addDeviceLoad = (device: Device) => {
        if (countedDeviceIds.has(device.id)) return;
        countedDeviceIds.add(device.id);
        totalW += powerLoadWattsForDevice(device);
      };

      consumerSourceAssignments.forEach((assignment) => {
        if (
          assignment.source?.type === "powerstrip" &&
          assignment.source.id === powerstripId
        ) {
          addDeviceLoad(assignment.consumer);
        }
      });

      directPowerConsumerAttachments.forEach((assignment) => {
        const isFedByPowerstrip = assignment.attachments.some((attachment) => {
          const sourceEndpoint = upstreamEndpointForPowerRoute(
            attachment.route,
            assignment.consumer.id,
            devicesById,
            cables,
          );
          return sourceEndpoint?.deviceId === powerstripId;
        });
        if (isFedByPowerstrip) addDeviceLoad(assignment.consumer);
      });

      powerstripSourceAssignments.forEach((assignment) => {
        if (
          assignment.source?.type === "powerstrip" &&
          assignment.source.id === powerstripId
        ) {
          totalW += loadForPowerstrip(assignment.consumer.id, nextVisitedPowerstripIds);
        }
      });

      devices
        .filter((device) => device.type === "powerstrip" && device.id !== powerstripId)
        .forEach((childPowerstrip) => {
          const isFedByPowerstrip = resolveDeviceCableAttachments(
            childPowerstrip,
            cables,
            "power",
          ).some((attachment) => {
            const sourceEndpoint = upstreamEndpointForPowerRoute(
              attachment.route,
              childPowerstrip.id,
              devicesById,
              cables,
            );
            return sourceEndpoint?.deviceId === powerstripId;
          });
          if (isFedByPowerstrip) {
            totalW += loadForPowerstrip(childPowerstrip.id, nextVisitedPowerstripIds);
          }
        });

      loadCache.set(powerstripId, totalW);
      return totalW;
    };

    devices
      .filter((device) => device.type === "powerstrip")
      .forEach((powerstrip) => {
        loadForPowerstrip(powerstrip.id);
      });

    return loadCache;
  }, [
    cables,
    consumerSourceAssignments,
    devices,
    devicesById,
    directPowerConsumerAttachments,
    powerLoadWattsForDevice,
    powerstripSourceAssignments,
  ]);
  const electricalRouteLoadRatios = useMemo(() => {
    const ratios = new Map<string, number>();
    const powerRoutes = cables.filter((route) => route.type === "power");

    const routeFeedsPowerstrip = (route: CableRoute, powerstripId: string) =>
      Boolean(
        endpointForDevice(route, powerstripId) &&
          upstreamEndpointForPowerRoute(route, powerstripId, devicesById, cables),
      );

    const powerstripDependsOnRoute = (
      powerstripId: string,
      routeId: string,
      visitedRouteIds = new Set<string>(),
      visitedPowerstripIds = new Set<string>(),
    ): boolean => {
      if (visitedPowerstripIds.has(powerstripId)) return false;
      const powerstrip = devicesById.get(powerstripId);
      if (!powerstrip || powerstrip.type !== "powerstrip") return false;

      const nextVisitedPowerstripIds = new Set(visitedPowerstripIds);
      nextVisitedPowerstripIds.add(powerstripId);

      const directFeedDependsOnRoute = resolveDeviceCableAttachments(
        powerstrip,
        cables,
        "power",
      ).some(
        (attachment) =>
          routeFeedsPowerstrip(attachment.route, powerstripId) &&
          routeDependsOnRoute(
            attachment.route,
            routeId,
            visitedRouteIds,
            nextVisitedPowerstripIds,
          ),
      );
      if (directFeedDependsOnRoute) return true;

      const assignment = powerstripSourceAssignments.find(
        (candidate) => candidate.consumer.id === powerstripId,
      );
      const source = assignment?.source;
      if (!source) return false;
      if (source.type === "powerCable" && source.route) {
        return routeDependsOnRoute(
          source.route,
          routeId,
          visitedRouteIds,
          nextVisitedPowerstripIds,
        );
      }
      if (source.type === "powerstrip") {
        return powerstripDependsOnRoute(
          source.id,
          routeId,
          visitedRouteIds,
          nextVisitedPowerstripIds,
        );
      }
      return false;
    };

    function routeDependsOnRoute(
      route: CableRoute,
      routeId: string,
      visitedRouteIds = new Set<string>(),
      visitedPowerstripIds = new Set<string>(),
    ): boolean {
      if (route.id === routeId) return true;
      if (visitedRouteIds.has(route.id)) return false;

      const nextVisitedRouteIds = new Set(visitedRouteIds);
      nextVisitedRouteIds.add(route.id);
      const sourceEndpoint = preferredPowerSourceEndpoint(route, devicesById);
      const sourceDevice = sourceEndpoint?.deviceId
        ? devicesById.get(sourceEndpoint.deviceId)
        : undefined;
      if (sourceDevice?.type !== "powerstrip") return false;

      return powerstripDependsOnRoute(
        sourceDevice.id,
        routeId,
        nextVisitedRouteIds,
        visitedPowerstripIds,
      );
    }

    powerRoutes.forEach((route) => {
      const countedDeviceIds = new Set<string>();
      let totalW = 0;
      const addLoad = (device: Device) => {
        if (countedDeviceIds.has(device.id)) return;
        countedDeviceIds.add(device.id);
        totalW += powerLoadWattsForDevice(device);
      };

      directPowerConsumerAttachments.forEach((assignment) => {
        if (
          assignment.attachments.some((attachment) =>
            routeDependsOnRoute(attachment.route, route.id),
          )
        ) {
          addLoad(assignment.consumer);
        }
      });

      consumerSourceAssignments.forEach((assignment) => {
        const source = assignment.source;
        if (!source) return;
        if (source.type === "powerCable" && source.route) {
          if (routeDependsOnRoute(source.route, route.id)) addLoad(assignment.consumer);
          return;
        }
        if (source.type === "powerstrip" && powerstripDependsOnRoute(source.id, route.id)) {
          addLoad(assignment.consumer);
        }
      });

      devices
        .filter((device) => device.type === "powerstrip")
        .forEach((powerstrip) => {
          if (powerstripDependsOnRoute(powerstrip.id, route.id)) {
            totalW += Math.max(0, powerstrip.desiredFreeSockets ?? 0) * desiredFreeSocketLoadW;
          }
        });

      ratios.set(route.id, electricalLoadRatioForWatts(totalW));
    });

    return ratios;
  }, [
    cables,
    consumerSourceAssignments,
    devices,
    devicesById,
    directPowerConsumerAttachments,
    powerLoadWattsForDevice,
    powerstripSourceAssignments,
  ]);
  const attachedPowerPathPixelsToDeviceForColor = (
    device: Device,
    excludedRouteId?: string,
  ) => {
    const candidates = resolveDeviceCableAttachments(device, cables, "power")
      .filter((attachment) => attachment.route.id !== excludedRouteId)
      .map((attachment) => {
        const sourceEndpoint = upstreamEndpointForPowerRoute(
          attachment.route,
          device.id,
          devicesById,
          cables,
        );
        const targetEndpoint = endpointForDevice(attachment.route, device.id);
        if (!sourceEndpoint || !targetEndpoint) return undefined;
        const sourcePixels = upstreamPowerPathPixelsToEndpoint(
          sourceEndpoint,
          devicesById,
          cables,
        );
        if (sourcePixels === undefined) return undefined;
        return {
          pixels:
            sourcePixels +
            routePixels(
              routePathBetweenEndpoints(attachment.route, sourceEndpoint, targetEndpoint),
            ),
          reliableSource: Boolean(sourceEndpoint.deviceId),
        };
      })
      .filter((candidate): candidate is { pixels: number; reliableSource: boolean } =>
        Boolean(candidate),
      );
    const reliableCandidates = candidates.filter((candidate) => candidate.reliableSource);
    if (reliableCandidates.length > 0) {
      return reliableCandidates.sort((a, b) => a.pixels - b.pixels)[0].pixels;
    }
    if (device.type === "powerstrip" && candidates.length > 0) {
      return candidates.sort((a, b) => b.pixels - a.pixels)[0].pixels;
    }
    return candidates.sort((a, b) => a.pixels - b.pixels)[0]?.pixels;
  };
  const nearbyPowerCablePixelsToDeviceForColor = (
    device: Device,
    excludedRouteId?: string,
  ) => {
    if (!pixelsPerMeter) return undefined;
    const maxDistancePx = pixelsPerMeter * 1.5;
    return cables
      .filter((route) => route.type === "power" && route.id !== excludedRouteId)
      .flatMap((route) =>
        routeEndpointReferences(route)
          .filter((endpoint) => {
            if (endpoint.deviceId === device.id) return false;
            if (!endpoint.deviceId) return true;
            return devicesById.get(endpoint.deviceId)?.type !== "consumer";
          })
          .map((endpoint) => {
            const distanceToDevice = distance(device.point, endpoint.point);
            if (distanceToDevice > maxDistancePx) return undefined;
            const upstreamPixels = upstreamPowerPathPixelsToRouteEndpoint(
              route,
              endpoint,
              devicesById,
              cables,
            );
            if (upstreamPixels === undefined) return undefined;
            return {
              distanceToDevice,
              pixels: upstreamPixels + distanceToDevice,
            };
          }),
      )
      .filter((candidate): candidate is { distanceToDevice: number; pixels: number } =>
        Boolean(candidate),
      )
      .sort((a, b) => a.distanceToDevice - b.distanceToDevice)[0]?.pixels;
  };
  const powerPathPixelsToDeviceForColor = (deviceId: string, excludedRouteId?: string) => {
    const device = devicesById.get(deviceId);
    if (!device) return undefined;
    if (device.type === "producer") return 0;
    const attachedPixels = attachedPowerPathPixelsToDeviceForColor(device, excludedRouteId);
    if (attachedPixels !== undefined) return attachedPixels;
    if (device.type === "powerstrip") {
      return nearbyPowerCablePixelsToDeviceForColor(device, excludedRouteId);
    }
    return undefined;
  };
  const cableColorPathForRoute = (route: CableRoute): CableColorPath | undefined => {
    if (route.type !== "power") return undefined;
    if (electricalColorMode === "load") {
      return {
        loadRatio: electricalRouteLoadRatios.get(route.id) ?? 0,
        offsetPx: 0,
      };
    }
    const sourceEndpoint = routeEndpointReferences(route)
      .map((endpoint) => {
        const device = endpoint.deviceId ? devicesById.get(endpoint.deviceId) : undefined;
        const upstreamPixels =
          device?.type === "powerstrip"
            ? powerPathPixelsToDeviceForColor(endpoint.deviceId as string, route.id)
            : upstreamPowerPathPixelsToEndpoint(endpoint, devicesById, cables);
        const priority =
          device?.type === "producer"
            ? 0
            : device?.type === "powerstrip"
              ? 1
              : endpoint.deviceId
                ? 2
                : 3;
        return {
          endpoint,
          priority,
          upstreamPixels,
        };
      })
      .filter(
        (candidate): candidate is {
          endpoint: RouteEndpointReference;
          priority: number;
          upstreamPixels: number;
        } => candidate.upstreamPixels !== undefined,
      )
      .sort((a, b) => a.priority - b.priority || a.upstreamPixels - b.upstreamPixels)[0];
    if (!sourceEndpoint) return undefined;
    return {
      offsetPx: sourceEndpoint.upstreamPixels * viewScale,
      sourceBranchId: sourceEndpoint.endpoint.branchId,
      sourcePointIndex: sourceEndpoint.endpoint.pointIndex,
    };
  };
  const powerPathPixelsToAssignmentSource = (assignment: ResolvedConsumerSource) => {
    const source = assignment.source;
    if (!source) return 0;
    if (source.type === "producer") return 0;
    if (source.type === "powerstrip") {
      return powerPathPixelsToPowerstripWithAuto(source.id) ?? 0;
    }
    if (source.type === "powerCable" && source.route && assignment.targetPoint) {
      const targetEndpoint = nearestRouteEndpoint(source.route, assignment.targetPoint);
      return targetEndpoint
        ? upstreamPowerPathPixelsToRouteEndpoint(source.route, targetEndpoint, devicesById, cables) ?? 0
        : 0;
    }
    return 0;
  };
  const selectedFlowPaths = useMemo<FlowPath[]>(() => {
    if (!selectedDevice) return [];
    const paths: FlowPath[] = [];
    const addPath = (id: string, points: Point[], cableType: CableType, offsetPx = 0) => {
      const cleanPoints = dedupeAdjacentPoints(points);
      if (cleanPoints.length > 1 && routePixels(cleanPoints) > 4) {
        const maxLengthPx = pixelsPerMeter * cableTypes[cableType].maxLengthM;
        paths.push({
          id,
          pathData: routePathData(cleanPoints),
          segments: flowSegmentsForPoints(cleanPoints, maxLengthPx, offsetPx),
          ...flowColorsAtRatio(maxLengthPx ? offsetPx / maxLengthPx : 0),
        });
      }
    };
    const addAutoSourceFlow = (consumerId: string, source: ConsumerSource) => {
      const reuseAutoSourceId = autoSourceLinkId(consumerId, source);
      paths.push({
        id: `auto-source-${reuseAutoSourceId}`,
        pathData: "",
        activeColor: "",
        inactiveColor: "",
        reuseAutoSourceId,
      });
    };
    const addRouteToSelectedDevice = (
      route: CableRoute,
      fromType: DeviceType,
      id: string,
    ) => {
      const targetEndpoint = endpointForDevice(route, selectedDevice.id);
      const sourceEndpoint = routeEndpointReferences(route).find(
        (endpoint) =>
          endpoint.deviceId &&
          endpoint.deviceId !== selectedDevice.id &&
          devicesById.get(endpoint.deviceId)?.type === fromType,
      );
      if (!sourceEndpoint || !targetEndpoint) return;
      addPath(id, routePathBetweenEndpoints(route, sourceEndpoint, targetEndpoint), route.type);
    };
    const poweredJunctionFeedForRoute = (
      route: CableRoute,
      sourceEndpoint: RouteEndpointReference,
      targetEndpoint: RouteEndpointReference,
      visitedRouteIds: Set<string>,
    ) => {
      const sourceToTargetPoints = routePathBetweenEndpoints(route, sourceEndpoint, targetEndpoint);
      const candidateRoutePoints = route.points
        .map((point, pointIndex) => ({ point, pointIndex }))
        .filter(
          (candidate) =>
            !samePoint(candidate.point, sourceEndpoint.point) &&
            !samePoint(candidate.point, targetEndpoint.point) &&
            sourceToTargetPoints.some((pathPoint) => samePoint(pathPoint, candidate.point)),
        );

      return candidateRoutePoints
        .flatMap((candidate) =>
          cables
            .filter(
              (currentRoute) =>
                currentRoute.type === "power" &&
                currentRoute.id !== route.id &&
                !visitedRouteIds.has(currentRoute.id),
            )
            .flatMap((currentRoute) =>
              routeEndpointReferences(currentRoute)
                .filter((endpoint) => {
                  if (!samePoint(endpoint.point, candidate.point)) return false;
                  const endpointDevice = endpoint.deviceId
                    ? devicesById.get(endpoint.deviceId)
                    : undefined;
                  return endpointDevice?.type !== "consumer" && endpointDevice?.type !== "switch";
                })
                .map((endpoint) => {
                  const endpointDevice = endpoint.deviceId
                    ? devicesById.get(endpoint.deviceId)
                    : undefined;
                  const upstreamSourceEndpoint =
                    endpointDevice && endpointDevice.type !== "producer"
                      ? upstreamEndpointForPowerRoute(
                          currentRoute,
                          endpoint.deviceId as string,
                          devicesById,
                          cables,
                        )
                      : preferredPowerSourceEndpoint(currentRoute, devicesById);
                  if (!upstreamSourceEndpoint) return undefined;
                  const upstreamPixels = upstreamPowerPathPixelsToRouteEndpoint(
                    currentRoute,
                    endpoint,
                    devicesById,
                    cables,
                  );
                  if (upstreamPixels === undefined) return undefined;
                  return {
                    routeEndpoint: {
                      point: candidate.point,
                      pointIndex: candidate.pointIndex,
                    } as RouteEndpointReference,
                    upstreamPixels,
                    upstreamRoute: currentRoute,
                    upstreamSourceEndpoint,
                    upstreamTargetEndpoint: endpoint,
                  };
                }),
            ),
        )
        .filter((feed) => Boolean(feed))
        .map((feed) => feed as {
          routeEndpoint: RouteEndpointReference;
          upstreamPixels: number;
          upstreamRoute: CableRoute;
          upstreamSourceEndpoint: RouteEndpointReference;
          upstreamTargetEndpoint: RouteEndpointReference;
        })
        .sort((first, second) => first.upstreamPixels - second.upstreamPixels)[0];
    };
    const addPowerFlowToDevice = (
      targetDeviceId: string,
      idPrefix: string,
      visitedDeviceIds = new Set<string>(),
      visitedRouteIds = new Set<string>(),
    ) => {
      if (visitedDeviceIds.has(targetDeviceId)) return;
      const targetDevice = devicesById.get(targetDeviceId);
      if (!targetDevice || targetDevice.type === "producer") return;
      const nextVisitedDeviceIds = new Set(visitedDeviceIds);
      nextVisitedDeviceIds.add(targetDeviceId);
      const feed = resolveDeviceCableAttachments(targetDevice, cables, "power")
        .map((attachment) => ({
          attachment,
          sourceEndpoint: upstreamEndpointForPowerRoute(
            attachment.route,
            targetDeviceId,
            devicesById,
            cables,
          ),
          targetEndpoint: endpointForDevice(attachment.route, targetDeviceId),
        }))
        .filter(
          (
            candidate,
          ): candidate is {
            attachment: DeviceCableAttachment;
            sourceEndpoint: RouteEndpointReference;
            targetEndpoint: RouteEndpointReference;
          } =>
            Boolean(candidate.sourceEndpoint) &&
            Boolean(candidate.targetEndpoint) &&
            !visitedRouteIds.has(candidate.attachment.route.id),
        )
        .sort((a, b) => {
          const firstType = a.sourceEndpoint.deviceId
            ? devicesById.get(a.sourceEndpoint.deviceId)?.type
            : undefined;
          const secondType = b.sourceEndpoint.deviceId
            ? devicesById.get(b.sourceEndpoint.deviceId)?.type
            : undefined;
          if (firstType !== secondType) {
            if (firstType === "producer") return -1;
            if (secondType === "producer") return 1;
          }
          return a.attachment.distancePx - b.attachment.distancePx;
        })[0];
      if (!feed) {
        const assignment =
          targetDevice.type === "powerstrip"
            ? powerstripSourceAssignments.find(
                (currentAssignment) => currentAssignment.consumer.id === targetDevice.id,
              )
            : undefined;
        const source = assignment?.source;
        const targetPoint = assignment?.targetPoint;
        if (!source || !targetPoint) return;
        if (source.type === "producer") {
          addAutoSourceFlow(targetDevice.id, source);
          return;
        }
        if (source.type === "powerstrip") {
          addPowerFlowToDevice(
            source.id,
            `${idPrefix}-auto-upstream-${source.id}`,
            nextVisitedDeviceIds,
            visitedRouteIds,
          );
          addAutoSourceFlow(targetDevice.id, source);
          return;
        }
        if (source.route) {
          const targetEndpoint = nearestRouteEndpoint(source.route, targetPoint);
          const sourceEndpoint = targetEndpoint?.deviceId
            ? upstreamEndpointForPowerRoute(
                source.route,
                targetEndpoint.deviceId,
                devicesById,
                cables,
              )
            : preferredPowerSourceEndpoint(source.route, devicesById);
          if (!targetEndpoint || !sourceEndpoint) return;
          const sourceOffsetPx =
            upstreamPowerPathPixelsToEndpoint(sourceEndpoint, devicesById, cables) ?? 0;
          addPath(
            `${idPrefix}-auto-route-${source.route.id}`,
            routePathBetweenEndpoints(source.route, sourceEndpoint, targetEndpoint),
            "power",
            sourceOffsetPx,
          );
          addAutoSourceFlow(targetDevice.id, source);
          if (
            sourceEndpoint.deviceId &&
            devicesById.get(sourceEndpoint.deviceId)?.type === "powerstrip"
          ) {
            addPowerFlowToDevice(
              sourceEndpoint.deviceId,
              `${idPrefix}-auto-route-upstream-${sourceEndpoint.deviceId}`,
              nextVisitedDeviceIds,
              new Set([...visitedRouteIds, source.route.id]),
            );
          }
        }
        return;
      }
      if (samePoint(feed.sourceEndpoint.point, feed.targetEndpoint.point)) return;
      const junctionFeed = poweredJunctionFeedForRoute(
        feed.attachment.route,
        feed.sourceEndpoint,
        feed.targetEndpoint,
        visitedRouteIds,
      );
      const flowSourceEndpoint = junctionFeed?.routeEndpoint ?? feed.sourceEndpoint;
      const sourceOffsetPx = junctionFeed
        ? junctionFeed.upstreamPixels
        : upstreamPowerPathPixelsToEndpoint(feed.sourceEndpoint, devicesById, cables) ?? 0;
      if (junctionFeed) {
        const upstreamOffsetPx =
          upstreamPowerPathPixelsToEndpoint(
            junctionFeed.upstreamSourceEndpoint,
            devicesById,
            cables,
          ) ?? 0;
        addPath(
          `${idPrefix}-${junctionFeed.upstreamRoute.id}-junction`,
          routePathBetweenEndpoints(
            junctionFeed.upstreamRoute,
            junctionFeed.upstreamSourceEndpoint,
            junctionFeed.upstreamTargetEndpoint,
          ),
          "power",
          upstreamOffsetPx,
        );
      }
      addPath(
        `${idPrefix}-${feed.attachment.route.id}`,
        routePathBetweenEndpoints(
          feed.attachment.route,
          flowSourceEndpoint,
          feed.targetEndpoint,
        ),
        "power",
        sourceOffsetPx,
      );
      const upstreamDeviceId = junctionFeed?.upstreamSourceEndpoint.deviceId ?? feed.sourceEndpoint.deviceId;
      if (upstreamDeviceId && devicesById.get(upstreamDeviceId)?.type === "powerstrip") {
        const nextVisitedRouteIds = new Set(visitedRouteIds);
        nextVisitedRouteIds.add(feed.attachment.route.id);
        if (junctionFeed) nextVisitedRouteIds.add(junctionFeed.upstreamRoute.id);
        addPowerFlowToDevice(
          upstreamDeviceId,
          `${idPrefix}-upstream`,
          nextVisitedDeviceIds,
          nextVisitedRouteIds,
        );
      }
    };
    const addRouteFromDevice = (
      route: CableRoute,
      fromDeviceId: string,
      id: string,
      targetType?: DeviceType,
    ) => {
      const sourceEndpoint = endpointForDevice(route, fromDeviceId);
      if (!sourceEndpoint) return;
      routeEndpointReferences(route)
        .filter((endpoint) => {
          if (!endpoint.deviceId || endpoint.deviceId === fromDeviceId) return false;
          return targetType ? devicesById.get(endpoint.deviceId)?.type === targetType : true;
        })
        .forEach((targetEndpoint, index) => {
          addPath(
            `${id}-${index}`,
            routePathBetweenEndpoints(route, sourceEndpoint, targetEndpoint),
            route.type,
          );
        });
    };
    const addPowerFlowFromDevice = (
      sourceDeviceId: string,
      idPrefix: string,
      visitedDeviceIds = new Set<string>(),
      visitedRouteIds = new Set<string>(),
    ) => {
      if (visitedDeviceIds.has(sourceDeviceId)) return;
      const sourceDevice = devicesById.get(sourceDeviceId);
      if (!sourceDevice) return;
      const nextVisitedDeviceIds = new Set(visitedDeviceIds);
      nextVisitedDeviceIds.add(sourceDeviceId);

      [...consumerSourceAssignments, ...powerstripSourceAssignments]
        .filter(
          (assignment): assignment is ResolvedConsumerSource & { source: ConsumerSource } =>
            (assignment.source?.type === "powerstrip" ||
              assignment.source?.type === "producer") &&
            assignment.source.id === sourceDeviceId &&
            Boolean(assignment.targetPoint),
        )
        .forEach((assignment) => {
          addAutoSourceFlow(assignment.consumer.id, assignment.source);
          if (assignment.consumer.type === "powerstrip") {
            addPowerFlowFromDevice(
              assignment.consumer.id,
              `${idPrefix}-${assignment.consumer.id}`,
              nextVisitedDeviceIds,
              visitedRouteIds,
            );
          }
        });

      resolveDeviceCableAttachments(sourceDevice, cables, "power").forEach((attachment) => {
        if (visitedRouteIds.has(attachment.route.id)) return;
        const sourceEndpoint = endpointForDevice(attachment.route, sourceDeviceId);
        if (!sourceEndpoint) return;
        routeEndpointReferences(attachment.route).forEach((targetEndpoint, index) => {
          if (!targetEndpoint.deviceId || targetEndpoint.deviceId === sourceDeviceId) return;
          const targetDevice = devicesById.get(targetEndpoint.deviceId);
          if (!targetDevice || targetDevice.type === "producer") return;
          const upstreamEndpoint = upstreamEndpointForPowerRoute(
            attachment.route,
            targetDevice.id,
            devicesById,
            cables,
          );
          if (upstreamEndpoint?.deviceId !== sourceDeviceId) return;
          const sourceOffsetPx =
            upstreamPowerPathPixelsToEndpoint(sourceEndpoint, devicesById, cables) ?? 0;
          addPath(
            `${idPrefix}-${attachment.route.id}-${index}`,
            routePathBetweenEndpoints(attachment.route, sourceEndpoint, targetEndpoint),
            "power",
            sourceOffsetPx,
          );
          if (targetDevice.type === "powerstrip") {
            const nextVisitedRouteIds = new Set(visitedRouteIds);
            nextVisitedRouteIds.add(attachment.route.id);
            addPowerFlowFromDevice(
              targetDevice.id,
              `${idPrefix}-${targetDevice.id}`,
              nextVisitedDeviceIds,
              nextVisitedRouteIds,
            );
          }
        });
      });
    };
    const addPowerCableAssignmentFromSelectedSource = (assignment: ResolvedConsumerSource) => {
      if (
        selectedDevice.type !== "producer" ||
        assignment.source?.type !== "powerCable" ||
        !assignment.source.route ||
        !assignment.targetPoint ||
        upstreamProducerIdForPowerRoute(assignment.source.route, devicesById, cables) !==
          selectedDevice.id
      ) {
        return;
      }
      const targetEndpoint = nearestRouteEndpoint(assignment.source.route, assignment.targetPoint);
      const sourceEndpoint = targetEndpoint
        ? upstreamEndpointForPowerRoute(
            assignment.source.route,
            targetEndpoint.deviceId ?? "",
            devicesById,
            cables,
          ) ?? preferredPowerSourceEndpoint(assignment.source.route, devicesById)
        : undefined;
      if (!targetEndpoint || !sourceEndpoint) return;
      const sourceOffsetPx =
        upstreamPowerPathPixelsToEndpoint(sourceEndpoint, devicesById, cables) ?? 0;
      addPath(
        `power-source-assignment-${assignment.source.route.id}-${assignment.consumer.id}`,
        routePathBetweenEndpoints(assignment.source.route, sourceEndpoint, targetEndpoint),
        "power",
        sourceOffsetPx,
      );
      addAutoSourceFlow(assignment.consumer.id, assignment.source);
    };

    if (selectedDevice.type === "consumer") {
      const directAttachments = resolveDeviceCableAttachments(selectedDevice, cables, "power");
      if (directAttachments.length > 0) {
        addPowerFlowToDevice(selectedDevice.id, "power-direct");
      }
      if (directAttachments.length === 0) {
        const source = selectedConsumerAssignment?.source;
        const targetPoint = selectedConsumerAssignment?.targetPoint;
        if (source && targetPoint && source.type === "producer") {
          addAutoSourceFlow(selectedDevice.id, source);
        } else if (source && targetPoint && source.type === "powerstrip") {
          addPowerFlowToDevice(source.id, `power-strip-feed-${source.id}`);
          addAutoSourceFlow(selectedDevice.id, source);
        } else if (source && targetPoint && source.type === "powerCable" && source.route) {
          const targetEndpoint = nearestRouteEndpoint(source.route, targetPoint);
          const sourceEndpoint =
            targetEndpoint?.deviceId
              ? upstreamEndpointForPowerRoute(
                  source.route,
                  targetEndpoint.deviceId,
                  devicesById,
                  cables,
                )
              : preferredPowerSourceEndpoint(source.route, devicesById);
          if (targetEndpoint && sourceEndpoint) {
            const sourceOffsetPx =
              upstreamPowerPathPixelsToEndpoint(sourceEndpoint, devicesById, cables) ?? 0;
            addPath(
              `power-cable-feed-${source.route.id}`,
              routePathBetweenEndpoints(source.route, sourceEndpoint, targetEndpoint),
              "power",
              sourceOffsetPx,
            );
            addAutoSourceFlow(selectedDevice.id, source);
            if (
              sourceEndpoint.deviceId &&
              devicesById.get(sourceEndpoint.deviceId)?.type === "powerstrip"
            ) {
              addPowerFlowToDevice(
                sourceEndpoint.deviceId,
                `power-cable-upstream-${sourceEndpoint.deviceId}`,
                new Set(),
                new Set([source.route.id]),
              );
            }
          }
        }
      }
      resolveDeviceCableAttachments(selectedDevice, cables, "ethernet").forEach((attachment, index) => {
        addRouteToSelectedDevice(
          attachment.route,
          "switch",
          `data-consumer-${attachment.route.id}-${index}`,
        );
      });
      resolveDeviceCableAttachments(selectedDevice, cables, "xlr").forEach((attachment, index) => {
        addRouteToSelectedDevice(
          attachment.route,
          "consumer",
          `xlr-consumer-${attachment.route.id}-${index}`,
        );
      });
    } else if (selectedDevice.type === "powerstrip") {
      addPowerFlowToDevice(selectedDevice.id, "power-strip");
    } else if (selectedDevice.type === "producer") {
      addPowerFlowFromDevice(selectedDevice.id, "power-source");
      consumerSourceAssignments.forEach(addPowerCableAssignmentFromSelectedSource);
    } else if (selectedDevice.type === "ethernetClient") {
      if (selectedEthernetClientAssignment) {
        const sourceEndpoint = endpointForDevice(
          selectedEthernetClientAssignment.clientAttachment.route,
          selectedEthernetClientAssignment.switchDevice.id,
        );
        const targetEndpoint = endpointForDevice(
          selectedEthernetClientAssignment.clientAttachment.route,
          selectedDevice.id,
        );
        if (sourceEndpoint && targetEndpoint) {
          addPath(
            `data-client-${selectedEthernetClientAssignment.clientAttachment.route.id}`,
            routePathBetweenEndpoints(
              selectedEthernetClientAssignment.clientAttachment.route,
              sourceEndpoint,
              targetEndpoint,
            ),
            selectedEthernetClientAssignment.clientAttachment.route.type,
          );
        }
      }
    } else if (selectedDevice.type === "switch") {
      addPowerFlowToDevice(selectedDevice.id, "power-switch");
      resolveDeviceCableAttachments(selectedDevice, cables, "ethernet").forEach((attachment) => {
        addRouteFromDevice(
          attachment.route,
          selectedDevice.id,
          `data-switch-${attachment.route.id}`,
          "ethernetClient",
        );
      });
      resolveDeviceCableAttachments(selectedDevice, cables, "ethernet").forEach((attachment) => {
        addRouteFromDevice(
          attachment.route,
          selectedDevice.id,
          `data-switch-consumer-${attachment.route.id}`,
          "consumer",
        );
      });
    }

    return paths;
  }, [
    cables,
    consumerSourceAssignments,
    devicesById,
    pixelsPerMeter,
    powerstripSourceAssignments,
    selectedConsumerAssignment,
    selectedDevice,
    selectedEthernetClientAssignment,
  ]);
  const selectedAutoSourceFlowIds = useMemo(
    () =>
      new Set(
        selectedFlowPaths
          .map((path) => path.reuseAutoSourceId)
          .filter((id): id is string => Boolean(id)),
      ),
    [selectedFlowPaths],
  );
  const draftRoute = useMemo(
    () =>
      mode === "cable" && routeDraft.length > 0 && cursorPoint
        ? [...routeDraft, cursorPoint]
        : routeDraft,
    [cursorPoint, mode, routeDraft],
  );

  const stats = useMemo(() => {
    return Object.values(cableTypes).map((config) => {
      const routes = cables.filter((route) => route.type === config.id);
      const total = routes.reduce((sum, route) => {
        return sum + (pixelsPerMeter ? routeMaterialPixels(route) / pixelsPerMeter : 0);
      }, 0);
      const draft =
        config.id === activeCable && draftRoute.length > 1 && pixelsPerMeter
          ? routePixels(draftRoute) / pixelsPerMeter
          : 0;
      return {
        ...config,
        count: routes.length,
        total,
        draft,
        overLimit: routes.some((route) => {
          return pixelsPerMeter
            ? routeCablePathPixels(route).some(
                (pathPixels) => pathPixels / pixelsPerMeter > config.maxLengthM,
              )
            : false;
        }),
      };
    });
  }, [activeCable, cables, draftRoute, pixelsPerMeter]);

  const producerIdForDirectPowerDevice = useCallback(
    (deviceId: string) => {
      const directAttachment = directPowerConsumerAttachments.find(
        (assignment) => assignment.consumer.id === deviceId,
      );
      for (const attachment of directAttachment?.attachments ?? []) {
        const producerId = upstreamProducerIdForPowerRoute(
          attachment.route,
          devicesById,
          cables,
        );
        if (producerId) return producerId;
      }
      return undefined;
    },
    [cables, devicesById, directPowerConsumerAttachments],
  );

  const powerStats = useMemo(() => {
    const devicesById = new Map(devices.map((device) => [device.id, device]));
    const producerIdForAssignment = (assignment: ResolvedConsumerSource) => {
      const source = assignment.source;
      if (!source) return undefined;
      if (source.type === "producer") {
        return source.id;
      }
      if (source.type === "powerstrip") {
        return producerIdForPowerstripWithAuto(source.id);
      }
      if (source.route) {
        return upstreamProducerIdForPowerRoute(source.route, devicesById, cables);
      }
      const route = cables.find((candidate) => candidate.id === source.id);
      return route
        ? upstreamProducerIdForPowerRoute(route, devicesById, cables)
        : undefined;
    };
    return producers.map((producer) => {
      const assignedPowerLoadIds = new Set<string>();
      consumerSourceAssignments.forEach((assignment) => {
        if (producerIdForAssignment(assignment) === producer.id) {
          assignedPowerLoadIds.add(assignment.consumer.id);
        }
      });
      directPowerConsumerAttachments.forEach((assignment) => {
        if (producerIdForDirectPowerDevice(assignment.consumer.id) === producer.id) {
          assignedPowerLoadIds.add(assignment.consumer.id);
        }
      });
      const assignedConsumers = consumers.filter((consumer) =>
        assignedPowerLoadIds.has(consumer.id),
      );
      const assignedSwitches = switches.filter((switchDevice) =>
        assignedPowerLoadIds.has(switchDevice.id),
      );
      const consumerLoadW = assignedConsumers.reduce(
        (sum, consumer) => sum + (consumer.powerW ?? 0),
        0,
      );
      const switchLoadW = assignedSwitches.reduce(
        (sum, switchDevice) => sum + switchRequiredPowerW(switchDevice),
        0,
      );
      const desiredFreeSocketReserveW = devices
        .filter(
          (device) =>
            device.type === "powerstrip" &&
            producerIdForPowerstripWithAuto(device.id) === producer.id,
        )
        .reduce(
          (sum, powerstrip) =>
            sum + Math.max(0, powerstrip.desiredFreeSockets ?? 0) * desiredFreeSocketLoadW,
          0,
        );
      const usedW = consumerLoadW + switchLoadW + desiredFreeSocketReserveW;
      const capacityW = producer.availablePowerW ?? 0;
      const electricalCableCount =
        producerPowerCableAttachments.find(
          (attachment) => attachment.producerId === producer.id,
        )?.attachments.length ?? 0;
      const directSourceConsumerCount = consumerSourceAssignments.filter(
        (assignment) =>
          assignment.source?.type === "producer" &&
          assignment.source.id === producer.id,
      ).length;
      const directSourcePowerstripCount = powerstripSourceAssignments.filter(
        (assignment) =>
          assignment.source?.type === "producer" &&
          assignment.source.id === producer.id,
      ).length;
      const socketUsage =
        electricalCableCount + directSourceConsumerCount + directSourcePowerstripCount;
      const socketCapacity = socketCapacityForDevice(producer);
      const overSocketLimit = socketCapacity > 0 && socketUsage > socketCapacity;
      return {
        id: producer.id,
        name: producer.name || "Power source",
        page: producer.page,
        capacityW,
        usedW,
        remainingW: capacityW - usedW,
        percent: capacityW > 0 ? (usedW / capacityW) * 100 : 0,
        consumerCount: assignedConsumers.length,
        loadCount: assignedConsumers.length + assignedSwitches.length,
        desiredFreeSocketReserveW,
        switchCount: assignedSwitches.length,
        electricalCableCount,
        socketUsage,
        socketCapacity,
        overLimit: (capacityW > 0 && usedW > capacityW) || overSocketLimit,
        overSocketLimit,
      };
    });
  }, [
    cables,
    consumerSourceAssignments,
    consumers,
    devices,
    directPowerConsumerAttachments,
    producerIdForDirectPowerDevice,
    producerIdForPowerstripWithAuto,
    powerstripSourceAssignments,
    producerPowerCableAttachments,
    producers,
    switchRequiredPowerW,
    switches,
  ]);

  const unassignedConsumers = consumerSourceAssignments.filter(
    (assignment) =>
      !assignment.source && !directlyPoweredConsumerIds.has(assignment.consumer.id),
  );
  const unassignedConsumerLoadW = unassignedConsumers.reduce(
    (sum, assignment) => sum + (assignment.consumer.powerW ?? 0),
    0,
  );
  const unassignedSwitches = switches.filter(
    (switchDevice) => !producerIdForDirectPowerDevice(switchDevice.id),
  );
  const unassignedSwitchLoadW = unassignedSwitches.reduce(
    (sum, switchDevice) => sum + switchRequiredPowerW(switchDevice),
    0,
  );
  const unassignedLoadW = unassignedConsumerLoadW + unassignedSwitchLoadW;
  const unassignedPowerLoadCount = unassignedConsumers.length + unassignedSwitches.length;

  const orphanDeviceIds = useMemo(() => {
    const orphanIds = new Set<string>();
    const assignmentHasPowerSource = (assignment: ResolvedConsumerSource | undefined) => {
      const source = assignment?.source;
      if (!source) return false;
      if (source.type === "producer") return true;
      if (source.type === "powerstrip") {
        return Boolean(producerIdForPowerstripWithAuto(source.id));
      }
      return Boolean(source.route && upstreamProducerIdForPowerRoute(source.route, devicesById, cables));
    };
    const consumerHasPowerSource = (consumer: Device) => {
      const directAttachment = directPowerConsumerAttachments.find(
        (assignment) => assignment.consumer.id === consumer.id,
      );
      if (
        directAttachment?.attachments.some((attachment) =>
          upstreamProducerIdForPowerRoute(attachment.route, devicesById, cables),
        )
      ) {
        return true;
      }
      return assignmentHasPowerSource(
        consumerSourceAssignments.find((assignment) => assignment.consumer.id === consumer.id),
      );
    };
    const switchHasPowerSource = (switchDevice: Device) =>
      Boolean(producerIdForDirectPowerDevice(switchDevice.id));
    const ethernetClientCableIds = new Set(
      ethernetClientAttachments.map((attachment) => attachment.device.id),
    );
    const producerCableCounts = new Map(
      producerPowerCableAttachments.map((producer) => [
        producer.producerId,
        producer.attachments.length,
      ]),
    );
    const producerDirectConsumerCounts = new Map<string, number>();
    consumerSourceAssignments.forEach((assignment) => {
      if (assignment.source?.type !== "producer") return;
      producerDirectConsumerCounts.set(
        assignment.source.id,
        (producerDirectConsumerCounts.get(assignment.source.id) ?? 0) + 1,
      );
    });
    powerstripSourceAssignments.forEach((assignment) => {
      if (assignment.source?.type !== "producer") return;
      producerDirectConsumerCounts.set(
        assignment.source.id,
        (producerDirectConsumerCounts.get(assignment.source.id) ?? 0) + 1,
      );
    });
    devices.forEach((device) => {
      let connected = false;

      if (device.type === "producer") {
        connected =
          (producerCableCounts.get(device.id) ?? 0) > 0 ||
          (producerDirectConsumerCounts.get(device.id) ?? 0) > 0;
      } else if (device.type === "powerstrip") {
        connected =
          Boolean(upstreamProducerIdForPowerstrip(device.id, devicesById, cables)) ||
          assignmentHasPowerSource(
            powerstripSourceAssignments.find(
              (assignment) => assignment.consumer.id === device.id,
            ),
          );
      } else if (device.type === "consumer") {
        connected = consumerHasPowerSource(device);
      } else if (device.type === "switch") {
        connected = switchHasPowerSource(device);
      } else if (device.type === "ethernetClient") {
        connected = ethernetClientCableIds.has(device.id);
      }

      if (!connected) orphanIds.add(device.id);
    });

    return orphanIds;
  }, [
    cables,
    consumerSourceAssignments,
    devices,
    devicesById,
    directPowerConsumerAttachments,
    ethernetClientAttachments,
    producerIdForDirectPowerDevice,
    producerIdForPowerstripWithAuto,
    powerstripSourceAssignments,
    producerPowerCableAttachments,
  ]);

  async function handleFile(file: File | null) {
    if (!file) return;
    const buffer = await file.arrayBuffer();
    const document = await pdfjsLib.getDocument({ data: buffer }).promise;
    setPdfDoc(document);
    setPdfName(file.name);
    setPdfDataUrl(await fileToDataUrl(file));
    setPageCount(document.numPages);
    setPageNumber(1);
    setCalibration(undefined);
    setRouteDraft([]);
    setRouteDraftDeviceIds([]);
    setCursorPoint(null);
    setSelectedId(null);
    setSelectedDeviceIds([]);
    setStorageNotice("");
    queueViewPositionRestore(defaultViewPosition);
  }

  async function applyProject(project: PersistedProject) {
    if (project.version !== 1) {
      throw new Error("Unsupported project version");
    }

    setPdfName(project.pdfName || "");
    setPdfDataUrl(project.pdfDataUrl);
    setPageNumber(project.pageNumber || 1);
    setPageCount(project.pageCount || 0);
    setPageSize(project.pageSize || { width: 840, height: 640 });
    setZoom(project.zoom || 1.1);
    setFloorPlanOpacity(project.floorPlanOpacity ?? 1);
    setAnimateOrphans(project.animateOrphans ?? true);
    setElectricalColorMode(project.electricalColorMode ?? "length");
    setMode(project.mode || "scale");
    setActiveCable(project.activeCable || "ethernet");
    setActiveDevice(project.activeDevice || "powerstrip");
    setKnownDistance(project.knownDistance || "10");
    setCalibration(project.calibration);
    setCables(project.cables || []);
    setDevices(project.devices || []);
    setRouteDraft([]);
    setRouteDraftDeviceIds([]);
    setCursorPoint(null);
    setScaleDraft(null);
    setSelectedId(null);
    setSelectedDeviceIds([]);
    queueViewPositionRestore(project.viewPosition);

    if (project.pdfDataUrl) {
      const document = await pdfjsLib.getDocument({
        data: await dataUrlToBytes(project.pdfDataUrl),
      }).promise;
      setPdfDoc(document);
      setPageCount(document.numPages);
      setPageNumber(Math.min(Math.max(project.pageNumber || 1, 1), document.numPages));
      return;
    }

    setPdfDoc(null);
  }

  function currentProject(): PersistedProject {
    return {
      version: 1,
      pdfName,
      pdfDataUrl,
      pageNumber,
      pageCount,
      pageSize,
      zoom,
      floorPlanOpacity,
      animateOrphans,
      electricalColorMode,
      mode,
      activeCable,
      activeDevice,
      knownDistance,
      calibration,
      cables,
      devices,
      viewPosition,
    };
  }

  function currentUndoSnapshot(): UndoSnapshot {
    return {
      ...currentProject(),
      routeDraft,
      routeDraftDeviceIds,
      scaleDraft,
      selectedId,
      selectedCablePoint,
    };
  }

  function pushUndoSnapshot(snapshot: UndoSnapshot) {
    undoHistoryRef.current.push(cloneUndoSnapshot(snapshot));
    if (undoHistoryRef.current.length > maxUndoHistory) {
      undoHistoryRef.current.splice(
        0,
        undoHistoryRef.current.length - maxUndoHistory,
      );
    }
  }

  function beginUndoGroup() {
    if (undoGroupActiveRef.current) return;
    const snapshot = cloneUndoSnapshot(currentUndoSnapshot());
    undoGroupActiveRef.current = true;
    undoGroupStartSnapshotRef.current = snapshot;
    undoGroupStartKeyRef.current = undoSnapshotKey(snapshot);
  }

  function finishUndoGroup() {
    if (!undoGroupActiveRef.current) return;
    const startSnapshot = undoGroupStartSnapshotRef.current;
    const currentSnapshot = cloneUndoSnapshot(currentUndoSnapshot());
    const currentKey = undoSnapshotKey(currentSnapshot);

    undoGroupActiveRef.current = false;
    undoGroupStartSnapshotRef.current = null;

    if (startSnapshot && currentKey !== undoGroupStartKeyRef.current) {
      pushUndoSnapshot(startSnapshot);
    }

    undoGroupStartKeyRef.current = "";
    lastUndoSnapshotKeyRef.current = currentKey;
    lastUndoSnapshotRef.current = currentSnapshot;
  }

  async function restoreUndoSnapshot(snapshot: UndoSnapshot) {
    const project = cloneProject(snapshot);

    setPdfName(project.pdfName || "");
    setPdfDataUrl(project.pdfDataUrl);
    setPageNumber(project.pageNumber || 1);
    setPageCount(project.pageCount || 0);
    setPageSize(project.pageSize || { width: 840, height: 640 });
    setZoom(project.zoom || 1.1);
    setFloorPlanOpacity(project.floorPlanOpacity ?? 1);
    setAnimateOrphans(project.animateOrphans ?? true);
    setElectricalColorMode(project.electricalColorMode ?? "length");
    setMode(project.mode || "scale");
    setActiveCable(project.activeCable || "ethernet");
    setActiveDevice(project.activeDevice || "powerstrip");
    setKnownDistance(project.knownDistance || "10");
    setCalibration(project.calibration);
    setCables(project.cables || []);
    setDevices(project.devices || []);
    setRouteDraft(snapshot.routeDraft.map(clonePoint));
    setRouteDraftDeviceIds([...snapshot.routeDraftDeviceIds]);
    setCursorPoint(null);
    setScaleDraft(snapshot.scaleDraft ? clonePoint(snapshot.scaleDraft) : null);
    setDraggingDevice(null);
    setDraggingCablePoint(null);
    setSelectedId(snapshot.selectedId);
    setSelectedDeviceIds(
      snapshot.selectedId && project.devices.some((device) => device.id === snapshot.selectedId)
        ? [snapshot.selectedId]
        : [],
    );
    setSelectedCablePoint(
      snapshot.selectedCablePoint ? { ...snapshot.selectedCablePoint } : null,
    );
    queueViewPositionRestore(project.viewPosition);

    if (project.pdfDataUrl) {
      if (project.pdfDataUrl === pdfDataUrl && pdfDoc) return;

      try {
        const document = await pdfjsLib.getDocument({
          data: await dataUrlToBytes(project.pdfDataUrl),
        }).promise;
        setPdfDoc(document);
        setPageCount(document.numPages);
        setPageNumber(Math.min(Math.max(project.pageNumber || 1, 1), document.numPages));
      } catch {
        setStorageNotice("Undo restored the plan, but the saved PDF could not be reopened.");
      }
      return;
    }

    setPdfDoc(null);
  }

  useEffect(() => {
    if (!hydrated) return;

    const snapshot: UndoSnapshot = {
      version: 1,
      pdfName,
      pdfDataUrl,
      pageNumber,
      pageCount,
      pageSize,
      zoom,
      floorPlanOpacity,
      animateOrphans,
      electricalColorMode,
      mode,
      activeCable,
      activeDevice,
      knownDistance,
      calibration,
      cables,
      devices,
      viewPosition,
      routeDraft,
      routeDraftDeviceIds,
      scaleDraft,
      selectedId,
      selectedCablePoint,
    };
    const snapshotKey = undoSnapshotKey(snapshot);
    const clonedSnapshot = cloneUndoSnapshot(snapshot);

    if (!lastUndoSnapshotKeyRef.current || !lastUndoSnapshotRef.current) {
      lastUndoSnapshotKeyRef.current = snapshotKey;
      lastUndoSnapshotRef.current = clonedSnapshot;
      return;
    }

    if (applyingUndoRef.current) {
      applyingUndoRef.current = false;
      lastUndoSnapshotKeyRef.current = snapshotKey;
      lastUndoSnapshotRef.current = clonedSnapshot;
      return;
    }

    if (undoGroupActiveRef.current) {
      lastUndoSnapshotKeyRef.current = snapshotKey;
      lastUndoSnapshotRef.current = clonedSnapshot;
      return;
    }

    if (snapshotKey !== lastUndoSnapshotKeyRef.current) {
      pushUndoSnapshot(lastUndoSnapshotRef.current);
      lastUndoSnapshotKeyRef.current = snapshotKey;
    }

    lastUndoSnapshotRef.current = clonedSnapshot;
  }, [
    activeCable,
    activeDevice,
    animateOrphans,
    cables,
    calibration,
    devices,
    electricalColorMode,
    floorPlanOpacity,
    hydrated,
    knownDistance,
    mode,
    pageCount,
    pageNumber,
    pageSize,
    pdfDataUrl,
    pdfName,
    routeDraft,
    routeDraftDeviceIds,
    scaleDraft,
    selectedCablePoint,
    selectedId,
    viewPosition,
    zoom,
  ]);

  function downloadProject() {
    const blob = new Blob([JSON.stringify(currentProject(), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const baseName = (pdfName || "zuperpatch-project").replace(/\.pdf$/i, "");
    anchor.href = url;
    anchor.download = `${baseName}.zuperpatch.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function downloadPlanPdf() {
    const stage = stageRef.current;
    if (!stage) return;

    try {
      setStorageNotice("");
      const { default: html2canvas } = await import("html2canvas");
      const exportCanvas = await html2canvas(stage, {
        backgroundColor: window.getComputedStyle(stage).backgroundColor || null,
        height: pageSize.height,
        logging: false,
        scale: Math.max(1, window.devicePixelRatio || 1),
        useCORS: true,
        width: pageSize.width,
      });

      const orientation: "landscape" | "portrait" =
        pageSize.width >= pageSize.height ? "landscape" : "portrait";
      const pdf = new jsPDF({
        orientation,
        unit: "px",
        format: [pageSize.width, pageSize.height],
      });
      pdf.addImage(
        exportCanvas.toDataURL("image/png"),
        "PNG",
        0,
        0,
        pageSize.width,
        pageSize.height,
      );
      const baseName = (pdfName || "zuperpatch").replace(/\.pdf$/i, "");
      const pageSuffix = pageCount > 1 ? `-page-${pageNumber}` : "";
      const fileName = `${baseName}-plan${pageSuffix}.pdf`;
      const url = URL.createObjectURL(pdf.output("blob"));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setStorageNotice("Plan PDF could not be exported.");
    }
  }

  function downloadBillOfMaterials() {
    const document = new jsPDF();
    const margin = 14;
    const pageWidth = document.internal.pageSize.getWidth();
    const pageHeight = document.internal.pageSize.getHeight();
    let y = margin;

    const addPageIfNeeded = (height = 8) => {
      if (y + height <= pageHeight - margin) return;
      document.addPage();
      y = margin;
    };
    const addLine = (text: string, size = 10, style: "normal" | "bold" = "normal") => {
      addPageIfNeeded(7);
      document.setFont("helvetica", style);
      document.setFontSize(size);
      document.text(text, margin, y);
      y += size >= 14 ? 8 : 6;
    };
    const addSection = (title: string) => {
      y += y === margin ? 0 : 4;
      addLine(title, 13, "bold");
      document.setDrawColor(180);
      document.line(margin, y - 4, pageWidth - margin, y - 4);
    };
    const setDrawColorFromRgb = (rgb: { r: number; g: number; b: number }) => {
      document.setDrawColor(
        Math.round(rgb.r * 255),
        Math.round(rgb.g * 255),
        Math.round(rgb.b * 255),
      );
    };
    const drawGradientRule = (
      startX: number,
      endX: number,
      lineY: number,
      startColor: string,
      endColor: string,
    ) => {
      const segmentCount = 40;
      const start = hexToRgb(startColor);
      const end = hexToRgb(endColor);
      document.setLineWidth(1.8);
      for (let index = 0; index < segmentCount; index += 1) {
        const segmentStartRatio = index / segmentCount;
        const segmentEndRatio = (index + 1) / segmentCount;
        const segmentStartX = startX + (endX - startX) * segmentStartRatio;
        const segmentEndX = startX + (endX - startX) * segmentEndRatio;
        setDrawColorFromRgb(mixColor(start, end, (segmentStartRatio + segmentEndRatio) / 2));
        document.line(segmentStartX, lineY, segmentEndX, lineY);
      }
      document.setLineWidth(0.2);
    };
    const addCableGroup = (stat: (typeof stats)[number]) => {
      addPageIfNeeded(18);
      y += 4;
      const title = `${stat.label} (${lengthLabel(stat.total)})`;
      document.setFont("helvetica", "bold");
      document.setFontSize(12);
      document.setTextColor(0);
      document.text(title, margin, y);
      const lineStartX = Math.min(margin + document.getTextWidth(title) + 4, pageWidth - margin - 8);
      drawGradientRule(lineStartX, pageWidth - margin, y - 1.4, stat.colorStart, stat.colorEnd);
      y += 5;
      document.setFont("helvetica", "normal");
      document.setFontSize(9);
      document.setTextColor(90);
      document.text(
        `${stat.count} route${stat.count === 1 ? "" : "s"}; recommended max ${lengthLabel(
          stat.maxLengthM,
        )}`,
        margin,
        y,
      );
      document.setTextColor(0);
      y += 6;
    };
    const addItem = (name: string, quantity: string, note?: string) => {
      addPageIfNeeded(note ? 12 : 7);
      document.setFont("helvetica", "normal");
      document.setFontSize(10);
      document.text(name, margin, y);
      document.setFont("helvetica", "normal");
      document.text(quantity, pageWidth - margin, y, { align: "right" });
      y += 5;
      if (note) {
        document.setTextColor(90);
        document.text(note, margin + 4, y);
        document.setTextColor(0);
        y += 5;
      }
    };

    document.setTextColor(0);
    addLine("Bill of Materials", 18, "bold");
    addLine(pdfName ? `Project: ${pdfName}` : "Project: Untitled ZuperPatch! plan");
    addLine(`Generated: ${new Date().toLocaleString()}`);
    addLine(`Pages: ${pageCount || 1}`);

    addSection("Cable");
    stats.forEach((stat) => {
      addCableGroup(stat);
      cables
        .filter((route) => route.type === stat.id)
        .forEach((route) => {
          cableBomEntries(route, devices).forEach((entry) => {
            addItem(
              entry.label,
              pixelsPerMeter ? lengthLabel(entry.pixels / pixelsPerMeter) : "Scale not set",
              entry.note,
            );
          });
        });
    });

    addSection("Devices");
    Object.values(deviceTypes).forEach((config) => {
      const count = countByDeviceType(devices, config.id);
      if (count > 0) addItem(config.label, integerUnit.format(count));
    });

    addSection("Power");
    powerstripConnectionStats.forEach((strip, index) => {
      addItem(
        `Powerstrip ${index + 1}`,
        `${strip.socketCapacity} socket${strip.socketCapacity === 1 ? "" : "s"}`,
        `${strip.occupiedSocketCount} occupied; ${strip.desiredFreeSockets} desired free; ${
          strip.feedCableCount
        } supply feed${
          strip.feedCableCount === 1 ? "" : "s"
        }`,
      );
    });
    powerStats.forEach((source) => {
      addItem(
        source.name,
        `${source.socketCapacity} power socket${source.socketCapacity === 1 ? "" : "s"}`,
        `${source.electricalCableCount} electrical cable${
          source.electricalCableCount === 1 ? "" : "s"
        } connected; ${powerLabel(source.capacityW)} available`,
      );
    });
    if (unassignedPowerLoadCount > 0) {
      addItem(
        "Unassigned power loads",
        integerUnit.format(unassignedPowerLoadCount),
        `${powerLabel(unassignedLoadW)} total load not connected to a powered electrical path`,
      );
    }

    addSection("Network");
    ethernetSwitchPoeStats.forEach((switchStats) => {
      addItem(
        switchStats.name,
        `${switchStats.socketCapacity} port${switchStats.socketCapacity === 1 ? "" : "s"}`,
        `${switchStats.cableCount} cable${switchStats.cableCount === 1 ? "" : "s"} connected; ${
          switchStats.clientCount
        } PoE client${switchStats.clientCount === 1 ? "" : "s"}; ${powerLabel(
          switchStats.ownPowerW,
        )} switch load; ${powerLabel(
          switchStats.poeLoadW,
        )} PoE load; ${powerLabel(switchStats.totalRequiredPowerW)} total required`,
      );
    });

    document.save(`${(pdfName || "zuperpatch-plan").replace(/\.pdf$/i, "")}-bom.pdf`);
  }

  async function loadProjectFile(file: File | null) {
    if (!file) return;
    try {
      const project = JSON.parse(await file.text()) as PersistedProject;
      await applyProject(project);
      setStorageNotice("");
    } catch {
      setStorageNotice("Project file could not be loaded.");
    } finally {
      if (projectLoadInputRef.current) {
        projectLoadInputRef.current.value = "";
      }
    }
  }

  function pointerFromEvent(event: PointerEvent) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.min(Math.max((event.clientX - rect.left) / viewScale, 0), modelPageSize.width),
      y: Math.min(Math.max((event.clientY - rect.top) / viewScale, 0), modelPageSize.height),
    };
  }

  function handlePlanScroll(event: UIEvent<HTMLDivElement>) {
    const { scrollLeft, scrollTop } = event.currentTarget;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      setViewPosition((currentPosition) => {
        if (
          Math.abs(currentPosition.scrollLeft - scrollLeft) < 1 &&
          Math.abs(currentPosition.scrollTop - scrollTop) < 1
        ) {
          return currentPosition;
        }
        return { scrollLeft, scrollTop };
      });
    });
  }

  function handlePlanWheel(event: WheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const scrollElement = event.currentTarget;
    const stageElement = stageRef.current;
    if (!stageElement) return;

    const scrollRect = scrollElement.getBoundingClientRect();
    const cursorX = event.clientX - scrollRect.left;
    const cursorY = event.clientY - scrollRect.top;
    const contentX = scrollElement.scrollLeft + cursorX;
    const contentY = scrollElement.scrollTop + cursorY;
    const modelX = (contentX - stageElement.offsetLeft) / viewScale;
    const modelY = (contentY - stageElement.offsetTop) / viewScale;
    const delta =
      event.deltaY *
      (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scrollElement.clientHeight : 1);
    const nextZoom = clampNumber(
      Math.round(zoom * Math.exp(-delta * 0.0025) * 1000) / 1000,
      minZoom,
      maxZoom,
    );
    if (Math.abs(nextZoom - zoom) < 0.001) return;

    queueViewPositionRestore({
      scrollLeft: Math.max(0, stageElement.offsetLeft + modelX * nextZoom - cursorX),
      scrollTop: Math.max(0, stageElement.offsetTop + modelY * nextZoom - cursorY),
    });
    applyZoom(nextZoom);
  }

  function handleSpacePanPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!isSpacePressed || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const scrollElement = planScrollRef.current;
    if (!scrollElement) return;
    spacePanDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: scrollElement.scrollLeft,
      startScrollTop: scrollElement.scrollTop,
    };
    setIsPanningWithSpace(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleSpacePanPointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = spacePanDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const scrollElement = planScrollRef.current;
    if (!scrollElement) return;
    scrollElement.scrollLeft = drag.startScrollLeft + drag.startClientX - event.clientX;
    scrollElement.scrollTop = drag.startScrollTop + drag.startClientY - event.clientY;
  }

  function finishSpacePan(event?: PointerEvent<HTMLDivElement>) {
    const drag = spacePanDragRef.current;
    if (!drag) return;
    if (event && drag.pointerId !== event.pointerId) return;
    event?.preventDefault();
    event?.stopPropagation();
    if (event && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    spacePanDragRef.current = null;
    setIsPanningWithSpace(false);
  }

  function handlePointerDown(event: PointerEvent) {
    const point = pointerFromEvent(event);
    setSelectedId(null);
    setSelectedDeviceIds([]);
    setSelectedCablePoint(null);

    if (mode === "scale") {
      beginUndoGroup();
      setCalibration({ start: point, end: point });
      setScaleDraft(point);
      return;
    }

    if (mode === "measure") {
      setMeasurementDraft({
        id: createId("measurement"),
        page: pageNumber,
        start: point,
        end: point,
      });
      return;
    }

    if (mode === "cable") {
      addCablePoint(point, event.shiftKey || isShiftPressed);
      return;
    }

    if (mode === "device") {
      const producerCount = devices.filter((device) => device.type === "producer").length + 1;
      const consumerCount = devices.filter((device) => device.type === "consumer").length + 1;
      const switchCount = devices.filter((device) => device.type === "switch").length + 1;
      const ethernetClientCount =
        devices.filter((device) => device.type === "ethernetClient").length + 1;
      const device: Device = {
        id: createId("device"),
        type: activeDevice,
        page: pageNumber,
        point,
        labelPosition: "bottom",
        ...(activeDevice === "powerstrip"
          ? {
              desiredFreeSockets: 0,
            }
          : {}),
        ...(activeDevice === "producer"
          ? {
              name: `Power source ${producerCount}`,
              availablePowerW: 3600,
              socketCapacity: defaultPowerSourceSockets,
            }
          : {}),
        ...(activeDevice === "switch"
          ? {
              name: `Ethernet switch ${switchCount}`,
              powerW: 0,
              socketCapacity: defaultEthernetSwitchSockets,
            }
          : {}),
        ...(activeDevice === "ethernetClient"
          ? {
              name: `Ethernet client ${ethernetClientCount}`,
              poePowerW: 15,
            }
          : {}),
        ...(activeDevice === "consumer"
          ? {
              name: `Consumer ${consumerCount}`,
              powerW: 500,
              sourceMode: "auto",
            }
          : {}),
      };
      setDevices((current) => [...current, device]);
      selectDevices([device.id]);
    }
  }

  function handlePointerMove(event: PointerEvent) {
    const point = pointerFromEvent(event);
    if (draggingCablePoint) {
      const shouldConstrain = event.shiftKey || isShiftPressed;
      const excludedDeviceIdsForRoute = (route: CableRoute) => {
        const excludedDeviceIds =
          route.type === "power" ? new Set(directlyPoweredConsumerIds) : new Set<string>();
        if (draggingCablePoint.detachedDeviceId) {
          excludedDeviceIds.add(draggingCablePoint.detachedDeviceId);
        }
        return excludedDeviceIds;
      };
      setCables((current) => {
        const activeRoute = current.find((route) => route.id === draggingCablePoint.routeId);
        const activePoint = activeRoute
          ? cablePointForReference(activeRoute, draggingCablePoint)
          : undefined;
        if (!activeRoute || !activePoint) return current;

        const movingPointReferences = cablePointReferencesForRoutes(current).filter(
          (reference) =>
            reference.page === activeRoute.page && samePoint(reference.point, activePoint),
        );
        const movingPointKeys = new Set(movingPointReferences.map(cablePointKey));
        if (!movingPointKeys.has(cablePointKey(draggingCablePoint))) {
          movingPointReferences.push({
            page: activeRoute.page,
            point: activePoint,
            ...draggingCablePoint,
          });
          movingPointKeys.add(cablePointKey(draggingCablePoint));
        }

        let editedPoint = point;
        if (shouldConstrain) {
          if (
            draggingCablePoint.branchId !== undefined &&
            draggingCablePoint.branchPointIndex !== undefined
          ) {
            const branch = activeRoute.branches?.find(
              (currentBranch) => currentBranch.id === draggingCablePoint.branchId,
            );
            const anchor =
              draggingCablePoint.branchPointIndex === 0
                ? activeRoute.points[activeRoute.points.length - 1]
                : branch?.points[draggingCablePoint.branchPointIndex - 1];
            editedPoint = anchor ? constrainTo45Degrees(anchor, point) : point;
          } else if (draggingCablePoint.pointIndex !== undefined) {
            editedPoint = constrainEditedRoutePoint(
              activeRoute.points,
              draggingCablePoint.pointIndex,
              point,
            );
          }
        } else {
          editedPoint = snapIntermediateCablePointToAxis(
            activeRoute,
            draggingCablePoint,
            editedPoint,
            viewScale,
          );
        }

        const endpointDevice = isEndpointCablePoint(activeRoute, draggingCablePoint)
          ? closestCompatibleDeviceForCablePoint(
              editedPoint,
              activeRoute,
              devices,
              pixelsPerMeter,
              excludedDeviceIdsForRoute(activeRoute),
              draggingCablePoint,
            )
          : undefined;
        const snappedCablePoint = endpointDevice
          ? undefined
          : closestCablePointSnap(
              editedPoint,
              current,
              activeRoute.page,
              movingPointKeys,
              activeRoute.id,
              viewScale,
            );
        const finalPoint = endpointDevice?.point ?? snappedCablePoint ?? editedPoint;
        const movingReferencesByRoute = new Map<string, CablePointReference[]>();
        movingPointReferences.forEach((reference) => {
          movingReferencesByRoute.set(reference.routeId, [
            ...(movingReferencesByRoute.get(reference.routeId) ?? []),
            reference,
          ]);
        });

        return current.map((route) => {
          const movingReferences = movingReferencesByRoute.get(route.id);
          if (!movingReferences) return route;
          let editedRoute = route;
          movingReferences.forEach((reference) => {
            editedRoute = routeWithCablePoint(editedRoute, reference, finalPoint);
            if (isEndpointCablePoint(editedRoute, reference)) {
              editedRoute = routeWithEndpointDeviceId(
                editedRoute,
                reference,
                cablePointKey(reference) === cablePointKey(draggingCablePoint)
                  ? endpointDevice?.id
                  : undefined,
              );
            }
          });
          return editedRoute;
        });
      });
      return;
    }
    if (draggingDevice) {
      const attachedDevicePoint = constrainAttachedDevicePoint(
        point,
        draggingDevice.attachedCablePoints,
        cables,
        event.shiftKey || isShiftPressed,
        modelPageSize,
      );
      setDevices((current) =>
        current.map((device) =>
          device.id === draggingDevice.deviceId ? { ...device, point: attachedDevicePoint } : device,
        ),
      );
      if (draggingDevice.attachedCablePoints.length > 0) {
        setCables((current) =>
          current.map((route) => {
            const attachments = draggingDevice.attachedCablePoints.filter(
              (attachment) => attachment.routeId === route.id,
            );
            if (attachments.length === 0) return route;
            let nextRoute: CableRoute = {
              ...route,
              points: route.points.map((routePoint, index) => {
                const attachment = attachments.find(
                  (attachedPoint) => attachedPoint.pointIndex === index,
                );
                return attachment ? attachedDevicePoint : routePoint;
              }),
              branches: route.branches?.map((branch) => ({
                ...branch,
                points: branch.points.map((branchPoint, index) => {
                  const attachment = attachments.find(
                    (attachedPoint) =>
                      attachedPoint.branchId === branch.id &&
                      attachedPoint.branchPointIndex === index,
                  );
                  return attachment ? attachedDevicePoint : branchPoint;
                }),
              })),
            };
            attachments.forEach((attachment) => {
              nextRoute = routeWithEndpointDeviceId(
                nextRoute,
                attachment,
                draggingDevice.deviceId,
              );
            });
            return nextRoute;
          }),
        );
      }
      return;
    }
    if (mode === "scale" && scaleDraft && calibration) {
      setCalibration({ ...calibration, end: point });
      return;
    }
    if (mode === "measure" && measurementDraft) {
      setMeasurementDraft({ ...measurementDraft, end: point });
      return;
    }
    if (mode === "cable" && routeDraft.length > 0) {
      const lastPoint = routeDraft[routeDraft.length - 1];
      setCursorPoint(
        event.shiftKey || isShiftPressed
          ? constrainTo45Degrees(lastPoint, point)
          : point,
      );
    }
  }

  function handlePointerUp(event: PointerEvent) {
    finishUndoGroup();
    if (measurementDraft) {
      const finalMeasurement = { ...measurementDraft, end: pointerFromEvent(event) };
      if (distance(finalMeasurement.start, finalMeasurement.end) > 3) {
        setMeasurements((current) => [...current, finalMeasurement]);
      }
      setMeasurementDraft(null);
    }
    setScaleDraft(null);
    setDraggingDevice(null);
    setDraggingCablePoint(null);
  }

  function clearRouteDraft() {
    setRouteDraft([]);
    setRouteDraftDeviceIds([]);
    setCursorPoint(null);
  }

  function abortCableDraft() {
    clearRouteDraft();
    setSelectedCablePoint(null);
  }

  function commitRoute(points: Point[], deviceIds = routeDraftDeviceIds) {
    if (points.length < 2 || routePixels(points) < 6) return false;
    setCables((current) => [
      ...current,
      {
        id: createId("cable"),
        type: activeCable,
        page: pageNumber,
        points,
        endpointDeviceIds: endpointDeviceIdsForDraft(deviceIds),
      },
    ]);
    clearRouteDraft();
    return true;
  }

  function finishRoute() {
    const finalPoints = routeDraft.length > 1 ? routeDraft : draftRoute;
    if (!commitRoute(finalPoints)) {
      abortCableDraft();
    }
  }

  function undoLast() {
    const previousSnapshot = undoHistoryRef.current.pop();
    if (!previousSnapshot) return;

    applyingUndoRef.current = true;
    void restoreUndoSnapshot(previousSnapshot);
  }

  function deleteSelected() {
    const selectedDeviceIdSet = new Set(selectedDeviceIds);
    if (!selectedId && selectedDeviceIdSet.size === 0) return;
    setCables((current) =>
      selectedDeviceIdSet.size > 0
        ? current
        : current.filter((route) => route.id !== selectedId),
    );
    setDevices((current) =>
      current
        .filter((device) =>
          selectedDeviceIdSet.size > 0
            ? !selectedDeviceIdSet.has(device.id)
            : device.id !== selectedId,
        )
        .map((device) =>
          (selectedDeviceIdSet.size > 0
            ? device.sourceId && selectedDeviceIdSet.has(device.sourceId)
            : device.sourceId === selectedId)
            ? {
                ...device,
                sourceMode: "auto",
                sourceType: undefined,
                sourceId: undefined,
              }
            : device,
        ),
    );
    setSelectedId(null);
    setSelectedDeviceIds([]);
    setSelectedCablePoint(null);
  }

  function removeSelectedCablePoint() {
    if (!selectedCablePoint) return false;
    if (selectedCablePoint.branchId || selectedCablePoint.pointIndex === undefined) return false;
    const route = cables.find((currentRoute) => currentRoute.id === selectedCablePoint.routeId);
    if (
      !route ||
      selectedCablePoint.pointIndex <= 0 ||
      selectedCablePoint.pointIndex >= route.points.length - 1
    ) {
      return false;
    }

    setCables((current) =>
      current.map((currentRoute) =>
        currentRoute.id === selectedCablePoint.routeId
          ? {
              ...currentRoute,
              points: currentRoute.points.filter(
                (_point, index) => index !== selectedCablePoint.pointIndex,
              ),
            }
          : currentRoute,
      ),
    );
    setSelectedCablePoint(null);
    return true;
  }

  function pasteDevice(device: Device) {
    const visualOffset = 28 / viewScale;
    const pastedDevice = {
      ...device,
      id: createId("device"),
      page: pageNumber,
      point: {
        x: Math.min(Math.max(device.point.x + visualOffset, 0), modelPageSize.width),
        y: Math.min(Math.max(device.point.y + visualOffset, 0), modelPageSize.height),
      },
      name: device.name ? `${device.name} copy` : device.name,
    };
    setDevices((current) => [...current, pastedDevice]);
    setCopiedDevice(pastedDevice);
    setSelectedId(pastedDevice.id);
    setSelectedDeviceIds([pastedDevice.id]);
    setPoppedDeviceId(pastedDevice.id);
  }

  function selectDevices(deviceIds: string[]) {
    setSelectedDeviceIds(deviceIds);
    setSelectedId(deviceIds[0] ?? null);
    setSelectedCablePoint(null);
  }

  function toggleDeviceSelection(deviceId: string) {
    setSelectedDeviceIds((currentSelection) => {
      const currentDeviceIds =
        currentSelection.length > 0
          ? currentSelection
          : selectedId && devices.some((device) => device.id === selectedId)
            ? [selectedId]
            : [];
      const nextSelection = currentDeviceIds.includes(deviceId)
        ? currentDeviceIds.filter((currentId) => currentId !== deviceId)
        : [...currentDeviceIds, deviceId];
      setSelectedId(nextSelection[0] ?? null);
      setSelectedCablePoint(null);
      return nextSelection;
    });
  }

  function updateDevice(id: string, updates: Partial<Device>) {
    setDevices((current) =>
      current.map((device) => (device.id === id ? { ...device, ...updates } : device)),
    );
  }

  function updateSelectedDevices(updates: Partial<Device>) {
    const selectedIdSet = new Set(selectedDeviceIds);
    if (selectedIdSet.size === 0) return;
    setDevices((current) =>
      current.map((device) =>
        selectedIdSet.has(device.id) ? { ...device, ...updates } : device,
      ),
    );
  }

  function applyZoom(nextZoom: number) {
    const clampedZoom = clampNumber(nextZoom, minZoom, maxZoom);
    if (pdfDoc) {
      setPageSize({
        width: modelPageSize.width * clampedZoom,
        height: modelPageSize.height * clampedZoom,
      });
    }
    setZoom(clampedZoom);
    return clampedZoom;
  }

  function updateZoom(nextZoom: number) {
    applyZoom(Math.round(nextZoom * 10) / 10);
  }

  function addCablePoint(point: Point, constrain: boolean, deviceId?: string) {
    const targetDevice = deviceId
      ? devices.find((device) => device.id === deviceId)
      : undefined;
    if (
      targetDevice &&
      (!canAddCablePointForDevice(activeCable, targetDevice, cables, routeDraftDeviceIds) ||
        (activeCable === "power" &&
          (targetDevice.type === "consumer" || targetDevice.type === "switch") &&
          directlyPoweredConsumerIds.has(targetDevice.id)))
    ) {
      abortCableDraft();
      return;
    }
    const nextPoint =
      constrain && routeDraft.length > 0
        ? constrainTo45Degrees(routeDraft[routeDraft.length - 1], point)
        : point;
    const nextDraft = routeDraft.length ? [...routeDraft, nextPoint] : [nextPoint];
    const nextDeviceIds = routeDraft.length
      ? [...routeDraftDeviceIds.slice(0, routeDraft.length), deviceId]
      : [deviceId];
    const startDeviceId = nextDeviceIds[0];
    const startDevice = startDeviceId
      ? devices.find((device) => device.id === startDeviceId)
      : undefined;
    const endDevice = targetDevice;

    if (
      nextDraft.length > 1 &&
      startDevice &&
      endDevice &&
      !canCableConnectDevices(activeCable, startDevice, endDevice)
    ) {
      abortCableDraft();
      return;
    }

    if (
      nextDraft.length > 1 &&
      startDevice &&
      endDevice &&
      canCableConnectDevices(activeCable, startDevice, endDevice) &&
      distance(nextDraft[0], startDevice.point) <= 1 &&
      distance(nextPoint, endDevice.point) <= 1 &&
      commitRoute(nextDraft, nextDeviceIds)
    ) {
      return;
    }

    setRouteDraft(nextDraft);
    setRouteDraftDeviceIds(nextDeviceIds);
    setCursorPoint(nextPoint);
  }

  function cableAttachmentDeviceIdForClick(device: Device) {
    if (!canAddCablePointForDevice(activeCable, device, cables, routeDraftDeviceIds)) {
      return undefined;
    }
    if (
      activeCable === "power" &&
      (device.type === "consumer" || device.type === "switch") &&
      directlyPoweredConsumerIds.has(device.id)
    ) {
      return undefined;
    }

    const startDeviceId = routeDraftDeviceIds[0];
    const startDevice = startDeviceId
      ? devices.find((currentDevice) => currentDevice.id === startDeviceId)
      : undefined;
    if (routeDraft.length > 0 && startDevice && !canCableConnectDevices(activeCable, startDevice, device)) {
      return undefined;
    }

    return device.id;
  }

  function insertCablePoint(routeId: string, event: PointerEvent<SVGGElement>) {
    event.stopPropagation();
    const route = cables.find((currentRoute) => currentRoute.id === routeId);
    if (!route) return;
    const insertion = insertionPointForRoute(pointerFromEvent(event), route);
    if (!insertion) return;

    setCables((current) =>
      current.map((currentRoute) =>
        currentRoute.id === routeId
          ? {
              ...currentRoute,
              points: [
                ...currentRoute.points.slice(0, insertion.pointIndex),
                clampPoint(insertion.point, modelPageSize),
                ...currentRoute.points.slice(insertion.pointIndex),
              ],
            }
          : currentRoute,
      ),
    );
    setSelectedId(routeId);
    setSelectedDeviceIds([]);
    setSelectedCablePoint({ routeId, pointIndex: insertion.pointIndex });
    setDraggingCablePoint({ routeId, pointIndex: insertion.pointIndex });
    setMode("select");
  }

  function addCableSplit(routeId: string) {
    setCables((current) =>
      current.map((route) => {
        if (route.id !== routeId || route.points.length === 0) return route;
        const splitPoint = route.points[route.points.length - 1];
        const branches = route.branches ?? [];
        if (branches.length === 0) {
          return {
            ...route,
            branches: [
              {
                id: createId("branch"),
                points: [
                  clampPoint({ x: splitPoint.x - 24, y: splitPoint.y + 32 }, modelPageSize),
                ],
              },
              {
                id: createId("branch"),
                points: [
                  clampPoint({ x: splitPoint.x + 24, y: splitPoint.y + 32 }, modelPageSize),
                ],
              },
            ],
          };
        }
        const direction = branches.length % 2 === 0 ? 1 : -1;
        return {
          ...route,
          branches: [
            ...branches,
            {
              id: createId("branch"),
              points: [
                clampPoint(
                  {
                    x: splitPoint.x + direction * (28 + branches.length * 12),
                    y: splitPoint.y + 32,
                  },
                  modelPageSize,
                ),
              ],
            },
          ],
        };
      }),
    );
    setSelectedId(routeId);
    setSelectedDeviceIds([]);
    setSelectedCablePoint(null);
    setMode("select");
  }

  const draftMeters =
    draftRoute.length > 1 && pixelsPerMeter ? routePixels(draftRoute) / pixelsPerMeter : 0;
  const visibleMeasurements = [
    ...measurements,
    ...(measurementDraft ? [measurementDraft] : []),
  ].filter((measurement) => measurement.page === pageNumber);
  const selectedCableRoute = currentCables.find((route) => route.id === selectedId);
  const selectedMultiConsumerSourceValue =
    selectedCommonDeviceType !== "consumer"
      ? "mixed"
      : selectedCommonSourceSelection ?? "mixed";
  const visibleAutoSourceAssignments = useMemo(
    () =>
      [...currentConsumerSourceAssignments, ...currentPowerstripSourceAssignments].filter(
        (
          assignment,
        ): assignment is ResolvedConsumerSource & { source: ConsumerSource; targetPoint: Point } => {
          if (!assignment.source || !assignment.targetPoint) {
            return false;
          }
          const isVisibleSourceLink =
            assignment.autoAssigned || isManualProducerSourceAssignment(assignment);
          if (!isVisibleSourceLink) return false;
          const linkId = autoSourceLinkId(assignment.consumer.id, assignment.source);
          const isFlowing = selectedAutoSourceFlowIds.has(linkId);
          return (
            (assignment.consumer.id !== selectedDevice?.id || isFlowing) &&
            !(
              selectedDevice?.type === "producer" &&
              !isFlowing &&
              (assignment.source.type === "producer"
                ? assignment.source.id === selectedDevice.id
                : assignment.source.type === "powerstrip"
                  ? producerIdForPowerstripWithAuto(assignment.source.id) === selectedDevice.id
                  : assignment.source.route &&
                    upstreamProducerIdForPowerRoute(
                      assignment.source.route,
                      devicesById,
                      cables,
                    ) === selectedDevice.id)
            )
          );
        },
      ),
    [
      cables,
      currentConsumerSourceAssignments,
      currentPowerstripSourceAssignments,
      devicesById,
      producerIdForPowerstripWithAuto,
      selectedAutoSourceFlowIds,
      selectedDevice,
    ],
  );
  const routedAutoSourceLinks = useMemo(
    () =>
      routeAutoSourceLinks(
        visibleAutoSourceAssignments
          .filter((assignment) => !isManualProducerSourceAssignment(assignment))
          .map((assignment) => ({
            end: assignment.targetPoint,
            id: autoSourceLinkId(assignment.consumer.id, assignment.source),
            start: assignment.consumer.point,
          })),
      ),
    [visibleAutoSourceAssignments],
  );

  function beginCablePointDrag(routeId: string, event: PointerEvent<SVGCircleElement>) {
    event.stopPropagation();
    beginUndoGroup();
    setSelectedId(routeId);
    setSelectedDeviceIds([]);
    setMode("select");
    const branchId = event.currentTarget.dataset.branchId;
    let dragPoint: DraggingCablePoint;
    if (branchId) {
      const branchPointIndex = Number(event.currentTarget.dataset.branchPointIndex);
      dragPoint = { routeId, branchId, branchPointIndex };
    } else {
      const pointIndex = Number(event.currentTarget.dataset.pointIndex);
      dragPoint = { routeId, pointIndex };
    }
    const route = currentCables.find((currentRoute) => currentRoute.id === routeId);
    const detachedDeviceId = route ? endpointDeviceIdForPoint(route, dragPoint) : undefined;
    const dragState = { ...dragPoint, detachedDeviceId };
    setSelectedCablePoint(dragPoint);
    setDraggingCablePoint(dragState);
    if (detachedDeviceId) {
      setCables((current) =>
        current.map((currentRoute) =>
          currentRoute.id === routeId
            ? routeWithEndpointDeviceId(currentRoute, dragPoint, undefined)
            : currentRoute,
        ),
      );
    }
  }

  return (
    <main className="app-shell">
      <aside className="side-panel tools-panel" aria-label="Planning tools">
        <div className="tools-scroll">
          <div className="brand">
            <CircuitBoard aria-hidden="true" />
            <div>
              <h1>ZuperPatch!</h1>
              <p>Cable length planner</p>
            </div>
          </div>

          <label className="upload-control">
            <FileUp aria-hidden="true" />
            <span>{pdfName || "Upload floor plan PDF"}</span>
            <input
              aria-label="Upload floor plan PDF"
              accept="application/pdf"
              type="file"
              onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
            />
          </label>
          {storageNotice && (
            <p className="autosave-status warning">
              {storageNotice}
            </p>
          )}

          <section className="tool-group" aria-label="Mode">
            <h2>Mode</h2>
            <div className="segmented">
              <button
                className={mode === "select" ? "active" : ""}
                type="button"
                onClick={() => setMode("select")}
              >
                <MousePointer2 aria-hidden="true" />
                Select
              </button>
              <button
                className={mode === "scale" ? "active" : ""}
                type="button"
                onClick={() => setMode("scale")}
              >
                <Ruler aria-hidden="true" />
                Scale
              </button>
              <button
                className={mode === "measure" ? "active" : ""}
                type="button"
                onClick={() => setMode("measure")}
              >
                <PencilRuler aria-hidden="true" />
                Measure
              </button>
              <button
                className={planningMode ? "active wide-segment" : "wide-segment"}
                type="button"
                onClick={() => setMode(planningMode ? mode : "cable")}
              >
                <Cable aria-hidden="true" />
                Cable / Device
              </button>
            </div>
          </section>

        {planningMode && (
          <section className="tool-group" aria-label="Cable types">
            <h2>Cable type</h2>
            <div className="option-list">
              {Object.values(cableTypes).map((type) => (
                <button
                  aria-pressed={mode === "cable" && activeCable === type.id}
                  className={[
                    "option",
                    "cable-type-option",
                    `cable-type-${type.id}`,
                    mode === "cable" && activeCable === type.id ? "active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={type.id}
                  type="button"
                  onClick={() => {
                    setActiveCable(type.id);
                    setMode("cable");
                  }}
                  onMouseEnter={() => setHoveredCableType(type.id)}
                  onMouseLeave={() => setHoveredCableType(null)}
                  onPointerEnter={() => setHoveredCableType(type.id)}
                  onPointerLeave={() => setHoveredCableType(null)}
                >
                  <span
                    className="swatch"
                    style={{
                      background: `linear-gradient(90deg, ${type.colorStart}, ${type.colorEnd})`,
                    }}
                  />
                  <span>
                    <strong>{type.label}</strong>
                    <small>Max {lengthLabel(type.maxLengthM)}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {planningMode && (
          <section className="tool-group" aria-label="Device types">
            <h2>Devices</h2>
            <div className="option-list">
              {Object.values(deviceTypes).map((type) => {
                const Icon = type.icon;
                return (
                  <button
                    aria-pressed={mode === "device" && activeDevice === type.id}
                    className={
                      mode === "device" && activeDevice === type.id ? "option active" : "option"
                    }
                    key={type.id}
                    type="button"
                    onClick={() => {
                      setActiveDevice(type.id);
                      setMode("device");
                    }}
                  >
                    <Icon aria-hidden="true" style={{ color: type.color }} />
                    <span>
                      <strong>{type.label}</strong>
                      <small>{type.detail}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {mode === "scale" && (
          <section className="tool-group" aria-label="Scale calibration">
            <h2>Scale</h2>
            <label className="field">
              <span>Known distance</span>
              <div className="input-row">
                <input
                  inputMode="decimal"
                  min="0.1"
                  step="0.1"
                  type="number"
                  value={knownDistance}
                  onChange={(event) => setKnownDistance(event.target.value)}
                />
                <span>m</span>
              </div>
            </label>
            <div className={pixelsPerMeter ? "status ready" : "status"}>
              <Gauge aria-hidden="true" />
              {pixelsPerMeter
                ? `${unit.format(pixelsPerMeter)} px per meter`
                : "Draw a known distance"}
            </div>
          </section>
        )}

        {selectedDeviceCount > 1 && (
          <section className="tool-group editor-panel" aria-label="Selected devices">
            <h2>{selectedDeviceCount} devices</h2>
            <p className="source-status">
              Common properties are applied to every selected device.
            </p>

            {(selectedCommonDeviceType === "producer" ||
              selectedCommonDeviceType === "switch" ||
              selectedCommonDeviceType === "consumer" ||
              selectedCommonDeviceType === "ethernetClient") && (
              <label className="field">
                <span>Name</span>
                <input
                  className="text-input"
                  placeholder={selectedCommonName === undefined ? "Mixed" : undefined}
                  value={selectedCommonName ?? ""}
                  onChange={(event) =>
                    updateSelectedDevices({ name: event.target.value })
                  }
                />
              </label>
            )}

            {selectedCommonDeviceType === "powerstrip" && (
              <label className="field">
                <span>Desired free sockets</span>
                <div className="input-row">
                  <input
                    inputMode="numeric"
                    min="0"
                    placeholder={selectedCommonDesiredFreeSockets === undefined ? "Mixed" : undefined}
                    step="1"
                    type="number"
                    value={selectedCommonDesiredFreeSockets ?? ""}
                    onChange={(event) =>
                      updateSelectedDevices({
                        desiredFreeSockets: Math.max(
                          0,
                          Math.floor(Number(event.target.value) || 0),
                        ),
                      })
                    }
                  />
                  <span>free</span>
                </div>
              </label>
            )}

            {selectedCommonDeviceType === "producer" && (
              <label className="field">
                <span>Available power</span>
                <div className="input-row">
                  <input
                    inputMode="decimal"
                    min="0"
                    placeholder={selectedCommonAvailablePowerW === undefined ? "Mixed" : undefined}
                    step="50"
                    type="number"
                    value={selectedCommonAvailablePowerW ?? ""}
                    onChange={(event) =>
                      updateSelectedDevices({
                        availablePowerW: Math.max(0, Number(event.target.value) || 0),
                      })
                    }
                  />
                  <span>W</span>
                </div>
              </label>
            )}

            {(selectedCommonDeviceType === "consumer" ||
              selectedCommonDeviceType === "switch") && (
              <label className="field">
                <span>Required power</span>
                <div className="input-row">
                  <input
                    inputMode="decimal"
                    min="0"
                    placeholder={selectedCommonRequiredPowerW === undefined ? "Mixed" : undefined}
                    step="10"
                    type="number"
                    value={selectedCommonRequiredPowerW ?? ""}
                    onChange={(event) =>
                      updateSelectedDevices({
                        powerW: Math.max(0, Number(event.target.value) || 0),
                      })
                    }
                  />
                  <span>W</span>
                </div>
              </label>
            )}

            {selectedCommonDeviceType === "consumer" && (
              <label className="field">
                <span>Power source</span>
                <select
                  className="select-input"
                  value={selectedMultiConsumerSourceValue}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "auto") {
                      updateSelectedDevices({
                        sourceMode: "auto",
                        sourceType: undefined,
                        sourceId: undefined,
                      });
                      return;
                    }
                    if (value === "none") {
                      updateSelectedDevices({
                        sourceMode: "manual",
                        sourceType: undefined,
                        sourceId: undefined,
                      });
                      return;
                    }
                    const [sourceType, sourceId] = value.split(":") as [
                      ConsumerSourceType,
                      string,
                    ];
                    updateSelectedDevices({
                      sourceMode: "manual",
                      sourceType,
                      sourceId,
                    });
                  }}
                >
                  <option disabled value="mixed">
                    Mixed
                  </option>
                  <option value="auto">Auto closest source/end within 1.5 m</option>
                  <option value="none">Unassigned</option>
                  {powerSources
                    .filter((source) =>
                      selectedCommonPage !== undefined
                        ? source.page === selectedCommonPage
                        : source.page === pageNumber,
                    )
                    .map((source) => (
                      <option key={`${source.type}:${source.id}`} value={sourceValue(source)}>
                        {sourceLabel(source)}
                      </option>
                    ))}
                </select>
              </label>
            )}

            {selectedCommonDeviceType === "ethernetClient" && (
              <label className="field">
                <span>PoE required power</span>
                <div className="input-row">
                  <input
                    inputMode="decimal"
                    min="0"
                    placeholder={selectedCommonPoePowerW === undefined ? "Mixed" : undefined}
                    step="1"
                    type="number"
                    value={selectedCommonPoePowerW ?? ""}
                    onChange={(event) =>
                      updateSelectedDevices({
                        poePowerW: Math.max(0, Number(event.target.value) || 0),
                      })
                    }
                  />
                  <span>W</span>
                </div>
              </label>
            )}

            {(selectedCommonDeviceType === "producer" ||
              selectedCommonDeviceType === "switch" ||
              selectedDevicesAllHaveSocketCapacity) && (
              <label className="field">
                <span>
                  {selectedCommonDeviceType === "switch"
                    ? "Ethernet sockets"
                    : selectedCommonDeviceType === "producer"
                      ? "Power sockets"
                      : "Sockets / ports"}
                </span>
                <div className="input-row">
                  <input
                    inputMode="numeric"
                    min="0"
                    placeholder={selectedCommonSocketCapacity === undefined ? "Mixed" : undefined}
                    step="1"
                    type="number"
                    value={selectedCommonSocketCapacity ?? ""}
                    onChange={(event) =>
                      updateSelectedDevices({
                        socketCapacity: Math.max(
                          0,
                          Math.floor(Number(event.target.value) || 0),
                        ),
                      })
                    }
                  />
                  <span>{selectedCommonDeviceType === "switch" ? "ports" : "outlets"}</span>
                </div>
              </label>
            )}

            <div className="compact-segmented">
              {(["top", "right", "bottom", "left"] as LabelPosition[]).map((position) => (
                <button
                  className={selectedCommonLabelPosition === position ? "active" : ""}
                  key={position}
                  type="button"
                  onClick={() => updateSelectedDevices({ labelPosition: position })}
                >
                  {position[0].toUpperCase() + position.slice(1)}
                </button>
              ))}
            </div>
          </section>
        )}

        {selectedDevice?.type === "powerstrip" && (
          <section className="tool-group editor-panel" aria-label="Selected powerstrip">
            <h2>Powerstrip</h2>
            <label className="field">
              <span>Desired free sockets</span>
              <div className="input-row">
                <input
                  inputMode="numeric"
                  min="0"
                  step="1"
                  type="number"
                  value={selectedDevice.desiredFreeSockets ?? 0}
                  onChange={(event) =>
                    updateDevice(selectedDevice.id, {
                      desiredFreeSockets: Math.max(
                        0,
                        Math.floor(Number(event.target.value) || 0),
                      ),
                    })
                  }
                />
                <span>free</span>
              </div>
            </label>
            <div className="status ready">
              <PlugZap aria-hidden="true" />
              {selectedPowerstripStats?.socketCapacity ?? 0} socket
              {(selectedPowerstripStats?.socketCapacity ?? 0) === 1 ? "" : "s"}
              {" "}
              ({selectedPowerstripStats?.occupiedSocketCount ?? 0} occupied,{" "}
              {selectedPowerstripStats?.desiredFreeSockets ?? 0} desired free
              {(selectedPowerstripStats?.feedCableCount ?? 0) > 0
                ? `, ${selectedPowerstripStats?.feedCableCount ?? 0} feed`
                : ""}
              )
            </div>
          </section>
        )}

        {selectedDevice?.type === "switch" && (
          <section className="tool-group editor-panel" aria-label="Selected Ethernet switch">
            <h2>Ethernet switch</h2>
            <label className="field">
              <span>Name</span>
              <input
                className="text-input"
                value={selectedDevice.name ?? ""}
                onChange={(event) =>
                  updateDevice(selectedDevice.id, { name: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Required power</span>
              <div className="input-row">
                <input
                  inputMode="decimal"
                  min="0"
                  step="1"
                  type="number"
                  value={selectedDevice.powerW ?? 0}
                  onChange={(event) =>
                    updateDevice(selectedDevice.id, {
                      powerW: Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                />
                <span>W</span>
              </div>
            </label>
            <label className="field">
              <span>Ethernet sockets</span>
              <div className="input-row">
                <input
                  inputMode="numeric"
                  min="0"
                  step="1"
                  type="number"
                  value={selectedSwitchSocketCapacity}
                  onChange={(event) =>
                    updateDevice(selectedDevice.id, {
                      socketCapacity: Math.max(
                        0,
                        Math.floor(Number(event.target.value) || 0),
                      ),
                    })
                  }
                />
                <span>ports</span>
              </div>
            </label>
            <div className={selectedSwitchOverSockets ? "status warning" : "status ready"}>
              <Cable aria-hidden="true" />
              {selectedSwitchCableCount} / {selectedSwitchSocketCapacity} Ethernet socket
              {selectedSwitchSocketCapacity === 1 ? "" : "s"} used
            </div>
            <div className="status ready">
              <EthernetPort aria-hidden="true" />
              {powerLabel(selectedSwitchPoeStats?.totalRequiredPowerW ?? 0)} total required
              {" "}({powerLabel(selectedSwitchPoeStats?.ownPowerW ?? 0)} switch +{" "}
              {powerLabel(selectedSwitchPoeStats?.poeLoadW ?? 0)} PoE)
            </div>
          </section>
        )}

        {selectedDevice?.type === "ethernetClient" && (
          <section className="tool-group editor-panel" aria-label="Selected Ethernet client">
            <h2>Ethernet client</h2>
            <label className="field">
              <span>Name</span>
              <input
                className="text-input"
                value={selectedDevice.name ?? ""}
                onChange={(event) =>
                  updateDevice(selectedDevice.id, { name: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>PoE required power</span>
              <div className="input-row">
                <input
                  inputMode="decimal"
                  min="0"
                  step="1"
                  type="number"
                  value={selectedDevice.poePowerW ?? 0}
                  onChange={(event) =>
                    updateDevice(selectedDevice.id, {
                      poePowerW: Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                />
                <span>W</span>
              </div>
            </label>
            <p className="source-status">
              {selectedEthernetClientAssignment?.switchDevice
                ? `PoE load assigned to ${
                    selectedEthernetClientAssignment.switchDevice.name || "Ethernet switch"
                  }`
                : "Ethernet clients only connect through an Ethernet switch."}
            </p>
          </section>
        )}

        {selectedDevice?.type === "producer" && (
          <section className="tool-group editor-panel" aria-label="Selected power source">
            <h2>Power source</h2>
            <label className="field">
              <span>Name</span>
              <input
                className="text-input"
                value={selectedDevice.name ?? ""}
                onChange={(event) =>
                  updateDevice(selectedDevice.id, { name: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Available power</span>
              <div className="input-row">
                <input
                  inputMode="decimal"
                  min="0"
                  step="50"
                  type="number"
                  value={selectedDevice.availablePowerW ?? 0}
                  onChange={(event) =>
                    updateDevice(selectedDevice.id, {
                      availablePowerW: Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                />
                <span>W</span>
              </div>
            </label>
            <label className="field">
              <span>Power sockets</span>
              <div className="input-row">
                <input
                  inputMode="numeric"
                  min="0"
                  step="1"
                  type="number"
                  value={selectedProducerSocketCapacity}
                  onChange={(event) =>
                    updateDevice(selectedDevice.id, {
                      socketCapacity: Math.max(
                        0,
                        Math.floor(Number(event.target.value) || 0),
                      ),
                    })
                  }
                />
                <span>outlets</span>
              </div>
            </label>
            <div className={selectedProducerOverSockets ? "status warning" : "status ready"}>
              <Cable aria-hidden="true" />
              {selectedProducerCableCount} / {selectedProducerSocketCapacity} electrical socket
              {selectedProducerSocketCapacity === 1 ? "" : "s"} used
            </div>
          </section>
        )}

        {selectedDevice?.type === "consumer" && (
          <section className="tool-group editor-panel" aria-label="Selected consumer">
            <h2>Consumer</h2>
            <label className="field">
              <span>Name</span>
              <input
                className="text-input"
                value={selectedDevice.name ?? ""}
                onChange={(event) =>
                  updateDevice(selectedDevice.id, { name: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Required power</span>
              <div className="input-row">
                <input
                  inputMode="decimal"
                  min="0"
                  step="10"
                  type="number"
                  value={selectedDevice.powerW ?? 0}
                  onChange={(event) =>
                    updateDevice(selectedDevice.id, {
                      powerW: Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                />
                <span>W</span>
              </div>
            </label>
            <label className="field">
              <span>Power source</span>
              <select
                className="select-input"
                value={
                  (selectedDevice.sourceMode ?? "auto") === "auto"
                    ? "auto"
                    : selectedDevice.sourceType && selectedDevice.sourceId
                      ? sourceValue({
                          type: selectedDevice.sourceType,
                          id: selectedDevice.sourceId,
                        })
                      : "none"
                }
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "auto") {
                    updateDevice(selectedDevice.id, {
                      sourceMode: "auto",
                      sourceType: undefined,
                      sourceId: undefined,
                    });
                    return;
                  }
                  if (value === "none") {
                    updateDevice(selectedDevice.id, {
                      sourceMode: "manual",
                      sourceType: undefined,
                      sourceId: undefined,
                    });
                    return;
                  }
                  const [sourceType, sourceId] = value.split(":") as [
                    ConsumerSourceType,
                    string,
                  ];
                  updateDevice(selectedDevice.id, {
                    sourceMode: "manual",
                    sourceType,
                    sourceId,
                  });
                }}
              >
                <option value="auto">Auto closest source/end within 1.5 m</option>
                <option value="none">Unassigned</option>
                {powerSources
                  .filter((source) => source.page === selectedDevice.page)
                  .map((source) => (
                    <option key={`${source.type}:${source.id}`} value={sourceValue(source)}>
                      {sourceLabel(source)}
                    </option>
                  ))}
              </select>
            </label>
            <p className="source-status">
              {selectedConsumerHasDirectPower
                ? "Direct: Electrical cable"
                : (selectedDevice.sourceMode ?? "auto") === "auto"
                ? selectedConsumerAssignment?.source
                  ? `Auto: ${sourceLabel(selectedConsumerAssignment.source)}`
                  : "Auto: no source or cable end within 1.5 m"
                : `Manual: ${sourceLabel(selectedConsumerAssignment?.source)}`}
            </p>
          </section>
        )}

        {selectedCableRoute && (
          <section className="tool-group editor-panel" aria-label="Selected cable split">
            <h2>Cable split</h2>
            <button type="button" onClick={() => addCableSplit(selectedCableRoute.id)}>
              <GitBranch aria-hidden="true" />
              {(selectedCableRoute.branches?.length ?? 0) > 0
                ? "Add split end"
                : "Create two-way split"}
            </button>
            <div className="status ready">
              <Cable aria-hidden="true" />
              {(selectedCableRoute.branches?.length ?? 0) > 0
                ? `${selectedCableRoute.branches?.length ?? 0} cable ends after split`
                : "Single cable run"}
            </div>
            <p className="source-status">
              Split routes share one visual trunk, but stats count the trunk once per branch plus
              each branch leg.
            </p>
          </section>
        )}

        {selectedDevice && (
          <section className="tool-group editor-panel" aria-label="Selected device label">
            <h2>Label</h2>
            <div className="compact-segmented">
              <button
                className={(selectedDevice.labelPosition ?? "bottom") === "top" ? "active" : ""}
                type="button"
                onClick={() =>
                  updateDevice(selectedDevice.id, { labelPosition: "top" })
                }
              >
                Top
              </button>
              <button
                className={(selectedDevice.labelPosition ?? "bottom") === "right" ? "active" : ""}
                type="button"
                onClick={() =>
                  updateDevice(selectedDevice.id, { labelPosition: "right" })
                }
              >
                Right
              </button>
              <button
                className={(selectedDevice.labelPosition ?? "bottom") === "bottom" ? "active" : ""}
                type="button"
                onClick={() =>
                  updateDevice(selectedDevice.id, { labelPosition: "bottom" })
                }
              >
                Bottom
              </button>
              <button
                className={(selectedDevice.labelPosition ?? "bottom") === "left" ? "active" : ""}
                type="button"
                onClick={() =>
                  updateDevice(selectedDevice.id, { labelPosition: "left" })
                }
              >
                Left
              </button>
            </div>
          </section>
        )}
        </div>

        <section className="tool-group view-controls" aria-label="View controls">
          <h2>View</h2>
          <div className="field">
            <span>Electrical color</span>
            <div
              className="compact-segmented connected-segmented"
              role="group"
              aria-label="Electrical color mode"
            >
              <button
                className={electricalColorMode === "length" ? "active" : ""}
                type="button"
                onClick={() => setElectricalColorMode("length")}
              >
                Length
              </button>
              <button
                className={electricalColorMode === "load" ? "active" : ""}
                type="button"
                onClick={() => setElectricalColorMode("load")}
              >
                Load
              </button>
            </div>
          </div>
          <div className="field slider-field">
            <span>Zoom</span>
            <div className="slider-row zoom-slider-row">
              <button
                aria-label="Zoom out"
                className="slider-step-button"
                disabled={zoom <= minZoom}
                type="button"
                onClick={() => updateZoom(zoom - zoomStep)}
              >
                <Minus aria-hidden="true" />
              </button>
              <input
                aria-label="Zoom"
                max={maxZoom}
                min={minZoom}
                step="0.1"
                type="range"
                value={zoom}
                onChange={(event) => updateZoom(Number(event.target.value))}
              />
              <button
                aria-label="Zoom in"
                className="slider-step-button"
                disabled={zoom >= maxZoom}
                type="button"
                onClick={() => updateZoom(zoom + zoomStep)}
              >
                <Plus aria-hidden="true" />
              </button>
              <output>{Math.round(zoom * 100)}%</output>
            </div>
          </div>
          <label className="field slider-field">
            <span>Floor plan opacity</span>
            <div className="slider-row">
              <input
                aria-label="Floor plan opacity"
                max="1"
                min="0.1"
                step="0.05"
                type="range"
                value={floorPlanOpacity}
                onChange={(event) => setFloorPlanOpacity(Number(event.target.value))}
              />
              <output>{Math.round(floorPlanOpacity * 100)}%</output>
            </div>
          </label>
          <label className="toggle-field">
            <input
              checked={animateOrphans}
              type="checkbox"
              onChange={(event) => setAnimateOrphans(event.target.checked)}
            />
            <span>Animate orphans</span>
          </label>
        </section>
      </aside>

      <section className="workspace" aria-label="Floor plan workspace">
        <header className="topbar">
          <div className="page-controls">
            <button
              aria-label="Previous page"
              disabled={!pdfDoc || pageNumber <= 1}
              type="button"
              onClick={() => setPageNumber((page) => Math.max(1, page - 1))}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <span>
              Page {pageNumber}
              {pageCount ? ` of ${pageCount}` : ""}
            </span>
            <button
              aria-label="Next page"
              disabled={!pdfDoc || pageNumber >= pageCount}
              type="button"
              onClick={() => setPageNumber((page) => Math.min(pageCount, page + 1))}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          <div className="action-strip">
            <button type="button" onClick={downloadProject}>
              <Download aria-hidden="true" />
              Download
            </button>
            <button type="button" onClick={downloadPlanPdf}>
              <Download aria-hidden="true" />
              Plan PDF
            </button>
            <button type="button" onClick={downloadBillOfMaterials}>
              <Download aria-hidden="true" />
              BOM PDF
            </button>
            <button type="button" onClick={() => projectLoadInputRef.current?.click()}>
              <Upload aria-hidden="true" />
              Load
            </button>
            <input
              accept="application/json,.json"
              className="hidden-file-input"
              onChange={(event) => loadProjectFile(event.target.files?.[0] ?? null)}
              ref={projectLoadInputRef}
              type="file"
            />
            <button type="button" onClick={undoLast}>
              <Undo2 aria-hidden="true" />
              Undo
            </button>
            <button
              type="button"
              disabled={!selectedId && selectedDeviceIds.length === 0}
              onClick={deleteSelected}
            >
              <Trash2 aria-hidden="true" />
              Delete
            </button>
          </div>
        </header>

        <div
          className={[
            "plan-scroll",
            isSpacePressed ? "space-panning" : "",
            isPanningWithSpace ? "is-panning" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onPointerCancelCapture={finishSpacePan}
          onPointerDownCapture={handleSpacePanPointerDown}
          onPointerMoveCapture={handleSpacePanPointerMove}
          onPointerUpCapture={finishSpacePan}
          onScroll={handlePlanScroll}
          onWheel={handlePlanWheel}
          ref={planScrollRef}
        >
          <div
            className={`plan-stage mode-${mode}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            ref={stageRef}
            style={{ width: pageSize.width, height: pageSize.height }}
          >
            <canvas
              aria-label="Rendered floor plan"
              className={pdfDoc ? "pdf-canvas" : "pdf-canvas empty"}
              ref={canvasRef}
              style={{ opacity: floorPlanOpacity }}
            />
            {!pdfDoc && (
              <div className="empty-state">
                <FileUp aria-hidden="true" />
                <strong>Upload a PDF floor plan</strong>
                <span>Then draw a known distance to set the scale.</span>
              </div>
            )}
            {rendering && <div className="render-badge">Rendering PDF</div>}
            <svg
              className="overlay"
              height={pageSize.height}
              viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
              width={pageSize.width}
            >
              <defs>
                <filter id="label-bg" x="-10%" y="-10%" width="120%" height="120%">
                  <feDropShadow dx="0" dy="1" floodOpacity="0.18" stdDeviation="2" />
                </filter>
              </defs>

              <GridPattern width={pageSize.width} height={pageSize.height} visible={!pdfDoc} />

              {mode === "scale" && calibration && (
                <g className="calibration-layer">
                  <line
                    x1={toDisplayPoint(calibration.start).x}
                    y1={toDisplayPoint(calibration.start).y}
                    x2={toDisplayPoint(calibration.end).x}
                    y2={toDisplayPoint(calibration.end).y}
                  />
                  <circle
                    cx={toDisplayPoint(calibration.start).x}
                    cy={toDisplayPoint(calibration.start).y}
                    r="5"
                  />
                  <circle
                    cx={toDisplayPoint(calibration.end).x}
                    cy={toDisplayPoint(calibration.end).y}
                    r="5"
                  />
                  <Label
                    point={routeMidpoint([
                      toDisplayPoint(calibration.start),
                      toDisplayPoint(calibration.end),
                    ])}
                    text={
                      pixelsPerMeter
                        ? `${lengthLabel(knownDistanceM)} scale`
                        : "Set known distance"
                    }
                  />
                </g>
              )}

              {mode === "measure" && visibleMeasurements.length > 0 && (
                <g className="measurement-layer">
                  {visibleMeasurements.map((measurement) => {
                    const start = toDisplayPoint(measurement.start);
                    const end = toDisplayPoint(measurement.end);
                    const midpoint = routeMidpoint([start, end]);
                    const meters = pixelsPerMeter
                      ? distance(measurement.start, measurement.end) / pixelsPerMeter
                      : undefined;
                    return (
                      <g key={measurement.id}>
                        <line
                          x1={start.x}
                          x2={end.x}
                          y1={start.y}
                          y2={end.y}
                        />
                        <circle cx={start.x} cy={start.y} r="4.5" />
                        <circle cx={end.x} cy={end.y} r="4.5" />
                        <g transform={`translate(${midpoint.x} ${midpoint.y})`}>
                          <rect height="24" rx="5" width="88" x="-44" y="-34" />
                          <text x="0" y="-18">
                            {meters !== undefined
                              ? lengthLabel(meters)
                              : `${integerUnit.format(distance(measurement.start, measurement.end))} px`}
                          </text>
                        </g>
                      </g>
                    );
                  })}
                </g>
              )}

              {visiblePlanCables.map((route) => (
                <CableRouteView
                  active={selectedId === route.id}
                  config={cableTypes[route.type]}
                  dimmed={Boolean(selectedCableRoute && selectedCableRoute.id !== route.id)}
                  key={route.id}
                  labelPathId={`cable-label-${route.id}`}
                  meters={pixelsPerMeter ? routeMaterialPixels(route) / pixelsPerMeter : 0}
                  onSelect={(event) => {
                    if (mode === "cable") return;
                    if (event.altKey) {
                      insertCablePoint(route.id, event);
                      return;
                    }
                    event.stopPropagation();
                    setSelectedId(route.id);
                    setSelectedDeviceIds([]);
                    setSelectedCablePoint(null);
                    setMode("select");
                  }}
                  onPointPointerDown={
                    mode === "cable"
                      ? undefined
                      : (event) => {
                          beginCablePointDrag(route.id, event);
                        }
                  }
                  branches={scaleBranches(route.branches, viewScale)}
                  colorPath={cableColorPathForRoute(route)}
                  displayPixelsPerMeter={pixelsPerMeter ? pixelsPerMeter * viewScale : 0}
                  points={toDisplayPoints(route.points)}
                  selectedPointIndex={
                    selectedCablePoint?.routeId === route.id
                      ? selectedCablePoint.pointIndex
                      : undefined
                  }
                />
              ))}

              {mode === "cable" &&
                draftRoute.length > 1 &&
                (!hoveredPlanCableType || hoveredPlanCableType === activeCable) && (
                <CableRouteView
                  active
                  config={cableTypes[activeCable]}
                  draft
                  labelPathId="cable-label-draft"
                  meters={draftMeters}
                  displayPixelsPerMeter={pixelsPerMeter ? pixelsPerMeter * viewScale : 0}
                  points={toDisplayPoints(draftRoute)}
                />
              )}

              {(!hoveredPlanCableType || hoveredPlanCableType === "power") &&
                visibleAutoSourceAssignments.map((assignment) => {
                  const startPoint = assignment.consumer.point;
                  const endPoint = assignment.targetPoint;
                  const upstreamPixels = powerPathPixelsToAssignmentSource(assignment);
                  const linkId = autoSourceLinkId(assignment.consumer.id, assignment.source);
                  const isStraightSourceLink = isManualProducerSourceAssignment(assignment);
                  const routedArc = routedAutoSourceLinks.get(linkId);
                  const start = toDisplayPoint(
                    isStraightSourceLink ? startPoint : routedArc?.start ?? startPoint,
                  );
                  const end = toDisplayPoint(
                    isStraightSourceLink ? endPoint : routedArc?.end ?? endPoint,
                  );
                  const control = toDisplayPoint(
                    routedArc?.control ?? sourceArcControl(startPoint, endPoint),
                  );
                  const arcPixels =
                    isStraightSourceLink
                      ? distance(startPoint, endPoint)
                      : routedArc?.arcPixels ??
                        sourceArcPixels(startPoint, endPoint, sourceArcControl(startPoint, endPoint));
                  const maxLengthPx = pixelsPerMeter * cableTypes.power.maxLengthM;
                  const loadWatts =
                    assignment.consumer.type === "powerstrip"
                      ? powerstripLoadWattsById.get(assignment.consumer.id) ?? 0
                      : powerLoadWattsForDevice(assignment.consumer);
                  const loadRatio = electricalLoadRatioForWatts(loadWatts);
                  const sourceLengthRatio = maxLengthPx ? upstreamPixels / maxLengthPx : 0;
                  const consumerLengthRatio = maxLengthPx
                    ? (upstreamPixels + arcPixels) / maxLengthPx
                    : 0;
                  const startRatio =
                    electricalColorMode === "load"
                      ? loadRatio
                      : consumerLengthRatio;
                  const endRatio =
                    electricalColorMode === "load"
                      ? loadRatio
                      : sourceLengthRatio;
                  return (
                    <AutoSourceLink
                      end={end}
                      endRatio={endRatio}
                      flowing={selectedAutoSourceFlowIds.has(linkId)}
                      id={linkId}
                      key={linkId}
                      pathData={
                        isStraightSourceLink
                          ? `M ${start.x} ${start.y} L ${end.x} ${end.y}`
                          : sourceArcPathThroughControl(start, control, end)
                      }
                      start={start}
                      startRatio={startRatio}
                    />
                  );
                })}

              {(!hoveredPlanCableType || hoveredPlanCableType === "ethernet") && currentEthernetAttachments.map((attachment) => {
                const start = toDisplayPoint(attachment.device.point);
                const end = toDisplayPoint(attachment.targetPoint);
                return (
                  <g
                    className="ethernet-attachment"
                    key={`${attachment.device.id}-${attachment.route.id}`}
                  >
                    <path className="ethernet-attachment-link" d={sourceArcPath(start, end)} />
                    <circle
                      className="ethernet-attachment-port"
                      cx={end.x}
                      cy={end.y}
                      r="5"
                    />
                  </g>
                );
              })}

              {selectedDevice?.page === pageNumber && selectedFlowPaths
                .filter((path) => !path.reuseAutoSourceId)
                .map((path) => (
                  <FlowPathView
                    activeColor={path.activeColor}
                    id={`flow-${path.id}`}
                    inactiveColor={path.inactiveColor}
                    key={path.id}
                    pathData={
                      path.usesDisplayCoordinates
                        ? path.pathData
                        : scalePathData(path.pathData, viewScale)
                    }
                    segments={path.segments?.map((segment) => ({
                      ...segment,
                      end: scalePoint(segment.end, viewScale),
                      start: scalePoint(segment.start, viewScale),
                    }))}
                  />
                ))}

              {currentDevices.map((device) => {
                const config = deviceTypes[device.type];
                const Icon = config.icon;
                const primaryLabel =
                  device.type === "producer" ||
                  device.type === "consumer" ||
                  device.type === "switch" ||
                  device.type === "ethernetClient"
                    ? device.name || config.label
                    : config.label;
                const secondaryLabel =
                  device.type === "producer"
                    ? powerLabel(device.availablePowerW ?? 0)
                    : device.type === "switch"
                      ? (() => {
                          const stats = ethernetSwitchPoeStats.find(
                            (switchStats) => switchStats.switchId === device.id,
                          );
                          if (!stats) return "";
                          const socketText = `${stats.cableCount}/${stats.socketCapacity} ports`;
                          return stats.totalRequiredPowerW
                            ? `${socketText}, ${powerLabel(stats.totalRequiredPowerW)} required`
                            : socketText;
                        })()
                    : device.type === "ethernetClient"
                      ? `${powerLabel(device.poePowerW ?? 0)} PoE`
                    : device.type === "consumer"
                      ? powerLabel(device.powerW ?? 0)
                      : device.type === "powerstrip"
                        ? (() => {
                            const stats = powerstripConnectionStats.find(
                              (powerstrip) => powerstrip.powerstripId === device.id,
                            );
                            const socketCapacity = stats?.socketCapacity ?? 0;
                            return `${socketCapacity} sockets (${
                              stats?.freeSocketCount ?? 0
                            } free)`;
                          })()
                      : "";
                const labelPosition = device.labelPosition ?? "bottom";
                const labelX =
                  labelPosition === "right" ? 15 : labelPosition === "left" ? -15 : 0;
                const labelY =
                  labelPosition === "top"
                    ? -30
                    : labelPosition === "bottom"
                      ? 24
                      : 4;
                const subLabelY =
                  labelPosition === "top"
                    ? -17
                    : labelPosition === "bottom"
                      ? 37
                      : 17;
                const labelAnchor =
                  labelPosition === "right"
                    ? "start"
                    : labelPosition === "left"
                      ? "end"
                      : "middle";
                return (
                  <g
                    className={[
                      "device",
                      selectedDeviceIds.includes(device.id) ? "active" : "",
                      poppedDeviceId === device.id ? "pop" : "",
                      animateOrphans && orphanDeviceIds.has(device.id) ? "orphan" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    key={device.id}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      if (mode === "cable") {
                        const attachmentDeviceId = cableAttachmentDeviceIdForClick(device);
                        addCablePoint(
                          attachmentDeviceId ? device.point : pointerFromEvent(event),
                          event.shiftKey || isShiftPressed,
                          attachmentDeviceId,
                        );
                        return;
                      }
                      if (event.metaKey || event.ctrlKey) {
                        toggleDeviceSelection(device.id);
                        setMode("select");
                        return;
                      }
                      beginUndoGroup();
                      selectDevices([device.id]);
                      setDraggingDevice({
                        deviceId: device.id,
                        startPoint: device.point,
                        attachedCablePoints: attachedCablePointsForDevice(
                          device,
                          cables,
                        ),
                      });
                    }}
                    transform={`translate(${toDisplayPoint(device.point).x} ${toDisplayPoint(device.point).y})`}
                  >
                    {animateOrphans && orphanDeviceIds.has(device.id) && (
                      <circle
                        className="orphan-pulse"
                        r="18"
                        style={{ stroke: config.color }}
                      />
                    )}
                    <circle r="12" style={{ fill: config.color }} />
                    <foreignObject height="18" width="18" x="-9" y="-9">
                      <Icon color="white" size={18} strokeWidth={2.4} />
                    </foreignObject>
                    <text
                      style={{ textAnchor: labelAnchor }}
                      x={labelX}
                      y={labelY}
                    >
                      {primaryLabel}
                    </text>
                    {secondaryLabel && (
                      <text
                        className="device-subtext"
                        style={{ textAnchor: labelAnchor }}
                        x={labelX}
                        y={subLabelY}
                      >
                        {secondaryLabel}
                      </text>
                    )}
                  </g>
                );
              })}

              {mode !== "cable" && selectedCableRoute && selectedCableRoute.points.length > 1 && (
                <CableRouteEditPointLayer
                  onPointPointerDown={(event) => {
                    beginCablePointDrag(selectedCableRoute.id, event);
                  }}
                  points={toDisplayPoints(selectedCableRoute.points)}
                  selectedPointIndex={
                    selectedCablePoint?.routeId === selectedCableRoute.id
                      ? selectedCablePoint.pointIndex
                      : undefined
                  }
                />
              )}
            </svg>
          </div>
        </div>

        <footer className="hintbar">
          {mode === "scale" && "Drag across a known wall or reference line, then enter its real distance."}
          {mode === "measure" &&
            "Drag between two points to measure a temporary distance. Measurements clear when you switch tools."}
          {mode === "cable" &&
            "Click to add route points. Hold Shift to snap to 45 degrees. Backspace removes the previous point."}
          {mode === "device" && "Click on the floor plan to place the selected device."}
          {mode === "select" &&
            "Select a cable or device. Drag cable dots or devices to reposition them. Alt/Option-click a cable to add a point."}
        </footer>
      </section>

      <aside className="side-panel stats-panel" aria-label="Live cable stats">
        <h2>Live Stats</h2>
        {!pixelsPerMeter && (
          <p className="notice">
            Lengths activate after a scale line and known distance are set.
          </p>
        )}
        <div className="stats-list">
          {stats.map((stat) => (
            <section className={stat.overLimit ? "stat warning" : "stat"} key={stat.id}>
              <div className="stat-head">
                <span
                  className="swatch"
                  style={{
                    background: `linear-gradient(90deg, ${stat.colorStart}, ${stat.colorEnd})`,
                  }}
                />
                <strong>
                  {stat.label} ({lengthLabel(stat.total)})
                </strong>
              </div>
              <dl className="compact-stat-grid">
                <div>
                  <dt>Routes</dt>
                  <dd>{stat.count}</dd>
                </div>
              </dl>
              {stat.draft > 0 && (
                <p className="draft-readout">Drawing: {lengthLabel(stat.draft)}</p>
              )}
              <p>
                Recommended max: {lengthLabel(stat.maxLengthM)}. {stat.note}
              </p>
            </section>
          ))}
        </div>

        <div className="stats-block">
          <h2>Power Loads</h2>
          {powerStats.length === 0 && (
            <p className="notice">Add a power source to track line subscription.</p>
          )}
          <div className="stats-list">
            {powerStats.map((producer) => (
              <section className="stat" key={producer.id}>
                <div className="stat-head">
                  <span className="swatch power-swatch" />
                  <strong>{producer.name}</strong>
                </div>
                <dl>
                  <div
                    className={
                      producer.capacityW > 0 && producer.usedW > producer.capacityW
                        ? "stat-cell warning"
                        : undefined
                    }
                  >
                    <dt>Subscribed</dt>
                    <dd>{powerLabel(producer.usedW)}</dd>
                  </div>
                  <div>
                    <dt>Available</dt>
                    <dd>{powerLabel(producer.capacityW)}</dd>
                  </div>
                  <div
                    className={
                      producer.capacityW > 0 && producer.remainingW < 0
                        ? "stat-cell warning"
                        : undefined
                    }
                  >
                    <dt>Remaining</dt>
                    <dd>{powerLabel(producer.remainingW)}</dd>
                  </div>
                  <div>
                    <dt>Powered loads</dt>
                    <dd>{producer.loadCount}</dd>
                  </div>
                  <div>
                    <dt>Electrical cables</dt>
                    <dd>{producer.electricalCableCount}</dd>
                  </div>
                  <div className={producer.overSocketLimit ? "stat-cell warning" : undefined}>
                    <dt>Power sockets</dt>
                    <dd>
                      {producer.socketUsage} / {producer.socketCapacity}
                    </dd>
                  </div>
                </dl>
                <div className="load-meter" aria-label={`${producer.name} subscribed ${Math.round(producer.percent)} percent`}>
                  <span
                    className={
                      producer.capacityW > 0 && producer.usedW > producer.capacityW
                        ? "over"
                        : ""
                    }
                    style={{ width: `${Math.min(producer.percent, 100)}%` }}
                  />
                </div>
                <p>
                  {producer.capacityW > 0 ? (
                    <>
                      <span
                        className={
                          producer.usedW > producer.capacityW ? "stat-message warning" : undefined
                        }
                      >
                        {Math.round(producer.percent)}% subscribed
                      </span>
                      {producer.overSocketLimit && (
                        <>
                          {"; "}
                          <span className="stat-message warning">
                            socket capacity exceeded
                          </span>
                        </>
                      )}
                    </>
                  ) : (
                    "Set available power to calculate subscription."
                  )}
                </p>
              </section>
            ))}
            {unassignedPowerLoadCount > 0 && (
              <section className="stat warning">
                <div className="stat-head">
                  <span className="swatch unassigned-swatch" />
                  <strong>Unassigned power loads</strong>
                </div>
                <dl>
                  <div>
                    <dt>Total load</dt>
                    <dd>{powerLabel(unassignedLoadW)}</dd>
                  </div>
                  <div>
                    <dt>Loads</dt>
                    <dd>{unassignedPowerLoadCount}</dd>
                  </div>
                </dl>
                <p>Connect these devices to a powered electrical path to include them in load tracking.</p>
              </section>
            )}
          </div>
        </div>
      </aside>
    </main>
  );
}

function GridPattern({ height, visible, width }: { height: number; visible: boolean; width: number }) {
  if (!visible) return null;
  const lines = [];
  for (let x = 0; x <= width; x += 40) {
    lines.push(<line key={`x-${x}`} x1={x} x2={x} y1={0} y2={height} />);
  }
  for (let y = 0; y <= height; y += 40) {
    lines.push(<line key={`y-${y}`} x1={0} x2={width} y1={y} y2={y} />);
  }
  return <g className="grid-layer">{lines}</g>;
}

function CableRouteEditPointLayer({
  onPointPointerDown,
  points,
  selectedPointIndex,
}: {
  onPointPointerDown: PointerEventHandler<SVGCircleElement>;
  points: Point[];
  selectedPointIndex?: number;
}) {
  return (
    <g className="route-edit-layer">
      {points.map((point, index) => {
        const isEndpoint = index === 0 || index === points.length - 1;
        return (
          <g key={`${point.x}-${point.y}-${index}`}>
            <circle
              className="route-node-hit"
              cx={point.x}
              cy={point.y}
              data-point-index={index}
              onPointerDown={onPointPointerDown}
              r={isEndpoint ? "16" : "14"}
            />
            <circle
              className={[
                "route-node",
                "editable",
                "raised",
                isEndpoint ? "endpoint" : "",
                selectedPointIndex === index ? "selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              cx={point.x}
              cy={point.y}
              r={isEndpoint ? "6" : "5"}
            />
          </g>
        );
      })}
    </g>
  );
}

function AutoSourceLink({
  end,
  endRatio,
  flowing = false,
  id,
  pathData,
  start,
  startRatio,
}: {
  end: Point;
  endRatio: number;
  flowing?: boolean;
  id: string;
  pathData: string;
  start: Point;
  startRatio: number;
}) {
  const gradientId = `auto-source-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <g>
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={gradientId}
          x1={start.x}
          x2={end.x}
          y1={start.y}
          y2={end.y}
        >
          <stop offset="0%" stopColor={colorAtRatio(startRatio)} />
          <stop offset="100%" stopColor={colorAtRatio(endRatio)} />
        </linearGradient>
      </defs>
      <path
        className={flowing ? "auto-source-link flowing" : "auto-source-link"}
        d={pathData}
        style={{ stroke: `url(#${gradientId})` }}
      >
        {flowing && (
          <animate
            attributeName="stroke-dashoffset"
            dur="1.2s"
            from="0"
            repeatCount="indefinite"
            to={String(flowDashCyclePx)}
          />
        )}
      </path>
    </g>
  );
}

function CableRouteView({
  active = false,
  branches = [],
  colorPath,
  config,
  dimmed = false,
  displayPixelsPerMeter,
  draft = false,
  labelPathId,
  meters,
  onSelect,
  onPointPointerDown,
  points,
  selectedPointIndex,
}: {
  active?: boolean;
  branches?: CableBranch[];
  colorPath?: CableColorPath;
  config: CableConfig;
  dimmed?: boolean;
  displayPixelsPerMeter: number;
  draft?: boolean;
  labelPathId: string;
  meters: number;
  onSelect?: PointerEventHandler<SVGGElement>;
  onPointPointerDown?: PointerEventHandler<SVGCircleElement>;
  points: Point[];
  selectedPointIndex?: number;
}) {
  let travelled = 0;
  const cableLabel = `${config.label} ${lengthLabel(meters)}`;
  const labelPath = routePathData(labelPathPoints(points));
  const maxLengthPx = displayPixelsPerMeter * config.maxLengthM;
  const ratioForPixels = (pixels: number) => (maxLengthPx ? pixels / maxLengthPx : 0);
  const colorRatioForPixels = (pixels: number) => colorPath?.loadRatio ?? ratioForPixels(pixels);
  const trunkPixels = routePixels(points);
  const sourcePointIndex = colorPath?.sourcePointIndex ?? 0;
  const sourceTrunkPixels =
    sourcePointIndex !== undefined && sourcePointIndex >= 0 && sourcePointIndex < points.length
      ? cumulativePixelsAtPoint(points, sourcePointIndex)
      : 0;
  const sourceBranch = branches.find((branch) => branch.id === colorPath?.sourceBranchId);
  const sourceBranchPixels =
    sourceBranch !== undefined
      ? routePixels(branchPathPoints({ id: "", page: 0, points, type: config.id }, sourceBranch))
      : undefined;
  const colorDistanceForTrunkPixels = (pixels: number) =>
    sourceBranchPixels !== undefined
      ? (colorPath?.offsetPx ?? 0) + sourceBranchPixels + Math.max(0, trunkPixels - pixels)
      : (colorPath?.offsetPx ?? 0) + Math.abs(pixels - sourceTrunkPixels);
  return (
    <g
      className={[
        "cable-route",
        `cable-type-${config.id}`,
        active ? "active" : "",
        dimmed ? "dimmed" : "",
        draft ? "draft" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={onSelect}
    >
      {meters > 0 && labelPath && (
        <path className="cable-label-path" d={labelPath} id={labelPathId} />
      )}
      {points.slice(1).map((point, index) => {
        const start = points[index];
        const segmentLength = distance(start, point);
        const startRatio = colorRatioForPixels(colorDistanceForTrunkPixels(travelled));
        travelled += segmentLength;
        const endRatio = colorRatioForPixels(colorDistanceForTrunkPixels(travelled));
        const gradientId = `${config.id}-${start.x}-${start.y}-${point.x}-${point.y}-${draft ? "draft" : "route"}`;
        return (
          <g key={`${point.x}-${point.y}-${index}`}>
            <defs>
              <linearGradient
                gradientUnits="userSpaceOnUse"
                id={gradientId}
                x1={start.x}
                x2={point.x}
                y1={start.y}
                y2={point.y}
              >
                <stop offset="0%" stopColor={colorAtRatio(startRatio)} />
                <stop offset="100%" stopColor={colorAtRatio(endRatio)} />
              </linearGradient>
            </defs>
            <line
              className={draft ? "draft-line" : ""}
              x1={start.x}
              x2={point.x}
              y1={start.y}
              y2={point.y}
              style={{ stroke: `url(#${gradientId})` }}
            />
          </g>
        );
      })}
      {branches.map((branch) =>
        branchPathPoints({ id: "", page: 0, points, type: config.id }, branch)
          .slice(1)
          .map((point, index) => {
            const branchPath = branchPathPoints({ id: "", page: 0, points, type: config.id }, branch);
            const start = branchPath[index];
            const branchTravelled = routePixels(branchPath.slice(0, index + 1));
            const segmentLength = distance(start, point);
            const gradientId = `${config.id}-${branch.id}-${start.x}-${start.y}-${point.x}-${point.y}`;
            const branchColorDistance = (pixels: number) =>
              colorPath?.sourceBranchId === branch.id && sourceBranchPixels !== undefined
                ? (colorPath?.offsetPx ?? 0) + Math.abs(pixels - sourceBranchPixels)
                : colorDistanceForTrunkPixels(trunkPixels) + pixels;
            return (
              <g key={`${branch.id}-${point.x}-${point.y}-${index}`}>
                <defs>
                  <linearGradient
                    gradientUnits="userSpaceOnUse"
                    id={gradientId}
                    x1={start.x}
                    x2={point.x}
                    y1={start.y}
                    y2={point.y}
                  >
                    <stop offset="0%" stopColor={colorAtRatio(colorRatioForPixels(branchColorDistance(branchTravelled)))} />
                    <stop offset="100%" stopColor={colorAtRatio(colorRatioForPixels(branchColorDistance(branchTravelled + segmentLength)))} />
                  </linearGradient>
                </defs>
                <line
                  className="branch-line"
                  x1={start.x}
                  x2={point.x}
                  y1={start.y}
                  y2={point.y}
                  style={{ stroke: `url(#${gradientId})` }}
                />
              </g>
            );
          }),
      )}
      {points.map((point, index) => (
        <g key={`${point.x}-${point.y}-${index}`}>
          {!draft && onPointPointerDown && (
            <circle
              className="route-node-hit"
              cx={point.x}
              cy={point.y}
              data-point-index={index}
              onPointerDown={onPointPointerDown}
              r="11"
            />
          )}
          <circle
            className={[
              "route-node",
              !draft ? "editable" : "",
              selectedPointIndex === index ? "selected" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            cx={point.x}
            cy={point.y}
            r="4"
          />
        </g>
      ))}
      {branches.flatMap((branch) =>
        branch.points.map((point, index) => (
          <g key={`${branch.id}-${point.x}-${point.y}-${index}`}>
            {!draft && onPointPointerDown && (
              <circle
                className="route-node-hit"
                cx={point.x}
                cy={point.y}
                data-branch-id={branch.id}
                data-branch-point-index={index}
                onPointerDown={onPointPointerDown}
                r="11"
              />
            )}
            <circle
              className="route-node editable branch-node"
              cx={point.x}
              cy={point.y}
              r="4"
            />
          </g>
        )),
      )}
      {meters > 0 && (
        <text className="cable-path-label" dy="-10" textAnchor="middle">
          <textPath href={`#${labelPathId}`} startOffset="50%">
            {cableLabel}
          </textPath>
        </text>
      )}
    </g>
  );
}

function FlowPathView({
  activeColor,
  id,
  inactiveColor,
  pathData,
  segments = [],
}: {
  activeColor: string;
  id: string;
  inactiveColor: string;
  pathData: string;
  segments?: FlowPathSegment[];
}) {
  if (!pathData && segments.length === 0) return null;
  const hasGradientSegments = segments.length > 0;
  return (
    <g className="flow-overlay">
      {hasGradientSegments && (
        <defs>
          {segments.map((segment) => {
            const activeGradientId = `${id}-${segment.id}-active`;
            const inactiveGradientId = `${id}-${segment.id}-inactive`;
            return (
              <Fragment key={`${segment.id}-gradients`}>
                <linearGradient
                  gradientUnits="userSpaceOnUse"
                  id={activeGradientId}
                  x1={segment.start.x}
                  x2={segment.end.x}
                  y1={segment.start.y}
                  y2={segment.end.y}
                >
                  <stop offset="0%" stopColor={segment.activeStartColor} />
                  <stop offset="100%" stopColor={segment.activeEndColor} />
                </linearGradient>
                <linearGradient
                  gradientUnits="userSpaceOnUse"
                  id={inactiveGradientId}
                  x1={segment.start.x}
                  x2={segment.end.x}
                  y1={segment.start.y}
                  y2={segment.end.y}
                >
                  <stop offset="0%" stopColor={segment.inactiveStartColor} />
                  <stop offset="100%" stopColor={segment.inactiveEndColor} />
                </linearGradient>
              </Fragment>
            );
          })}
        </defs>
      )}
      {hasGradientSegments ? (
        segments.map((segment) => {
          const segmentPath = `M ${segment.start.x} ${segment.start.y} L ${segment.end.x} ${segment.end.y}`;
          const activeGradientId = `${id}-${segment.id}-active`;
          const inactiveGradientId = `${id}-${segment.id}-inactive`;
          const primaryFrom = -segment.phase;
          const primaryTo = primaryFrom - flowDashCyclePx * 2;
          const secondaryFrom = primaryFrom - flowDashCyclePx / 2;
          const secondaryTo = secondaryFrom - flowDashCyclePx * 2;
          return (
            <g key={segment.id}>
              <path className="flow-track-path" d={segmentPath} style={{ stroke: `url(#${inactiveGradientId})` }} />
              <path className="flow-stream-path primary" d={segmentPath} style={{ stroke: `url(#${activeGradientId})` }}>
                <animate
                  attributeName="stroke-dashoffset"
                  dur="1.45s"
                  from={String(primaryFrom)}
                  repeatCount="indefinite"
                  to={String(primaryTo)}
                />
              </path>
              <path className="flow-stream-path secondary" d={segmentPath} style={{ stroke: `url(#${activeGradientId})` }}>
                <animate
                  attributeName="stroke-dashoffset"
                  begin="-0.725s"
                  dur="1.45s"
                  from={String(secondaryFrom)}
                  repeatCount="indefinite"
                  to={String(secondaryTo)}
                />
              </path>
            </g>
          );
        })
      ) : (
        <>
          <path className="flow-track-path" d={pathData} style={{ stroke: inactiveColor }} />
          <path className="flow-stream-path primary" d={pathData} style={{ stroke: activeColor }}>
            <animate
              attributeName="stroke-dashoffset"
              dur="1.45s"
              from="0"
              repeatCount="indefinite"
              to={String(-flowDashCyclePx * 2)}
            />
          </path>
          <path className="flow-stream-path secondary" d={pathData} style={{ stroke: activeColor }}>
            <animate
              attributeName="stroke-dashoffset"
              begin="-0.725s"
              dur="1.45s"
              from={String(-flowDashCyclePx / 2)}
              repeatCount="indefinite"
              to={String(-flowDashCyclePx * 2.5)}
            />
          </path>
        </>
      )}
    </g>
  );
}

function Label({ point, text }: { point: Point; text: string }) {
  const width = Math.max(96, text.length * 7.2);
  return (
    <g className="route-label" transform={`translate(${point.x} ${point.y})`}>
      <rect filter="url(#label-bg)" height="24" rx="4" width={width} x={-width / 2} y="-31" />
      <text x="0" y="-15">
        {text}
      </text>
    </g>
  );
}

export default App;
