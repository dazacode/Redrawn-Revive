import { XMLParser } from "fast-xml-parser";

/** Escape text for use in XML text or double-quoted attribute values. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Loose node type: fast-xml-parser output with every tag forced into an array. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type XNode = any;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: { enabled: true, maxTotalExpansions: 1_000_000, maxExpandedLength: 1_000_000_000 },
  isArray: (_name, _path, _leaf, isAttribute) => !isAttribute,
});

/** Parse XML into a node tree. Throws on empty input. */
export function parseXml(xml: string): XNode {
  if (!xml.trim()) throw new Error("empty xml");
  return parser.parse(xml);
}

/** Child elements with the given tag name. */
export function kids(node: XNode, name: string): XNode[] {
  const v = node?.[name];
  return Array.isArray(v) ? v : [];
}

/** First child element with the given tag name. */
export function kid(node: XNode, name: string): XNode | undefined {
  return kids(node, name)[0];
}

/** Text content of a node. */
export function text(node: XNode): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  const t = node["#text"];
  return t === undefined ? "" : String(t);
}

export function attr(node: XNode, name: string): string | undefined {
  const v = node?.[`@_${name}`];
  return v === undefined ? undefined : String(v);
}

/** Names of child element keys of a node (excludes attributes and text). */
export function childNames(node: XNode): string[] {
  if (!node || typeof node !== "object") return [];
  return Object.keys(node).filter((k) => !k.startsWith("@_") && k !== "#text");
}
