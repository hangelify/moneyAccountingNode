import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import * as ts from 'typescript';
import { Utils } from '@mikro-orm/core';
import mikroOrmConfig from './mikro-orm.config';

// `start:prod`, docker-entrypoint.sh and the CI smoke step run `node dist/main.js`,
// and MikroORM discovers compiled entities by glob, so the emitted layout of
// `tsc -p tsconfig.build.json` is part of the runtime contract.
const projectRoot = resolve(__dirname, '..');

function parseBuildConfig(): ts.ParsedCommandLine {
  const configPath = join(projectRoot, 'tsconfig.build.json');
  const { config } = ts.readConfigFile(configPath, (p) =>
    ts.sys.readFile(p),
  ) as { config: unknown };
  return ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    projectRoot,
    undefined,
    configPath,
  );
}

function emittedJs(parsed: ts.ParsedCommandLine, source: string): string {
  const outputs = ts.getOutputFileNames(
    parsed,
    join(projectRoot, source),
    !ts.sys.useCaseSensitiveFileNames,
  );
  const js = outputs.find((o) => o.endsWith('.js'));
  if (!js) throw new Error(`no JS output for ${source}`);
  return relative(projectRoot, js).split('\\').join('/');
}

describe('production build layout', () => {
  const parsed = parseBuildConfig();

  it('emits the entry point as dist/main.js', () => {
    expect(emittedJs(parsed, 'src/main.ts')).toBe('dist/main.js');
  });

  // `nest build` wipes dist/ (deleteOutDir); build info left outside it makes
  // the next incremental build think nothing changed and emit nothing.
  it('keeps incremental build info inside dist/', () => {
    const buildInfo = ts.getTsBuildInfoEmitOutputFilePath(parsed.options);
    if (buildInfo === undefined) return;
    expect(relative(projectRoot, buildInfo).split('\\').join('/')).toMatch(
      /^dist\//,
    );
  });

  it('compiles only files under src/', () => {
    const outside = parsed.fileNames
      .map((f) => relative(projectRoot, f).split('\\').join('/'))
      .filter((f) => !f.startsWith('src/'));
    expect(outside).toEqual([]);
  });

  it('MikroORM entity globs find the compiled entities', async () => {
    const entity = emittedJs(parsed, 'src/entities/user.entity.ts');
    const sandbox = mkdtempSync(join(tmpdir(), 'build-layout-'));
    try {
      mkdirSync(join(sandbox, dirname(entity)), { recursive: true });
      writeFileSync(join(sandbox, entity), '');

      const globs = (mikroOrmConfig.entities ?? []).filter(
        (e): e is string => typeof e === 'string',
      );
      const found = await Promise.all(
        globs.map((g) => Utils.pathExists(g, { cwd: sandbox })),
      );
      expect(found).toContain(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
