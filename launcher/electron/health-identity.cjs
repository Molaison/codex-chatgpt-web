const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const HEX = /^[a-f0-9]{64}$/;
const HOST_VERSION = require("../package.json").version;
function digestUserId(id) {
  if (typeof id !== "string" || !id || id.length > 512 || id.trim() !== id) return null;
  return createHash("sha256").update("chatgpt-session-user-id/v1\0").update(id).digest("hex");
}
function readHealthPin(file, identity) {
  try {
    if (typeof file !== "string" || !path.isAbsolute(file)) return null;
    const stat = fs.statSync(file);
    if (!stat.isFile() || process.platform !== "win32" && ((stat.mode & 0o077) !== 0
      || typeof process.getuid === "function" && stat.uid !== process.getuid())) return null;
    const pin = JSON.parse(fs.readFileSync(file, "utf8"));
    if (pin?.version !== 1 || pin.accountId !== identity.accountId || pin.profile !== identity.host.profile
      || pin.partition !== identity.host.partition || !HEX.test(pin.principalDigest)) return null;
    return pin.principalDigest;
  } catch { return null; }
}
// Capture once at Launcher startup. Packaged ASAR files are immutable for this
// process; this covers the local CJS/JSON closure, not the renderer or runtime.
function closureDigest(directory = __dirname) {
  try {
    const hash = createHash("sha256");
    const files = fs.readdirSync(directory).filter(n => /\.(cjs|json)$/.test(n)).sort();
    for (const name of files) {
      const data = fs.readFileSync(path.join(directory, name));
      hash.update(name).update("\0").update(createHash("sha256").update(data).digest("hex")).update("\0");
    }
    hash.update("../package.json\0").update(createHash("sha256").update(fs.readFileSync(path.join(directory, "../package.json"))).digest("hex")).update("\0");
    return hash.digest("hex");
  } catch { return null; }
}
const HOST_CLOSURE_DIGEST = closureDigest();
module.exports = { digestUserId, readHealthPin, closureDigest, HOST_VERSION, HOST_CLOSURE_DIGEST };
