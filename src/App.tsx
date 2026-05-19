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
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

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
type Mode = "select" | "scale" | "cable" | "device";
type ConsumerSourceMode = "auto" | "manual";
type ConsumerSourceType = "powerstrip" | "powerCable";

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

type SelectedCablePoint = DraggingCablePoint;
type ViewPosition = { scrollLeft: number; scrollTop: number };
type SpacePanDrag = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
};
type RouteEndpointReference = ReturnType<typeof routeEndpointReferences>[number];

type FlowPath = {
  id: string;
  pathData: string;
  activeColor: string;
  inactiveColor: string;
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
const defaultPowerSourceSockets = 4;
const defaultEthernetSwitchSockets = 8;

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

function flowSegmentsForPoints(points: Point[], maxLengthPx: number): FlowPathSegment[] {
  let travelled = 0;
  return points.slice(1).map((point, index) => {
    const start = points[index];
    const segmentLength = distance(start, point);
    const startRatio = maxLengthPx ? travelled / maxLengthPx : 0;
    const endRatio = maxLengthPx ? (travelled + segmentLength) / maxLengthPx : startRatio;
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

function countByDeviceType(devices: Device[], type: DeviceType) {
  return devices.filter((device) => device.type === type).length;
}

function socketCapacityForDevice(device: Device) {
  if (device.socketCapacity !== undefined) return Math.max(0, device.socketCapacity);
  if (device.type === "producer") return defaultPowerSourceSockets;
  if (device.type === "switch") return defaultEthernetSwitchSockets;
  return 0;
}

function canCableConnectDevice(cableType: CableType, deviceType: DeviceType) {
  if (cableType === "power") {
    return deviceType === "producer" || deviceType === "powerstrip" || deviceType === "consumer";
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
      deviceTypes === "powerstrip:producer"
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
  if (cableType !== "power" || device.type !== "consumer") return true;
  const existingAttachments = deviceCableAttachmentCount(device.id, routes, cableType);
  const draftAttachments = draftDeviceIds.filter((deviceId) => deviceId === device.id).length;
  return existingAttachments + draftAttachments === 0;
}

function sourceValue(source?: Pick<ConsumerSource, "type" | "id">) {
  return source ? `${source.type}:${source.id}` : "none";
}

function sourceLabel(source?: ConsumerSource) {
  return source?.label ?? "Unassigned";
}

function sourceArcPath(start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const segmentLength = Math.hypot(dx, dy) || 1;
  const midpoint = {
    x: start.x + dx / 2,
    y: start.y + dy / 2,
  };
  const offset = Math.min(72, Math.max(22, segmentLength * 0.45));
  const control = {
    x: midpoint.x - (dy / segmentLength) * offset,
    y: midpoint.y + (dx / segmentLength) * offset,
  };
  return `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
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
      return endpointDevice?.type !== "consumer";
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
    .filter((source) => source.type === "powerstrip" || source.type === "powerCable")
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
        return a.source.type === "powerstrip" ? -1 : 1;
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
  const [rendering, setRendering] = useState(false);
  const [mode, setMode] = useState<Mode>("scale");
  const [activeCable, setActiveCable] = useState<CableType>("ethernet");
  const [activeDevice, setActiveDevice] = useState<DeviceType>("powerstrip");
  const [hoveredCableType, setHoveredCableType] = useState<CableType | null>(null);
  const [knownDistance, setKnownDistance] = useState("10");
  const [calibration, setCalibration] = useState<{ start: Point; end: Point }>();
  const [scaleDraft, setScaleDraft] = useState<Point | null>(null);
  const [routeDraft, setRouteDraft] = useState<Point[]>([]);
  const [routeDraftDeviceIds, setRouteDraftDeviceIds] = useState<Array<string | undefined>>([]);
  const [cursorPoint, setCursorPoint] = useState<Point | null>(null);
  const [cables, setCables] = useState<CableRoute[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [draggingDevice, setDraggingDevice] = useState<DraggingDevice | null>(null);
  const [draggingCablePoint, setDraggingCablePoint] = useState<DraggingCablePoint | null>(null);
  const [selectedCablePoint, setSelectedCablePoint] = useState<SelectedCablePoint | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    async function renderPage(page: PDFPageProxy) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const pixelRatio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: zoom });
      const context = canvas.getContext("2d");
      if (!context) return;
      setPageSize({ width: viewport.width, height: viewport.height });
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, viewport.width, viewport.height);
      setRendering(true);
      await page.render({ canvasContext: context, viewport }).promise;
      if (!cancelled) setRendering(false);
    }

    if (!pdfDoc) return;
    pdfDoc.getPage(pageNumber).then(renderPage).catch(() => {
      if (!cancelled) setRendering(false);
    });

    return () => {
      cancelled = true;
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
        const device = devices.find((currentDevice) => currentDevice.id === selectedId);
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
        (devices.some((device) => device.id === selectedId) ||
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
  const selectedDevice = devices.find((device) => device.id === selectedId);
  const producers = devices.filter((device) => device.type === "producer");
  const consumers = devices.filter((device) => device.type === "consumer");
  const ethernetClients = devices.filter((device) => device.type === "ethernetClient");
  const directPowerConsumerAttachments = useMemo(
    () =>
      consumers.map((consumer) => ({
        consumer,
        attachments: resolveDeviceCableAttachments(consumer, cables, "power"),
      })),
    [cables, consumers],
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
    return [...powerstripSources, ...cableSources];
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
          return {
            switchId: switchDevice.id,
            cableCount: ethernetSwitchAttachments.filter(
              (attachment) => attachment.device.id === switchDevice.id,
            ).length,
            clientCount: assignments.length,
            poeLoadW,
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
          const desiredFreeSockets = Math.max(0, powerstrip.desiredFreeSockets ?? 0);
          const feedCableCount = electricalCableCount > 0 ? 1 : 0;
          const outletCableCount = Math.max(0, electricalCableCount - feedCableCount);
          const occupiedSocketCount = outletCableCount + consumerCount;
          return {
            powerstripId: powerstrip.id,
            electricalCableCount,
            feedCableCount,
            outletCableCount,
            consumerCount,
            desiredFreeSockets,
            occupiedSocketCount,
            requiredSocketCount: occupiedSocketCount + desiredFreeSockets,
          };
        }),
    [cables, consumerSourceAssignments, devices],
  );
  const selectedPowerstripStats =
    selectedDevice?.type === "powerstrip"
      ? powerstripConnectionStats.find(
          (powerstrip) => powerstrip.powerstripId === selectedDevice.id,
        )
      : undefined;
  const selectedFlowPaths = useMemo<FlowPath[]>(() => {
    if (!selectedDevice) return [];
    const devicesById = new Map(devices.map((device) => [device.id, device]));
    const paths: FlowPath[] = [];
    const addPath = (id: string, points: Point[], cableType: CableType) => {
      const cleanPoints = dedupeAdjacentPoints(points);
      if (cleanPoints.length > 1 && routePixels(cleanPoints) > 4) {
        const maxLengthPx = pixelsPerMeter * cableTypes[cableType].maxLengthM;
        paths.push({
          id,
          pathData: routePathData(cleanPoints),
          segments: flowSegmentsForPoints(cleanPoints, maxLengthPx),
          ...flowColorsAtRatio(0),
        });
      }
    };
    const addPathData = (id: string, pathData: string, cableType: CableType) => {
      if (pathData) {
        const fallbackColors =
          cableType === "power" ? flowColorsAtRatio(0) : flowColorsForCable(cableTypes[cableType].colorStart);
        paths.push({ id, pathData, ...fallbackColors });
      }
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
    const addPowerRoute = (route: CableRoute, targetDeviceId: string, id: string) => {
      const targetEndpoint = endpointForDevice(route, targetDeviceId);
      const sourceEndpoint = preferredPowerSourceEndpoint(route, devicesById);
      if (!targetEndpoint || !sourceEndpoint || samePoint(targetEndpoint.point, sourceEndpoint.point)) {
        return;
      }
      addPath(id, routePathBetweenEndpoints(route, sourceEndpoint, targetEndpoint), "power");
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

    if (selectedDevice.type === "consumer") {
      const directAttachments = resolveDeviceCableAttachments(selectedDevice, cables, "power");
      directAttachments.forEach((attachment, index) => {
        addPowerRoute(attachment.route, selectedDevice.id, `power-direct-${attachment.route.id}-${index}`);
      });
      if (directAttachments.length === 0) {
        const source = selectedConsumerAssignment?.source;
        const targetPoint = selectedConsumerAssignment?.targetPoint;
        if (source && targetPoint && source.type === "powerstrip") {
          resolveDeviceCableAttachments(
            devicesById.get(source.id) ?? selectedDevice,
            cables,
            "power",
          ).forEach((attachment, index) => {
            addPowerRoute(attachment.route, source.id, `power-strip-feed-${attachment.route.id}-${index}`);
          });
          addPathData(
            `power-strip-arc-existing-${source.id}-${selectedDevice.id}`,
            sourceArcPath(source.point, selectedDevice.point),
            "power",
          );
        } else if (source && targetPoint && source.type === "powerCable" && source.route) {
          const targetEndpoint = nearestRouteEndpoint(source.route, targetPoint);
          const sourceEndpoint = preferredPowerSourceEndpoint(source.route, devicesById);
          if (targetEndpoint && sourceEndpoint) {
            addPath(
              `power-cable-feed-${source.route.id}`,
              routePathBetweenEndpoints(source.route, sourceEndpoint, targetEndpoint),
              "power",
            );
            addPathData(
              `power-cable-arc-existing-${source.route.id}-${selectedDevice.id}`,
              sourceArcPath(targetEndpoint.point, selectedDevice.point),
              "power",
            );
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
      resolveDeviceCableAttachments(selectedDevice, cables, "power").forEach((attachment, index) => {
        addPowerRoute(attachment.route, selectedDevice.id, `power-strip-${attachment.route.id}-${index}`);
      });
    } else if (selectedDevice.type === "producer") {
      resolveDeviceCableAttachments(selectedDevice, cables, "power").forEach((attachment) => {
        addRouteFromDevice(
          attachment.route,
          selectedDevice.id,
          `power-source-${attachment.route.id}`,
        );
      });
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
    devices,
    pixelsPerMeter,
    selectedConsumerAssignment,
    selectedDevice,
    selectedEthernetClientAssignment,
  ]);
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

  const powerStats = useMemo(() => {
    const devicesById = new Map(devices.map((device) => [device.id, device]));
    const producerIdForAssignment = (assignment: ResolvedConsumerSource) => {
      const source = assignment.source;
      if (!source) return undefined;
      if (source.type === "powerstrip") {
        return upstreamProducerIdForPowerstrip(source.id, devicesById, cables);
      }
      if (source.route) {
        return upstreamProducerIdForPowerRoute(source.route, devicesById, cables);
      }
      const route = cables.find((candidate) => candidate.id === source.id);
      return route
        ? upstreamProducerIdForPowerRoute(route, devicesById, cables)
        : undefined;
    };
    const producerIdForDirectConsumer = (consumerId: string) => {
      const directAttachment = directPowerConsumerAttachments.find(
        (assignment) => assignment.consumer.id === consumerId,
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
    };

    return producers.map((producer) => {
      const assignedConsumerIds = new Set<string>();
      consumerSourceAssignments.forEach((assignment) => {
        if (producerIdForAssignment(assignment) === producer.id) {
          assignedConsumerIds.add(assignment.consumer.id);
        }
      });
      directPowerConsumerAttachments.forEach((assignment) => {
        if (producerIdForDirectConsumer(assignment.consumer.id) === producer.id) {
          assignedConsumerIds.add(assignment.consumer.id);
        }
      });
      const assignedConsumers = consumers.filter((consumer) =>
        assignedConsumerIds.has(consumer.id),
      );
      const usedW = assignedConsumers.reduce(
        (sum, consumer) => sum + (consumer.powerW ?? 0),
        0,
      );
      const capacityW = producer.availablePowerW ?? 0;
      const electricalCableCount =
        producerPowerCableAttachments.find(
          (attachment) => attachment.producerId === producer.id,
        )?.attachments.length ?? 0;
      const socketCapacity = socketCapacityForDevice(producer);
      const overSocketLimit = socketCapacity > 0 && electricalCableCount > socketCapacity;
      return {
        id: producer.id,
        name: producer.name || "Power source",
        page: producer.page,
        capacityW,
        usedW,
        remainingW: capacityW - usedW,
        percent: capacityW > 0 ? (usedW / capacityW) * 100 : 0,
        consumerCount: assignedConsumers.length,
        electricalCableCount,
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
    producerPowerCableAttachments,
    producers,
  ]);

  const unassignedConsumers = consumerSourceAssignments.filter(
    (assignment) =>
      !assignment.source && !directlyPoweredConsumerIds.has(assignment.consumer.id),
  );
  const unassignedLoadW = unassignedConsumers.reduce(
    (sum, assignment) => sum + (assignment.consumer.powerW ?? 0),
    0,
  );
  const poweredConsumerIds = useMemo(
    () =>
      new Set(
        [
          ...consumerSourceAssignments
            .filter((assignment) => Boolean(assignment.source))
            .map((assignment) => assignment.consumer.id),
          ...directlyPoweredConsumerIds,
        ],
      ),
    [consumerSourceAssignments, directlyPoweredConsumerIds],
  );
  const orphanDeviceIds = useMemo(() => {
    const orphanIds = new Set<string>();
    const ethernetSwitchCableCounts = new Map<string, number>();
    ethernetSwitchAttachments.forEach((attachment) => {
      ethernetSwitchCableCounts.set(
        attachment.device.id,
        (ethernetSwitchCableCounts.get(attachment.device.id) ?? 0) + 1,
      );
    });
    const ethernetClientCableIds = new Set(
      ethernetClientAttachments.map((attachment) => attachment.device.id),
    );
    const producerCableCounts = new Map(
      producerPowerCableAttachments.map((producer) => [
        producer.producerId,
        producer.attachments.length,
      ]),
    );
    const powerstripStatsById = new Map(
      powerstripConnectionStats.map((powerstrip) => [
        powerstrip.powerstripId,
        powerstrip,
      ]),
    );

    devices.forEach((device) => {
      let connected = false;

      if (device.type === "producer") {
        connected = (producerCableCounts.get(device.id) ?? 0) > 0;
      } else if (device.type === "powerstrip") {
        connected = (powerstripStatsById.get(device.id)?.electricalCableCount ?? 0) > 0;
      } else if (device.type === "consumer") {
        connected =
          poweredConsumerIds.has(device.id) ||
          resolveDeviceCableAttachments(device, cables, "power").length > 0 ||
          resolveDeviceCableAttachments(device, cables, "ethernet").length > 0 ||
          resolveDeviceCableAttachments(device, cables, "xlr").length > 0;
      } else if (device.type === "switch") {
        connected = (ethernetSwitchCableCounts.get(device.id) ?? 0) > 0;
      } else if (device.type === "ethernetClient") {
        connected = ethernetClientCableIds.has(device.id);
      }

      if (!connected) orphanIds.add(device.id);
    });

    return orphanIds;
  }, [
    cables,
    devices,
    ethernetClientAttachments,
    ethernetSwitchAttachments,
    powerstripConnectionStats,
    producerPowerCableAttachments,
    poweredConsumerIds,
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
    const setDrawColorFromHex = (color: string) => {
      const rgb = hexToRgb(color);
      document.setDrawColor(
        Math.round(rgb.r * 255),
        Math.round(rgb.g * 255),
        Math.round(rgb.b * 255),
      );
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
      setDrawColorFromHex(stat.colorStart);
      document.setLineWidth(1.8);
      document.line(lineStartX, y - 1.4, pageWidth - margin, y - 1.4);
      document.setLineWidth(0.2);
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
      document.setFont("helvetica", "bold");
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
        .forEach((route, routeIndex) => {
          const pathLengths = routeCablePathPixels(route);
          pathLengths.forEach((pathPixels, pathIndex) => {
            const suffix =
              pathLengths.length > 1 ? ` cable ${pathIndex + 1}` : "";
            addItem(
              `Route ${routeIndex + 1}${suffix}`,
              pixelsPerMeter ? lengthLabel(pathPixels / pixelsPerMeter) : "Scale not set",
              pathLengths.length > 1
                ? "Split route: includes shared trunk plus this branch."
                : undefined,
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
        `${strip.requiredSocketCount} socket${strip.requiredSocketCount === 1 ? "" : "s"}`,
        `${strip.occupiedSocketCount} occupied, ${strip.desiredFreeSockets} desired free; ${strip.feedCableCount} supply feed${strip.feedCableCount === 1 ? "" : "s"}`,
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
    if (unassignedConsumers.length > 0) {
      addItem(
        "Unassigned power consumers",
        integerUnit.format(unassignedConsumers.length),
        `${powerLabel(unassignedLoadW)} total load not assigned to a source`,
      );
    }

    addSection("Network");
    ethernetSwitchPoeStats.forEach((switchStats, index) => {
      addItem(
        `Ethernet switch ${index + 1}`,
        `${switchStats.socketCapacity} port${switchStats.socketCapacity === 1 ? "" : "s"}`,
        `${switchStats.cableCount} cable${switchStats.cableCount === 1 ? "" : "s"} connected; ${
          switchStats.clientCount
        } PoE client${switchStats.clientCount === 1 ? "" : "s"}; ${powerLabel(
          switchStats.poeLoadW,
        )} PoE required`,
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
    setSelectedCablePoint(null);

    if (mode === "scale") {
      beginUndoGroup();
      setCalibration({ start: point, end: point });
      setScaleDraft(point);
      return;
    }

    if (mode === "cable") {
      addCablePoint(point, event.shiftKey || isShiftPressed);
      return;
    }

    if (mode === "device") {
      const producerCount = devices.filter((device) => device.type === "producer").length + 1;
      const consumerCount = devices.filter((device) => device.type === "consumer").length + 1;
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
      setSelectedId(device.id);
    }
  }

  function handlePointerMove(event: PointerEvent) {
    const point = pointerFromEvent(event);
    if (draggingCablePoint) {
      const shouldConstrain = event.shiftKey || isShiftPressed;
      const excludedDeviceIdsForRoute = (route: CableRoute) => {
        const excludedDeviceIds =
          route.type === "power" ? new Set(poweredConsumerIds) : new Set<string>();
        if (draggingCablePoint.detachedDeviceId) {
          excludedDeviceIds.add(draggingCablePoint.detachedDeviceId);
        }
        return excludedDeviceIds;
      };
      setCables((current) =>
        current.map((route) => {
          if (route.id !== draggingCablePoint.routeId) return route;
          let endpointDevice: Device | undefined;
          let editedRoute =
            draggingCablePoint.branchId !== undefined
              ? {
                  ...route,
                  branches: route.branches?.map((branch) =>
                    branch.id === draggingCablePoint.branchId
                      ? {
                          ...branch,
                          points: branch.points.map((branchPoint, index) => {
                            if (index !== draggingCablePoint.branchPointIndex) {
                              return branchPoint;
                            }
                            const isEndpoint = index === branch.points.length - 1;
                            const editedPoint = shouldConstrain
                              ? constrainTo45Degrees(
                                  index === 0
                                    ? route.points[route.points.length - 1]
                                    : branch.points[index - 1],
                                  point,
                                )
                              : point;
                            endpointDevice = isEndpoint
                              ? closestCompatibleDeviceForCablePoint(
                                  editedPoint,
                                  route,
                                  devices,
                                  pixelsPerMeter,
                                  excludedDeviceIdsForRoute(route),
                                  draggingCablePoint,
                                )
                              : undefined;
                            return endpointDevice ? endpointDevice.point : editedPoint;
                          }),
                        }
                      : branch,
                  ),
                }
              : {
                  ...route,
                  points: route.points.map((routePoint, index) => {
                    if (index !== draggingCablePoint.pointIndex) return routePoint;
                    const isEndpoint = index === 0 || index === route.points.length - 1;
                    const editedPoint =
                      shouldConstrain && draggingCablePoint.pointIndex !== undefined
                        ? constrainEditedRoutePoint(
                            route.points,
                            draggingCablePoint.pointIndex,
                            point,
                          )
                        : point;
                    endpointDevice = isEndpoint
                      ? closestCompatibleDeviceForCablePoint(
                          editedPoint,
                          route,
                          devices,
                          pixelsPerMeter,
                          excludedDeviceIdsForRoute(route),
                          draggingCablePoint,
                        )
                      : undefined;
                    return endpointDevice ? endpointDevice.point : editedPoint;
                  }),
                };
          editedRoute = routeWithEndpointDeviceId(
            editedRoute,
            draggingCablePoint,
            endpointDevice?.id,
          );
          return editedRoute;
        }),
      );
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
    if (mode === "cable" && routeDraft.length > 0) {
      const lastPoint = routeDraft[routeDraft.length - 1];
      setCursorPoint(
        event.shiftKey || isShiftPressed
          ? constrainTo45Degrees(lastPoint, point)
          : point,
      );
    }
  }

  function handlePointerUp() {
    finishUndoGroup();
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
    if (!selectedId) return;
    setCables((current) => current.filter((route) => route.id !== selectedId));
    setDevices((current) =>
      current
        .filter((device) => device.id !== selectedId)
        .map((device) =>
          device.sourceId === selectedId
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
    setPoppedDeviceId(pastedDevice.id);
  }

  function updateDevice(id: string, updates: Partial<Device>) {
    setDevices((current) =>
      current.map((device) => (device.id === id ? { ...device, ...updates } : device)),
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
          targetDevice.type === "consumer" &&
          poweredConsumerIds.has(targetDevice.id)))
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
      device.type === "consumer" &&
      poweredConsumerIds.has(device.id)
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
    setSelectedCablePoint(null);
    setMode("select");
  }

  const draftMeters =
    draftRoute.length > 1 && pixelsPerMeter ? routePixels(draftRoute) / pixelsPerMeter : 0;
  const selectedCableRoute = currentCables.find((route) => route.id === selectedId);

  function beginCablePointDrag(routeId: string, event: PointerEvent<SVGCircleElement>) {
    event.stopPropagation();
    beginUndoGroup();
    setSelectedId(routeId);
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
          <p className={storageNotice ? "autosave-status warning" : "autosave-status"}>
            {storageNotice || "Autosaves locally in this browser."}
          </p>

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
              {selectedPowerstripStats?.requiredSocketCount ?? 0} socket
              {(selectedPowerstripStats?.requiredSocketCount ?? 0) === 1 ? "" : "s"} needed
              {" "}
              ({selectedPowerstripStats?.occupiedSocketCount ?? 0} occupied,{" "}
              {selectedPowerstripStats?.desiredFreeSockets ?? 0} free
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
              {powerLabel(selectedSwitchPoeStats?.poeLoadW ?? 0)} PoE required by{" "}
              {selectedSwitchPoeStats?.clientCount ?? 0} client
              {(selectedSwitchPoeStats?.clientCount ?? 0) === 1 ? "" : "s"}
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
            <button type="button" disabled={!selectedId} onClick={deleteSelected}>
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

              {(!hoveredPlanCableType || hoveredPlanCableType === "power") && currentConsumerSourceAssignments
                .filter(
                  (assignment) =>
                    assignment.autoAssigned && assignment.source && assignment.targetPoint,
                )
                .map((assignment) => {
                  const start = toDisplayPoint(assignment.consumer.point);
                  const end = toDisplayPoint(assignment.targetPoint as Point);
                  return (
                    <path
                      className="auto-source-link"
                      d={sourceArcPath(start, end)}
                      key={`${assignment.consumer.id}-${assignment.source?.type}-${assignment.source?.id}`}
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

              {selectedDevice?.page === pageNumber && selectedFlowPaths.map((path) => (
                  <FlowPathView
                    activeColor={path.activeColor}
                    id={`flow-${path.id}`}
                    inactiveColor={path.inactiveColor}
                    key={path.id}
                    pathData={scalePathData(path.pathData, viewScale)}
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
                          return stats.poeLoadW
                            ? `${socketText}, ${powerLabel(stats.poeLoadW)} PoE`
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
                            return `${stats?.requiredSocketCount ?? 0} sockets (${
                              stats?.desiredFreeSockets ?? 0
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
                      selectedId === device.id ? "active" : "",
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
                      beginUndoGroup();
                      setSelectedId(device.id);
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
              <section
                className={producer.overLimit ? "stat warning" : "stat"}
                key={producer.id}
              >
                <div className="stat-head">
                  <span className="swatch power-swatch" />
                  <strong>{producer.name}</strong>
                </div>
                <dl>
                  <div>
                    <dt>Subscribed</dt>
                    <dd>{powerLabel(producer.usedW)}</dd>
                  </div>
                  <div>
                    <dt>Available</dt>
                    <dd>{powerLabel(producer.capacityW)}</dd>
                  </div>
                  <div>
                    <dt>Remaining</dt>
                    <dd>{powerLabel(producer.remainingW)}</dd>
                  </div>
                  <div>
                    <dt>Consumers</dt>
                    <dd>{producer.consumerCount}</dd>
                  </div>
                  <div>
                    <dt>Electrical cables</dt>
                    <dd>{producer.electricalCableCount}</dd>
                  </div>
                  <div>
                    <dt>Power sockets</dt>
                    <dd>
                      {producer.electricalCableCount} / {producer.socketCapacity}
                    </dd>
                  </div>
                </dl>
                <div className="load-meter" aria-label={`${producer.name} subscribed ${Math.round(producer.percent)} percent`}>
                  <span
                    className={producer.overLimit ? "over" : ""}
                    style={{ width: `${Math.min(producer.percent, 100)}%` }}
                  />
                </div>
                <p>
                  {producer.capacityW > 0
                    ? `${Math.round(producer.percent)}% subscribed${
                        producer.overSocketLimit ? "; socket capacity exceeded" : ""
                      }`
                    : "Set available power to calculate subscription."}
                </p>
              </section>
            ))}
            {unassignedConsumers.length > 0 && (
              <section className="stat warning">
                <div className="stat-head">
                  <span className="swatch unassigned-swatch" />
                  <strong>Unassigned consumers</strong>
                </div>
                <dl>
                  <div>
                    <dt>Total load</dt>
                    <dd>{powerLabel(unassignedLoadW)}</dd>
                  </div>
                  <div>
                    <dt>Consumers</dt>
                    <dd>{unassignedConsumers.length}</dd>
                  </div>
                </dl>
                <p>Assign these consumers to a power source to include them in load tracking.</p>
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

function CableRouteView({
  active = false,
  branches = [],
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
  const trunkPixels = routePixels(points);
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
        const startRatio = ratioForPixels(travelled);
        travelled += segmentLength;
        const endRatio = ratioForPixels(travelled);
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
                    <stop offset="0%" stopColor={colorAtRatio(ratioForPixels(trunkPixels + branchTravelled))} />
                    <stop offset="100%" stopColor={colorAtRatio(ratioForPixels(trunkPixels + branchTravelled + segmentLength))} />
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
