import { defineParameters } from "@nasa-jpl/plandev-actions";
import type { ActionsAPI, ActionSettingDefinitions, ActionParameters, ActionSettings } from "@nasa-jpl/plandev-actions";

// Define schemas for your action's settings and parameters
// `defineParameters` keeps the literal types, so no `as const` / `satisfies` is needed.
export const parameterDefinitions = defineParameters({
  urlPath: { type: "string", description: "Path appended to the externalUrl setting" },
  sleepMs: { type: "int", required: false, defaultValue: 0 },
  // `withRevision: true` lets the person running the action pick the working copy or a named
  // revision of the file; the action then receives a `FileRef` ({ path, revision? }), not a string.
  sourceFile: { type: "file", withRevision: true, required: false },
});

export const settingDefinitions = {
  externalUrl: { type: "string" },
} satisfies ActionSettingDefinitions;

// generate the correct typescript types from the schemas
type MyActionParameters = ActionParameters<typeof parameterDefinitions>;
type MyActionSettings = ActionSettings<typeof settingDefinitions>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function main(parameters: MyActionParameters, settings: MyActionSettings, actionsAPI: ActionsAPI) {
  const url = `${settings.externalUrl}/${parameters.urlPath}`;

  const startTime = performance.now();

  if (parameters.sleepMs) {
    await sleep(parameters.sleepMs);
  }

  // Make a request to an external URL using fetch
  const result = await fetch(url, {
    method: "get",
    headers: {
      "Content-Type": "application/json",
    },
  });
  console.log(`request took ${performance.now() - startTime}ms`);

  // `fetch` only rejects on network failure -- an HTTP 500 resolves normally, so
  // a bad status has to be turned into an error explicitly. Throwing here is what
  // marks the action run as failed; without it a 500 is reported as SUCCESS.
  if (!result.ok) {
    throw new Error(`Request to ${url} failed with HTTP ${result.status} ${result.statusText}`);
  }

  // try parsing result as either json or text
  let resultData: string;
  try {
    resultData = await result.clone().json();
  } catch {
    resultData = await result.clone().text();
  }

  // read/write files using the actions helpers
  const files = await actionsAPI.listFiles("");
  console.log(`action files: ${JSON.stringify(files)}`);

  // note: only wrap in try/catch to handle *non-fatal errors*! Fatal errors should be thrown to properly report action run as failure
  if (parameters.sourceFile) {
    try {
      // readFile accepts a FileRef and reads the chosen revision (or the working copy if none was chosen)
      const myFile = await actionsAPI.readFile(parameters.sourceFile);
      const { path, revision } = parameters.sourceFile;
      console.log(`${path} @ ${revision ?? "working copy"}: ${myFile}`);
    } catch (e) {
      console.warn(`Could not read ${parameters.sourceFile.path}: ${e}`);
    }
  }

  const jsonStr = JSON.stringify(resultData, null, 2);
  const outputFile = "action-template-output";
  const writeResult = await actionsAPI.writeFile(outputFile, jsonStr, true);
  console.log(`writeResult: ${JSON.stringify(writeResult)}`);

  // Bookmark the output as a named revision. Writing and revising are two separate calls: if
  // this one fails the write has still succeeded. Each run adds a revision you can read back later.
  const revision = await actionsAPI.createFileRevision(outputFile, { message: `Response from ${url}` });
  console.log(`created revision ${revision.name}`);

  return {
    status: "SUCCESS",
    data: resultData,
  };
}
