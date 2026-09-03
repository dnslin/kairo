declare const process: {
  versions: {
    node: string;
  };
};

const minimumNodeVersion = [22, 13, 0] as const;

function isSupportedNodeVersion(version: string): boolean {
  const currentVersion = version.split('.').map(Number);

  for (let index = 0; index < minimumNodeVersion.length; index += 1) {
    const current = currentVersion[index] ?? 0;
    const minimum = minimumNodeVersion[index] ?? 0;

    if (current !== minimum) {
      return current > minimum;
    }
  }

  return true;
}

export function verifyStartupBoundary(): void {
  const nodeVersion = process.versions.node;

  if (!isSupportedNodeVersion(nodeVersion)) {
    throw new Error(`@kairo/app 需要 Node.js >=22.13.0，当前版本为 ${nodeVersion}`);
  }

  console.log(`@kairo/app 启动边界验证通过（Node.js ${nodeVersion}）`);
}

verifyStartupBoundary();
