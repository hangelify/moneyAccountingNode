import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import 'reflect-metadata';

// Every module entry point must load on its own, in any order: a barrel that
// pulls a half-loaded module back in leaves `undefined` in Nest metadata and
// only fails at bootstrap ("cannot resolve dependency"), depending on which
// file a spec, a script or AppModule happens to import first.
const MODULES_DIR = __dirname;
const METADATA_KEYS = [
  'imports',
  'providers',
  'controllers',
  'exports',
  '__guards__',
  'design:paramtypes',
];

function entryPoints(): string[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      readdirSync(join(MODULES_DIR, d.name))
        .filter((f) => f === 'index.ts' || f.endsWith('.module.ts'))
        .map((f) => join(d.name, f)),
    );
}

/** "Owner key" for each metadata array that holds undefined. */
function brokenMetadata(owner: string, target: object): string[] {
  return METADATA_KEYS.filter((key) => {
    const value: unknown = Reflect.getMetadata(key, target);
    return Array.isArray(value) && value.includes(undefined);
  }).map((key) => `${owner} ${key}`);
}

/** The class and its methods; descriptors, so no getter runs here. */
function classTargets(cls: {
  name: string;
  prototype?: object;
}): [string, object][] {
  const methods = Object.entries(
    Object.getOwnPropertyDescriptors(cls.prototype ?? {}),
  )
    .filter(([, d]) => typeof d.value === 'function')
    .map(([name, d]): [string, object] => [
      `${cls.name}.${name}`,
      d.value as object,
    ]);
  return [[cls.name, cls], ...methods];
}

function undefinedMetadata(): string[] {
  return Object.entries(require.cache)
    .filter(([id, mod]) => mod !== undefined && id.startsWith(MODULES_DIR))
    .flatMap(([, mod]): unknown[] => Object.values(mod?.exports as object))
    .filter((value) => typeof value === 'function')
    .flatMap((value) =>
      classTargets(value as { name: string; prototype?: object }),
    )
    .flatMap(([owner, target]) => brokenMetadata(owner, target));
}

describe('module entry points', () => {
  it.each(entryPoints())(
    '%s loads first without undefined Nest metadata',
    (entry) => {
      let found: string[] = [];
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- the point is loading this file first, in a fresh registry
        require(join(MODULES_DIR, entry));
        found = undefinedMetadata();
      });
      expect(found).toEqual([]);
    },
  );
});
