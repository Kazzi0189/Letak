import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const TOOL_MAP = {
  "combine-offers": {
    script: "scripts/combine-offers.mjs",
    commitPaths: [
      "data/offers.json",
      "data/offers-penny-last.json",
      "data/offers-combined-debug.json",
    ],
  },
  "import-kaufland-teplice": {
    script: "scripts/import-kaufland-teplice-html.mjs",
    commitPaths: [
      "data/kaufland-html-import",
      "data/offers-kaufland-teplice.json",
    ],
  },
  "probe-penny-leaflet": {
    script: "scripts/probe-penny-leaflet-viewer.mjs",
    commitPaths: [
      "data/penny-leaflet-probe",
    ],
  },
  "probe-penny-viewer-deep": {
    script: "scripts/probe-penny-viewer-deep.mjs",
    commitPaths: [
      "data/penny-viewer-deep-probe",
    ],
  },
  "patch-app-kaufland-teplice": {
    script: "scripts/patch-app-kaufland-teplice.mjs",
    commitPaths: [
      "app.js",
    ],
  },
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

function normalizeToolName(value) {
  return String(value || "").trim();
}

async function main() {
  const tool = normalizeToolName(process.env.TOOL_NAME);
  const customScript = String(process.env.CUSTOM_SCRIPT || "").trim();

  let script = "";
  let commitPaths = [];

  if (tool === "custom-script") {
    if (!customScript) {
      throw new Error("CUSTOM_SCRIPT is required when TOOL_NAME=custom-script.");
    }

    script = customScript;
    commitPaths = ["data", "app.js"];
  } else {
    const config = TOOL_MAP[tool];

    if (!config) {
      throw new Error(
        `Unknown TOOL_NAME: ${tool}. Available: ${Object.keys(TOOL_MAP).join(", ")}, custom-script`
      );
    }

    script = config.script;
    commitPaths = config.commitPaths;
  }

  if (!existsSync(script)) {
    throw new Error(`Script does not exist: ${script}`);
  }

  console.log(`Running tool: ${tool}`);
  console.log(`Script: ${script}`);

  await run("node", [script]);

  console.log("::group::commit-paths");
  for (const path of commitPaths) {
    console.log(path);
  }
  console.log("::endgroup::");

  console.log(`COMMIT_PATHS=${commitPaths.join(" ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
