import { timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { expandUserPath, type AppConfig } from "./config";

export type BearerAuthorizer = (request: Request) => boolean;

export function bearerAuthorizer(token: string): BearerAuthorizer {
  const expected = Buffer.from(`Bearer ${token}`);
  return request => {
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}

/** Load before opening any listener. Neither the token nor read errors enter the config. */
export function loadNativeApiAuthorizer(
  config: Pick<AppConfig, "nativeApiTokenFile" | "controlToken">,
): BearerAuthorizer | undefined {
  if (config.nativeApiTokenFile === undefined) return undefined;
  if (typeof config.nativeApiTokenFile !== "string" || !config.nativeApiTokenFile.trim()
    || !isAbsolute(expandUserPath(config.nativeApiTokenFile))) {
    throw new Error("nativeApiTokenFile must be an absolute private file path");
  }
  let fd: number;
  try {
    fd = openSync(expandUserPath(config.nativeApiTokenFile),
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error("Cannot open nativeApiTokenFile; a readable private regular file is required");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("nativeApiTokenFile must be a regular file");
    if (process.platform !== "win32"
      && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!())) {
      throw new Error("nativeApiTokenFile must be owned by the runtime user and private (mode 0600 or 0400)");
    }
    if (stat.size === 0) throw new Error("nativeApiTokenFile is empty");
    if (stat.size > 130) throw new Error("nativeApiTokenFile has invalid token length");
    const content = readFileSync(fd, "utf8");
    if (!/^[A-Za-z0-9_-]{43,128}(?:\r?\n)?$/.test(content)) {
      throw new Error("nativeApiTokenFile must contain 43-128 base64url characters with at most one trailing newline");
    }
    const token = content.replace(/\r?\n$/, "");
    if (token === config.controlToken) throw new Error("nativeApiTokenFile must not reuse controlToken");
    return bearerAuthorizer(token);
  } finally {
    closeSync(fd);
  }
}
