// Security: passwords, permissions and encryption. MuPDF applies encryption when the file is
// written, so the engine keeps the chosen settings until the next save.
import type { Permission } from "./types";

/** What a protected file lets people do without the owner password. */
export interface PermissionSet {
  print: boolean;
  /** Print at full quality (otherwise only a low-resolution print is allowed). */
  printHigh: boolean;
  copy: boolean;
  /** Change page content. */
  edit: boolean;
  /** Add or change comments. */
  annotate: boolean;
  fillForms: boolean;
  /** Insert, delete and rotate pages. */
  assemble: boolean;
  /** Text extraction for screen readers. */
  accessibility: boolean;
}

export interface SecuritySpec {
  /** Needed to open the file. Empty = anyone can open it (the permissions still apply). */
  userPassword: string;
  /** Needed to change security or lift the restrictions. Required. */
  ownerPassword: string;
  permissions: PermissionSet;
}

export type PendingSecurity = { kind: "encrypt"; spec: SecuritySpec } | { kind: "decrypt" };

export const ALL_PERMISSIONS: PermissionSet = {
  print: true, printHigh: true, copy: true, edit: true, annotate: true, fillForms: true, assemble: true, accessibility: true,
};

// Permission bits from the PDF specification (table 22), numbered from 1.
const BITS: [keyof PermissionSet, number][] = [
  ["print", 3], ["edit", 4], ["copy", 5], ["annotate", 6], ["fillForms", 9], ["accessibility", 10], ["assemble", 11], ["printHigh", 12],
];

/** The signed 32-bit /P value. Reserved bits 7, 8 and 13–32 must be 1. */
export function permissionBits(p: PermissionSet): number {
  let value = 0xfffff0c0;
  for (const [key, bit] of BITS) if (p[key]) value |= 1 << (bit - 1);
  // High-quality printing only means something when printing is allowed at all.
  if (!p.print) value &= ~(1 << 11);
  return value | 0;
}

export function fromPermissionBits(bits: number): PermissionSet {
  const out = { ...ALL_PERMISSIONS };
  for (const [key, bit] of BITS) out[key] = (bits & (1 << (bit - 1))) !== 0;
  return out;
}

/** The engine's view of permissions (from MuPDF) in this module's terms. */
export function fromEnginePermissions(p: Record<Permission, boolean>): PermissionSet {
  return {
    print: p.print, printHigh: p["print-hq"], copy: p.copy, edit: p.edit, annotate: p.annotate,
    fillForms: p.form, assemble: p.assemble, accessibility: p.accessibility,
  };
}

export function validateSecurity(spec: SecuritySpec): string | null {
  if (!spec.ownerPassword) return "Choose a permissions password.";
  if (spec.userPassword && spec.userPassword === spec.ownerPassword) {
    return "Use a different password for permissions than for opening the file; otherwise anyone who can open it can also remove the restrictions.";
  }
  for (const pw of [spec.userPassword, spec.ownerPassword]) {
    // AES-256 (revision 6) passwords are UTF-8, truncated to 127 bytes; reject rather than silently truncate.
    if (new TextEncoder().encode(pw).length > 127) return "Passwords can be at most 127 bytes long.";
    if (/[,=]/.test(pw)) return "Passwords can't contain commas or equals signs.";
  }
  return null;
}

/** MuPDF save options for a pending security change. */
export function securityOptions(pending: PendingSecurity): string {
  if (pending.kind === "decrypt") return "decrypt";
  const { userPassword, ownerPassword, permissions } = pending.spec;
  const parts = ["encrypt=aes-256", `owner-password=${ownerPassword}`, `permissions=${permissionBits(permissions)}`];
  if (userPassword) parts.push(`user-password=${userPassword}`);
  return parts.join(",");
}

/** How strong the current encryption is, from MuPDF's "encryption" metadata (e.g. "Standard V5 R6 256-bit AES"). */
export function describeEncryption(meta: string | null): { encrypted: boolean; label: string; weak: boolean } {
  if (!meta || meta === "None") return { encrypted: false, label: "Not protected", weak: false };
  const bits = /(\d+)-bit/.exec(meta)?.[1];
  const aes = /AES/i.test(meta);
  const label = `${aes ? "AES" : "RC4"}${bits ? ` ${bits}-bit` : ""}`;
  return { encrypted: true, label, weak: !aes || Number(bits ?? 0) < 128 };
}
