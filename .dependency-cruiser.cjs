// Architecture rules (HAN-113, variant A): a module is src/modules/<m>/ and
// shows the rest of the code only its index.ts; controllers talk to services,
// services to the EntityManager. Known old violations live in
// .dependency-cruiser-known-violations.json; new ones fail `npm run arch`.

const TESTS =
  '(\\.(spec|int-spec|e2e-spec)\\.ts$|^test/|/__fixtures__/|/testing/|^src/modules/[^/]+/testing\\.ts$)';

// What other code may import from a module: its index.ts barrel, its
// testing.ts (tests only) and its Nest modules (*.module.ts), which the
// barrels leave out so loading a barrel never drags the module graph in.
const PUBLIC_ENTRY =
  '(^src/modules/[^/]+/(index|testing)\\.ts$|^src/modules/.+\\.module\\.ts$)';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Import cycle. Move the shared piece into a leaf (a type, a DTO, src/common) ' +
        'or invert the dependency; do not hide it with forwardRef or a lazy require.',
      // Two-way ORM relations between entities are normal: MikroORM resolves
      // them lazily through () => Entity, so entity-only cycles are allowed.
      from: { pathNot: '^src/entities/' },
      to: {
        circular: true,
        // A type-only import is erased at runtime and cannot deadlock loading.
        viaOnly: { dependencyTypesNot: ['type-only'] },
      },
    },
    {
      name: 'module-public-api-only',
      severity: 'error',
      comment:
        "Import another module through its index.ts: from '../market', not " +
        "'../market/market.service' (Nest modules: '../market/market.module'). " +
        'If what you need is not in that index.ts, add it there on purpose ' +
        '(it becomes public API).',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/[^/]+/',
        pathNot: ['^src/modules/$1/', PUBLIC_ENTRY],
      },
    },
    {
      name: 'outside-uses-module-public-api',
      severity: 'error',
      comment:
        "Code outside src/modules imports a module through its index.ts ('src/modules/auth'), " +
        'never a file inside it.',
      from: { path: '^(src|test|scripts)/', pathNot: '^src/modules/' },
      to: {
        path: '^src/modules/[^/]+/',
        pathNot: PUBLIC_ENTRY,
      },
    },
    {
      name: 'testing-only-from-tests',
      severity: 'error',
      comment:
        'testing.ts, testing/ and __fixtures__/ hold test doubles. Only *.spec.ts, ' +
        '*.int-spec.ts, *.e2e-spec.ts and test/** may import them.',
      from: { pathNot: TESTS },
      to: {
        path: '(^src/modules/[^/]+/testing\\.ts$|/testing/|/__fixtures__/)',
      },
    },
    {
      name: 'no-em-in-controllers',
      severity: 'error',
      comment:
        'Controllers do not touch the database: move the query into the module service ' +
        'and call it. (health.controller pings the DB on purpose.)',
      from: {
        path: '\\.controller\\.ts$',
        pathNot: '^src/modules/health/health\\.controller\\.ts$',
      },
      to: { path: '@mikro-orm/' },
    },
    {
      name: 'common-is-leaf',
      severity: 'error',
      comment:
        'src/common, src/types and src/constants are shared by every module, so they ' +
        'must not depend on a module. Move the piece you need into common, or the ' +
        'code into the module.',
      from: { path: '^src/(common|types|constants)/', pathNot: TESTS },
      to: { path: '^src/modules/' },
    },
    {
      name: 'entities-are-leaf',
      severity: 'error',
      comment:
        'Entities describe tables only. Put enums and value types they need in ' +
        'src/types; services and modules depend on entities, not the other way round.',
      from: { path: '^src/entities/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'no-orphans',
      severity: 'error',
      comment:
        'Nothing imports this file. Delete it, or import it from where it belongs.',
      from: {
        orphan: true,
        pathNot: [
          TESTS,
          '\\.d\\.ts$',
          '^src/main\\.ts$',
          '^src/mikro-orm\\.config\\.ts$',
          '^src/migrations/',
          '^src/seeders/',
          '^scripts/',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^(dist|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.json'],
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(@[^/]+/[^/]+|[^/]+)' },
    },
  },
};
