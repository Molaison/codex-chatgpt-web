// Generate an ephemeral local-only certificate. No private key is checked in.
const crypto = require("node:crypto");
function der(tag, ...items) {
  const data = Buffer.concat(items.map(item => Buffer.isBuffer(item) ? item : Buffer.from(item)));
  let length = Buffer.from([data.length]);
  if (data.length > 127) {
    let hex = data.length.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    const bytes = Buffer.from(hex, "hex");
    length = Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, data]);
}
module.exports = function localCertificate() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algorithm = der(0x30, der(6, Buffer.from("2a864886f70d01010b", "hex")), der(5));
  const name = der(0x30, der(0x31, der(0x30, der(6, [0x55, 4, 3]), der(12, "localhost"))));
  const time = date => der(0x18, date.toISOString().replace(/[-:T]/g, "").replace(/\.\d+Z$/, "Z"));
  const validity = der(0x30, time(new Date(Date.now() - 60000)), time(new Date(Date.now() + 86400000)));
  const san = der(0x30, der(6, [0x55, 0x1d, 0x11]), der(4, der(0x30, der(0x87, [127, 0, 0, 1]))));
  const basic = der(0x30, der(6, [0x55, 0x1d, 0x13]), der(1, [0xff]), der(4, der(0x30, der(1, [0xff]))));
  const body = der(0x30, der(0xa0, der(2, [2])), der(2, [1]), algorithm, name, validity, name,
    publicKey.export({ type: "spki", format: "der" }), der(0xa3, der(0x30, san, basic)));
  const cert = der(0x30, body, algorithm, der(3, [0], crypto.sign("sha256", body, privateKey)));
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`,
  };
};
