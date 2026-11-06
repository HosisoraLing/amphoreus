export default {
  resolve: { dedupe: ['react', 'react-dom'] },
  test: { include: ['scripts/stability-audit.spec.ts'], pool: 'forks', maxWorkers: 1, execArgv: ['--expose-gc'], testTimeout: 120000 },
}
