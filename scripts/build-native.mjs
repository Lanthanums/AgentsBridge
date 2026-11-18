import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { projectRoot } from "../src/bridge/discover.mjs";
if (process.platform === "win32") {
  mkdirSync(join(projectRoot, "dist/native"), { recursive: true });
  const hash = createHash("sha256")
    .update(readFileSync(join(projectRoot, "native/jobhost.cs")))
    .digest("hex")
    .slice(0, 12);
  const file = `jobhost-${hash}.exe`;
  const path = join(projectRoot, "dist/native", file);
  if (!existsSync(path))
    execFileSync(
      join(
        process.env.SystemRoot,
        "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
      ),
      [
        "/nologo",
        "/optimize+",
        "/target:exe",
        `/out:${path}`,
        join(projectRoot, "native/jobhost.cs"),
      ],
      { stdio: "inherit", windowsHide: true },
    );
  writeFileSync(
    join(projectRoot, "dist/native/current.json"),
    JSON.stringify({ file, sha256: hash }),
  );
}

if (process.platform === "win32") {
  const source = join(projectRoot, "native/window-input.cs");
  const hash = createHash("sha256")
    .update(readFileSync(source))
    .digest("hex")
    .slice(0, 12);
  const file = `window-input-${hash}.exe`;
  const target = join(projectRoot, "dist/native", file);
  if (!existsSync(target))
    execFileSync(
      join(
        process.env.SystemRoot,
        "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
      ),
      ["/nologo", "/optimize+", "/target:exe", `/out:${target}`, source],
      { stdio: "inherit", windowsHide: true },
    );
  writeFileSync(
    join(projectRoot, "dist/native/window-input.json"),
    JSON.stringify({ file, sha256: hash }),
  );
}
