(async () => {
  const { createRequire } = await import("node:module");
  const { spawn } = await import("node:child_process");

  const require = createRequire(__filename);
  const nextBin = require.resolve("next/dist/bin/next");
  const env = {
    ...process.env,
    BROWSERSLIST_IGNORE_OLD_DATA: "true",
    BASELINE_BROWSER_MAPPING_IGNORE_OLD_DATA: "true",
  };

  const child = spawn(process.execPath, [nextBin, "dev", "--turbopack"], {
    stdio: "inherit",
    env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
})();
