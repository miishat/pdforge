// Starts a release: sets the version everywhere it's stored, commits, and tags it.
// Usage: npm run release -- 0.2.0     (then push: git push origin main --follow-tags)
// Pushing the tag makes the Release workflow build, sign and publish the installer and the update file.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Give the new version, like: npm run release -- 0.2.0");
  process.exit(1);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("status", "--porcelain")) {
  console.error("Commit or stash your changes first; the release commit should contain only the version.");
  process.exit(1);
}
const current = JSON.parse(readFileSync("package.json", "utf8")).version;
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
if (!newer(version, current)) {
  console.error(`${version} isn't newer than the current ${current}; the updater only installs newer versions.`);
  process.exit(1);
}

const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, "utf8")));
const json = (file, fn) => edit(file, (s) => JSON.stringify(fn(JSON.parse(s)), null, 2) + "\n");
json("package.json", (p) => ({ ...p, version }));
json("package-lock.json", (p) => {
  p.version = version;
  if (p.packages?.[""]) p.packages[""].version = version;
  return p;
});
json("src-tauri/tauri.conf.json", (c) => ({ ...c, version }));
edit("src-tauri/Cargo.toml", (s) => s.replace(/^version = ".*"$/m, `version = "${version}"`));
edit("src-tauri/Cargo.lock", (s) => s.replace(/(name = "pdforge"\nversion = )".*"/, `$1"${version}"`));

git("add", "package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock");
git("commit", "-m", `Release ${version}`);
git("tag", "-a", `v${version}`, "-m", `PDForge ${version}`);
console.log(`Version ${version} committed and tagged v${version}.\nPublish it with: git push origin main --follow-tags`);
