// One-time helper: generates an RSA key, writes its public SPKI into extension/manifest.json as
// "key" (so the unpacked extension always gets the same ID) and prints the resulting extension ID.
// The private key is not needed afterwards (only the Web Store uses it) and is not written anywhere.
import { generateKeyPairSync, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, "..", "..", "extension", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function idFromKey(base64) {
  const der = Buffer.from(base64, "base64");
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)));
}

if (manifest.key && !process.argv.includes("--force")) {
  console.log(JSON.stringify({ unchanged: true, extensionId: idFromKey(manifest.key) }));
  process.exit(0);
}

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
manifest.key = spki;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ written: manifestPath, extensionId: idFromKey(spki) }));
