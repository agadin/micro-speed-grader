#!/usr/bin/env node
// Check the published update the way installed copies of the app see it:
//   node tools/check-update.mjs [version] [--mac-only]
// Fetches latest.json from the endpoint in tauri.conf.json, downloads every platform's file and
// verifies it as the Tauri updater does: the minisign signature (BLAKE2b-prehashed Ed25519) against
// the app's public key, the signed trusted comment, and (requireSignedVersion) that the signature
// names the version latest.json announces. Exits 1 on any problem. release.sh runs it after publishing.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const macOnly = args.includes("--mac-only");
const want = args.find((a) => !a.startsWith("--"));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const up = JSON.parse(fs.readFileSync(path.join(root, "app/src-tauri/tauri.conf.json"), "utf8")).plugins.updater;

const b64 = (s) => Buffer.from(s, "base64");
const problems = [];
const fail = (m) => (problems.push(m), console.log(`✗ ${m}`));

// the app's public key: "Ed" | key id (8 bytes) | Ed25519 key (32 bytes)
const key = b64(b64(up.pubkey).toString("utf8").trim().split("\n").pop());
const keyId = key.subarray(2, 10);
const pubKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10, 42)]), format: "der", type: "spki" });

const res = await fetch(up.endpoints[0], { redirect: "follow" });
if (!res.ok) {
  console.log(`✗ ${up.endpoints[0]}: HTTP ${res.status}`);
  process.exit(1);
}
const feed = await res.json();
console.log(`latest.json: version ${feed.version}, platforms ${Object.keys(feed.platforms ?? {}).join(", ")}`);
if (want && feed.version !== want) fail(`latest.json announces ${feed.version}, expected ${want}`);
for (const p of ["darwin-aarch64", "darwin-x86_64", ...(macOnly ? [] : ["windows-x86_64"])])
  if (!feed.platforms?.[p]) fail(`latest.json has no ${p}: those copies won't be offered the update`);

const files = new Map();
for (const [plat, p] of Object.entries(feed.platforms ?? {})) {
  try {
    if (!p.url.includes(`/v${feed.version}/`)) fail(`${plat}: ${p.url} isn't in the v${feed.version} release`);
    if (!files.has(p.url)) {
      const r = await fetch(p.url, { redirect: "follow" });
      if (!r.ok) throw new Error(`download HTTP ${r.status}`);
      files.set(p.url, Buffer.from(await r.arrayBuffer()));
    }
    const file = files.get(p.url);
    const lines = b64(p.signature).toString("utf8").trim().split("\n");
    const sig = b64(lines[1]);
    const msg = sig.subarray(0, 2).toString("latin1") === "ED" ? crypto.createHash("blake2b512").update(file).digest() : file;
    const sigBytes = sig.subarray(10, 74);
    const trusted = lines[2].replace(/^trusted comment: /, "");
    if (!sig.subarray(2, 10).equals(keyId)) throw new Error("signed with a different key than the app's");
    if (!crypto.verify(null, msg, pubKey, sigBytes)) throw new Error("signature doesn't match the file");
    if (!crypto.verify(null, Buffer.concat([sigBytes, Buffer.from(trusted)]), pubKey, b64(lines[3]))) throw new Error("trusted comment isn't signed");
    const signed = trusted.split("\t").find((x) => x.startsWith("version:"))?.slice(8);
    if (signed !== feed.version)
      throw new Error(
        signed
          ? `signed for ${signed}, but latest.json announces ${feed.version}`
          : "the signature doesn't name a version: apps with requireSignedVersion refuse it",
      );
    console.log(`✓ ${plat}: ${(file.length / 1e6).toFixed(1)} MB, signature valid, signed for ${signed}`);
  } catch (e) {
    fail(`${plat}: ${e.message}`);
  }
}
if (problems.length) {
  console.log(`\nInstalled copies can't update: ${problems.length} problem${problems.length === 1 ? "" : "s"}.`);
  process.exit(1);
}
console.log("\nInstalled copies will accept this update.");
