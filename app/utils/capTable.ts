// Cap-table FDS + pool math. The canonical implementation lives in the shared
// module (importable by both app/ and server/); this file re-exports it so
// client code keeps importing from `~/utils/capTable`.
export * from '~~/shared/capTableModel'
export type { OpenRoundPostFdsParts, PoolInputs } from '~~/shared/capTableModel'
