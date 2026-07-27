#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const version = process.argv[2] || require("../package.json").version;
const dist = path.resolve(process.argv[3] || "dist");
const releaseDate = new Date().toISOString();

function fileInfo(name) {
  const buf = fs.readFileSync(path.join(dist, name));
  return {
    url: name,
    sha512: crypto.createHash("sha512").update(buf).digest("base64"),
    size: buf.length,
  };
}

function writeYaml(fileName, files, primary) {
  const lines = [`version: ${version}`, "files:"];
  for (const file of files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
  }
  lines.push(`path: ${primary.url}`);
  lines.push(`sha512: ${primary.sha512}`);
  lines.push(`releaseDate: '${releaseDate}'`);
  fs.writeFileSync(path.join(dist, fileName), `${lines.join("\n")}\n`);
}

const macZipArm = `OpenPilot-${version}-arm64-mac.zip`;
const macZipX64 = `OpenPilot-${version}-mac.zip`;
const winSetup = `OpenPilot-Setup-${version}.exe`;

const macFiles = [macZipArm, macZipX64]
  .filter((name) => fs.existsSync(path.join(dist, name)))
  .map(fileInfo);

if (!macFiles.length) {
  throw new Error(`Missing mac zip artifacts in ${dist}`);
}
writeYaml("latest-mac.yml", macFiles, macFiles[0]);

if (!fs.existsSync(path.join(dist, winSetup))) {
  throw new Error(`Missing Windows setup exe: ${winSetup}`);
}
const winPrimary = fileInfo(winSetup);
writeYaml("latest.yml", [winPrimary], winPrimary);

console.log(`Generated latest-mac.yml and latest.yml for ${version}`);
