import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { newId, sha256 } from "../../shared/canonical.js";

function safeTarget(root, projectName, relativePath) {
  const projectRoot = resolve(root, projectName);
  const target = resolve(projectRoot, relativePath);
  if (target !== projectRoot && !target.startsWith(`${projectRoot}${sep}`)) {
    throw new Error("Deployment path escaped the project root");
  }
  return { projectRoot, target };
}

export class LocalDeploymentProvider {
  constructor({ root = ".deployments" } = {}) {
    this.root = resolve(root);
    this.mode = "TEST";
  }

  async deploy({ projectName, files }) {
    const { projectRoot } = safeTarget(this.root, projectName, "index.html");
    await rm(projectRoot, { recursive: true, force: true });
    for (const [path, content] of Object.entries(files)) {
      const { target } = safeTarget(this.root, projectName, path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    return {
      providerReference: newId("local_deploy"),
      providerCostMicrodollars: 0,
      liveUrl: `local://${projectName}/index.html`,
    };
  }

  async verify(liveUrl, { projectName, expectedContentHash }) {
    if (liveUrl !== `local://${projectName}/index.html`) return false;
    try {
      const { target } = safeTarget(this.root, projectName, "index.html");
      const contents = await readFile(target, "utf8");
      return sha256(contents) === expectedContentHash;
    } catch {
      return false;
    }
  }
}
