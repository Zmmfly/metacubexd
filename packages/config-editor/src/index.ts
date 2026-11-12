import { isMap, parseDocument } from 'yaml'

export type ConfigValue =
  | null
  | boolean
  | number
  | string
  | ConfigValue[]
  | { [key: string]: ConfigValue }

export type ConfigObject = Record<string, ConfigValue>

export interface ConfigDiagnostic {
  path: Array<string | number>
  code:
    | 'invalid-root'
    | 'duplicate-name'
    | 'missing-name'
    | 'missing-type'
    | 'missing-reference'
    | 'proxy-cycle'
    | 'invalid-rule'
  message: string
  severity: 'error' | 'warning'
}

export interface ConfigDocument {
  data: ConfigObject
  yaml: string
  revision: string
  diagnostics: ConfigDiagnostic[]
}

export interface PatchTarget {
  path: string[]
  /** Field used as semantic identity for entries in an array. */
  key?: string
  /** Identity value for a named resource. */
  id?: string
}

export type ConfigPatchOperation =
  | {
      op: 'set'
      target: PatchTarget
      expectedHash: string
      value: ConfigValue
    }
  | {
      op: 'remove'
      target: PatchTarget
      expectedHash: string
    }
  | {
      op: 'upsert'
      target: Required<PatchTarget>
      expectedHash: string
      value: ConfigObject
      /** Original resource used for a three-way rebase after subscription refreshes. */
      previousValue?: ConfigObject
    }
  | {
      op: 'delete'
      target: Required<PatchTarget>
      expectedHash: string
    }
  | {
      op: 'order'
      target: PatchTarget
      expectedHash: string
      previousIds: string[]
      ids: string[]
    }
  | {
      op: 'sequence-replace'
      target: PatchTarget & { id: string }
      expectedHash: string
      value: ConfigValue
    }
  | {
      op: 'sequence-delete'
      target: PatchTarget & { id: string }
      expectedHash: string
    }
  | {
      op: 'sequence-insert'
      target: PatchTarget & { id: string }
      expectedHash: string
      value: ConfigValue
      beforeId?: string
      afterId?: string
      fallback?: 'start' | 'end'
    }
  | {
      op: 'sequence-order'
      target: PatchTarget
      expectedHash: string
      previousIds: string[]
      ids: string[]
    }

export interface ConfigPatchV1 {
  version: 1
  baseRevision: string
  operations: ConfigPatchOperation[]
}

export interface ConfigPatchConflict {
  operation: ConfigPatchOperation
  path: Array<string | number>
  reason: 'changed' | 'missing' | 'duplicate' | 'invalid-target'
  current?: ConfigValue
}

export interface ApplyPatchResult {
  document: ConfigDocument
  conflicts: ConfigPatchConflict[]
  applied: number
}

export type ConfigResourceReferenceKind =
  | 'proxy-group-member'
  | 'rule-policy'
  | 'dialer-proxy'
  | 'provider-proxy'
  | 'listener-proxy'
  | 'tunnel-proxy'

export interface ConfigResourceReference {
  path: Array<string | number>
  kind: ConfigResourceReferenceKind
  name: string
}

export class ConfigDocumentError extends Error {
  constructor(
    message: string,
    readonly errors: string[],
  ) {
    super(message)
    this.name = 'ConfigDocumentError'
  }
}

const NAMED_ARRAYS: Record<string, string> = {
  proxies: 'name',
  'proxy-groups': 'name',
  listeners: 'name',
  tunnels: 'network',
}

const NAMED_MAPS = new Set([
  'proxy-providers',
  'rule-providers',
  'sub-rules',
  'hosts',
])

function isObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clone<T extends ConfigValue>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)]),
    ) as T
  }
  return value
}

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Stable, browser-safe FNV-1a hash; used for optimistic concurrency, not crypto. */
export function hashConfigValue(value: unknown): string {
  const input = canonical(value)
  let hash = 2_166_136_261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function parseYaml(yaml: string): ConfigObject {
  const doc = parseDocument(yaml, { prettyErrors: true, uniqueKeys: true })
  const errors = doc.errors.map((error) => error.message)
  if (errors.length) {
    throw new ConfigDocumentError('Invalid YAML configuration', errors)
  }
  if (!isMap(doc.contents)) {
    throw new ConfigDocumentError('Configuration root must be a mapping', [
      'Configuration root must be a mapping',
    ])
  }
  const value = doc.toJS({ mapAsMap: false }) as unknown
  if (!isObject(value)) {
    throw new ConfigDocumentError('Configuration root must be a mapping', [
      'Configuration root must be a mapping',
    ])
  }
  return value
}

export function openDocument(yaml: string): ConfigDocument {
  const normalizedYaml = yaml.trim() ? yaml : '{}\n'
  const data = parseYaml(normalizedYaml)
  return {
    data,
    yaml: normalizedYaml,
    revision: hashConfigValue(data),
    diagnostics: validateDocument(data),
  }
}

function getAtPath(
  root: ConfigObject,
  path: string[],
): ConfigValue | undefined {
  let current: ConfigValue | undefined = root
  for (const segment of path) {
    if (current === undefined || !isObject(current)) return undefined
    current = current[segment]
    if (current === undefined) return undefined
  }
  return current
}

function ensureParent(root: ConfigObject, path: string[]): ConfigObject | null {
  let current: ConfigObject = root
  for (const segment of path.slice(0, -1)) {
    const next = current[segment]
    if (next === undefined) {
      const created: ConfigObject = {}
      current[segment] = created
      current = created
    } else if (isObject(next)) {
      current = next
    } else {
      return null
    }
  }
  return current
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

function namedArrayDiff(
  section: string,
  key: string,
  before: ConfigValue[],
  after: ConfigValue[],
): ConfigPatchOperation[] | null {
  const beforeById = new Map<string, ConfigObject>()
  const afterById = new Map<string, ConfigObject>()
  for (const value of before) {
    if (!isObject(value) || typeof value[key] !== 'string') return null
    const id = String(value[key])
    if (beforeById.has(id)) return null
    beforeById.set(id, value)
  }
  for (const value of after) {
    if (!isObject(value) || typeof value[key] !== 'string') return null
    const id = String(value[key])
    if (afterById.has(id)) return null
    afterById.set(id, value)
  }

  const operations: ConfigPatchOperation[] = []
  for (const [id, previous] of beforeById) {
    const next = afterById.get(id)
    if (!next) {
      operations.push({
        op: 'delete',
        target: { path: [section], key, id },
        expectedHash: hashConfigValue(previous),
      })
    } else if (!valuesEqual(previous, next)) {
      operations.push({
        op: 'upsert',
        target: { path: [section], key, id },
        expectedHash: hashConfigValue(previous),
        value: clone(next),
        previousValue: clone(previous),
      })
    }
  }
  for (const [id, next] of afterById) {
    if (beforeById.has(id)) continue
    operations.push({
      op: 'upsert',
      target: { path: [section], key, id },
      expectedHash: hashConfigValue(undefined),
      value: clone(next),
    })
  }

  const beforeOrder = before.map((value) =>
    String((value as ConfigObject)[key]),
  )
  const afterOrder = after.map((value) => String((value as ConfigObject)[key]))
  if (!valuesEqual(beforeOrder, afterOrder)) {
    operations.push({
      op: 'order',
      target: { path: [section], key },
      expectedHash: hashConfigValue(
        beforeOrder.filter((id) => afterById.has(id)),
      ),
      previousIds: beforeOrder.filter((id) => afterById.has(id)),
      ids: afterOrder,
    })
  }
  return operations
}

function namedMapDiff(
  section: string,
  before: ConfigObject,
  after: ConfigObject,
): ConfigPatchOperation[] {
  const operations: ConfigPatchOperation[] = []
  for (const [id, previous] of Object.entries(before)) {
    const next = after[id]
    if (next === undefined) {
      operations.push({
        op: 'remove',
        target: { path: [section, id] },
        expectedHash: hashConfigValue(previous),
      })
    } else if (!valuesEqual(previous, next)) {
      operations.push({
        op: 'set',
        target: { path: [section, id] },
        expectedHash: hashConfigValue(previous),
        value: clone(next),
      })
    }
  }
  for (const [id, next] of Object.entries(after)) {
    if (before[id] !== undefined) continue
    operations.push({
      op: 'set',
      target: { path: [section, id] },
      expectedHash: hashConfigValue(undefined),
      value: clone(next),
    })
  }
  return operations
}

function sequenceEntries(values: ConfigValue[]) {
  const occurrences = new Map<string, number>()
  return values.map((value) => {
    const hash = hashConfigValue(value)
    const occurrence = occurrences.get(hash) ?? 0
    occurrences.set(hash, occurrence + 1)
    return { id: `${hash}:${occurrence}`, hash, value }
  })
}

function sequenceDiff(
  section: string,
  before: ConfigValue[],
  after: ConfigValue[],
): ConfigPatchOperation[] {
  const previous = sequenceEntries(before)
  const next = sequenceEntries(after)
  const previousById = new Map(previous.map((entry) => [entry.id, entry]))
  const nextById = new Map(next.map((entry) => [entry.id, entry]))
  const operations: ConfigPatchOperation[] = []
  const consumedPrevious = new Set<string>()
  const consumedNext = new Set<string>()

  // An in-place edit is represented as replace rather than delete+insert.
  for (let index = 0; index < Math.min(previous.length, next.length); index++) {
    const oldEntry = previous[index]!
    const newEntry = next[index]!
    if (oldEntry.id === newEntry.id) continue
    if (!nextById.has(oldEntry.id) && !previousById.has(newEntry.id)) {
      operations.push({
        op: 'sequence-replace',
        target: { path: [section], id: oldEntry.id },
        expectedHash: oldEntry.hash,
        value: clone(newEntry.value),
      })
      consumedPrevious.add(oldEntry.id)
      consumedNext.add(newEntry.id)
    }
  }

  for (const entry of previous) {
    if (consumedPrevious.has(entry.id) || nextById.has(entry.id)) continue
    operations.push({
      op: 'sequence-delete',
      target: { path: [section], id: entry.id },
      expectedHash: entry.hash,
    })
  }
  for (let index = 0; index < next.length; index++) {
    const entry = next[index]!
    if (consumedNext.has(entry.id) || previousById.has(entry.id)) continue
    const beforeId = next
      .slice(index + 1)
      .find((candidate) => previousById.has(candidate.id))?.id
    // Newly inserted neighbours are valid preceding anchors too: operations
    // run in draft order, so they preserve adjacent custom rules if the old
    // subscription anchors disappear together.
    const afterId = next
      .slice(0, index)
      .reverse()
      .find((candidate) => !consumedNext.has(candidate.id))?.id
    operations.push({
      op: 'sequence-insert',
      target: { path: [section], id: entry.id },
      expectedHash: hashConfigValue(undefined),
      value: clone(entry.value),
      ...(beforeId ? { beforeId } : {}),
      ...(afterId ? { afterId } : {}),
      ...(beforeId
        ? afterId
          ? {}
          : { fallback: 'start' as const }
        : { fallback: 'end' as const }),
    })
  }

  const retainedPrevious = previous
    .filter(
      (entry) => nextById.has(entry.id) && !consumedPrevious.has(entry.id),
    )
    .map((entry) => entry.id)
  const retainedNext = next
    .filter(
      (entry) => previousById.has(entry.id) && !consumedNext.has(entry.id),
    )
    .map((entry) => entry.id)
  if (!valuesEqual(retainedPrevious, retainedNext)) {
    operations.push({
      op: 'sequence-order',
      target: { path: [section] },
      expectedHash: hashConfigValue(retainedPrevious),
      previousIds: retainedPrevious,
      ids: retainedNext,
    })
  }
  return operations
}

export function diffDocument(
  base: ConfigDocument | string,
  draft: ConfigDocument | string,
): ConfigPatchV1 {
  const before = typeof base === 'string' ? openDocument(base) : base
  const after = typeof draft === 'string' ? openDocument(draft) : draft
  const operations: ConfigPatchOperation[] = []
  const keys = new Set([
    ...Object.keys(before.data),
    ...Object.keys(after.data),
  ])

  for (const key of keys) {
    const previous = before.data[key]
    const next = after.data[key]
    if (valuesEqual(previous, next)) continue
    const semanticKey = NAMED_ARRAYS[key]
    if (semanticKey && Array.isArray(previous) && Array.isArray(next)) {
      const semantic = namedArrayDiff(key, semanticKey, previous, next)
      if (semantic) {
        operations.push(...semantic)
        continue
      }
    }
    if (NAMED_MAPS.has(key) && isObject(previous) && isObject(next)) {
      operations.push(...namedMapDiff(key, previous, next))
      continue
    }
    if (key === 'rules' && Array.isArray(previous) && Array.isArray(next)) {
      operations.push(...sequenceDiff(key, previous, next))
      continue
    }
    if (next === undefined) {
      operations.push({
        op: 'remove',
        target: { path: [key] },
        expectedHash: hashConfigValue(previous),
      })
    } else {
      operations.push({
        op: 'set',
        target: { path: [key] },
        expectedHash: hashConfigValue(previous),
        value: clone(next),
      })
    }
  }

  return { version: 1, baseRevision: before.revision, operations }
}

/** Replace the JS view while preserving untouched top-level YAML nodes. */
export function replaceDocumentData(
  source: ConfigDocument | string,
  nextData: ConfigObject,
): ConfigDocument {
  const current = typeof source === 'string' ? openDocument(source) : source
  const touched = new Set<string>()
  const keys = new Set([...Object.keys(current.data), ...Object.keys(nextData)])
  for (const key of keys) {
    if (!valuesEqual(current.data[key], nextData[key])) touched.add(key)
  }
  return openDocument(stringifyTouched(current.yaml, nextData, touched))
}

function conflict(
  operation: ConfigPatchOperation,
  reason: ConfigPatchConflict['reason'],
  current?: ConfigValue,
): ConfigPatchConflict {
  return { operation, path: operation.target.path, reason, current }
}

interface RebaseResult {
  value?: ConfigValue
  conflict: boolean
}

/** Merge one local value with a refreshed upstream value relative to their base. */
function rebaseValue(
  base: ConfigValue | undefined,
  local: ConfigValue | undefined,
  current: ConfigValue | undefined,
): RebaseResult {
  if (valuesEqual(local, base)) {
    return {
      value: current === undefined ? undefined : clone(current),
      conflict: false,
    }
  }
  if (valuesEqual(current, base) || valuesEqual(local, current)) {
    return {
      value: local === undefined ? undefined : clone(local),
      conflict: false,
    }
  }

  if (isObject(base) && isObject(local) && isObject(current)) {
    const merged: ConfigObject = {}
    const keys = new Set([
      ...Object.keys(base),
      ...Object.keys(local),
      ...Object.keys(current),
    ])
    for (const key of keys) {
      const result = rebaseValue(base[key], local[key], current[key])
      if (result.conflict) return { conflict: true }
      if (result.value !== undefined) merged[key] = result.value
    }
    return { value: merged, conflict: false }
  }

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(current)) {
    const root: ConfigObject = { values: clone(current) }
    for (const operation of sequenceDiff('values', base, local)) {
      if (!isSequenceOperation(operation)) return { conflict: true }
      if (applySequenceOperation(root, operation)) return { conflict: true }
    }
    return { value: root.values, conflict: false }
  }

  return { conflict: true }
}

function applyNamedOperation(
  root: ConfigObject,
  operation: Extract<ConfigPatchOperation, { op: 'upsert' | 'delete' }>,
): ConfigPatchConflict | undefined {
  const collection = getAtPath(root, operation.target.path)
  if (!Array.isArray(collection)) {
    if (
      operation.op === 'upsert' &&
      operation.expectedHash === hashConfigValue(undefined)
    ) {
      const parent = ensureParent(root, operation.target.path)
      const field = operation.target.path.at(-1)
      if (!parent || !field) return conflict(operation, 'invalid-target')
      parent[field] = [clone(operation.value)]
      return
    }
    return conflict(operation, 'invalid-target', collection)
  }
  const matches = collection
    .map((value, index) => ({ value, index }))
    .filter(
      ({ value }) =>
        isObject(value) &&
        String(value[operation.target.key]) === operation.target.id,
    )
  if (matches.length > 1) return conflict(operation, 'duplicate')
  const match = matches[0]
  if (!match) {
    if (
      operation.op === 'upsert' &&
      operation.expectedHash === hashConfigValue(undefined)
    ) {
      collection.push(clone(operation.value))
      return
    }
    return conflict(operation, 'missing')
  }
  if (hashConfigValue(match.value) !== operation.expectedHash) {
    if (
      operation.op === 'upsert' &&
      operation.expectedHash === hashConfigValue(undefined) &&
      valuesEqual(match.value, operation.value)
    ) {
      // The refreshed subscription independently gained the same resource.
      return
    }
    if (operation.op === 'upsert' && operation.previousValue) {
      const rebased = rebaseValue(
        operation.previousValue,
        operation.value,
        match.value,
      )
      if (!rebased.conflict && isObject(rebased.value)) {
        collection[match.index] = clone(rebased.value)
        return
      }
    }
    return conflict(operation, 'changed', match.value)
  }
  if (operation.op === 'delete') collection.splice(match.index, 1)
  else collection[match.index] = clone(operation.value)
}

function applyOrderOperation(
  root: ConfigObject,
  operation: Extract<ConfigPatchOperation, { op: 'order' }>,
): ConfigPatchConflict | undefined {
  const collection = getAtPath(root, operation.target.path)
  if (!Array.isArray(collection) || !operation.target.key) {
    return conflict(operation, 'invalid-target', collection)
  }
  const keyed = new Map<string, ConfigValue>()
  for (const value of collection) {
    if (!isObject(value) || typeof value[operation.target.key] !== 'string') {
      return conflict(operation, 'invalid-target', collection)
    }
    const id = String(value[operation.target.key])
    if (keyed.has(id)) return conflict(operation, 'duplicate')
    keyed.set(id, value)
  }
  const currentOrder = [...keyed.keys()].filter((id) =>
    operation.previousIds.includes(id),
  )
  const missing = operation.previousIds.some((id) => !keyed.has(id))
  const changed = hashConfigValue(currentOrder) !== operation.expectedHash
  const reordersExisting = !valuesEqual(
    operation.previousIds,
    operation.ids.filter((id) => operation.previousIds.includes(id)),
  )
  if (missing || changed) {
    if (reordersExisting) {
      return conflict(operation, missing ? 'missing' : 'changed', currentOrder)
    }
    // Adding/removing resources used to emit an order operation even when no
    // existing resource was reordered. Keep the refreshed upstream order for
    // those legacy operations instead of conflicting on unrelated upstream
    // additions, removals, or reordering. New patches use the same semantics.
    return
  }
  // Unknown resources added by a refreshed subscription remain at the end.
  const ordered = operation.ids
    .map((id) => keyed.get(id))
    .filter((v) => v !== undefined)
  const unknown = collection.filter((value) => {
    const id = String((value as ConfigObject)[operation.target.key!])
    return !operation.ids.includes(id)
  })
  collection.splice(0, collection.length, ...ordered, ...unknown)
}

function applySequenceOperation(
  root: ConfigObject,
  operation: Extract<
    ConfigPatchOperation,
    {
      op:
        | 'sequence-replace'
        | 'sequence-delete'
        | 'sequence-insert'
        | 'sequence-order'
    }
  >,
): ConfigPatchConflict | undefined {
  const collection = getAtPath(root, operation.target.path)
  if (!Array.isArray(collection)) {
    return conflict(operation, 'invalid-target', collection)
  }
  const entries = sequenceEntries(collection)
  if (operation.op === 'sequence-order') {
    const byId = new Map(entries.map((entry) => [entry.id, entry.value]))
    if (operation.previousIds.some((id) => !byId.has(id))) {
      return conflict(
        operation,
        'missing',
        entries.map((entry) => entry.id),
      )
    }
    const currentOrder = entries
      .map((entry) => entry.id)
      .filter((id) => operation.previousIds.includes(id))
    if (hashConfigValue(currentOrder) !== operation.expectedHash) {
      return conflict(operation, 'changed', currentOrder)
    }
    const ordered = operation.ids
      .map((id) => byId.get(id))
      .filter((value) => value !== undefined)
    const unknown = entries
      .filter((entry) => !operation.ids.includes(entry.id))
      .map((entry) => entry.value)
    collection.splice(0, collection.length, ...ordered, ...unknown)
    return
  }

  const index = entries.findIndex((entry) => entry.id === operation.target.id)
  if (operation.op === 'sequence-insert') {
    // An identical upstream addition already satisfies this operation.
    if (index >= 0) return
    let targetIndex = collection.length
    const beforeIndex = operation.beforeId
      ? entries.findIndex((entry) => entry.id === operation.beforeId)
      : -1
    if (beforeIndex >= 0) {
      targetIndex = beforeIndex
    } else {
      const afterIndex = operation.afterId
        ? entries.findIndex((entry) => entry.id === operation.afterId)
        : -1
      if (afterIndex >= 0) {
        targetIndex = afterIndex + 1
      } else if (operation.beforeId) {
        if (
          operation.fallback === 'start' ||
          (!operation.afterId && !operation.fallback)
        ) {
          // Version-1 patches only recorded a following anchor. Preserve those
          // legacy additions as leading overrides when that anchor disappears.
          targetIndex = 0
        } else if (operation.fallback !== 'end') {
          // A middle insertion with neither neighbour left is ambiguous; keep
          // the conflict rather than silently changing rule priority.
          return conflict(operation, 'missing')
        }
      }
    }
    collection.splice(targetIndex, 0, clone(operation.value))
    return
  }
  if (index < 0) return conflict(operation, 'missing')
  if (entries[index]!.hash !== operation.expectedHash) {
    return conflict(operation, 'changed', collection[index])
  }
  if (operation.op === 'sequence-delete') collection.splice(index, 1)
  else collection[index] = clone(operation.value)
}

function isSequenceOperation(
  operation: ConfigPatchOperation,
): operation is Extract<
  ConfigPatchOperation,
  {
    op:
      | 'sequence-replace'
      | 'sequence-delete'
      | 'sequence-insert'
      | 'sequence-order'
  }
> {
  return operation.op.startsWith('sequence-')
}

export interface CapturePatchBaseValuesResult {
  patch: ConfigPatchV1
  captured: number
}

/**
 * Capture original named resources in legacy patches while their hashes still
 * match the current base. This must run before replacing a remote base.
 */
export function capturePatchBaseValues(
  current: ConfigDocument | string,
  patch: ConfigPatchV1,
): CapturePatchBaseValuesResult {
  const source = typeof current === 'string' ? openDocument(current) : current
  let captured = 0
  const operations = patch.operations.map((operation) => {
    if (operation.op !== 'upsert' || operation.previousValue !== undefined) {
      return operation
    }
    const collection = getAtPath(source.data, operation.target.path)
    if (!Array.isArray(collection)) return operation
    const matches = collection.filter(
      (value): value is ConfigObject =>
        isObject(value) &&
        String(value[operation.target.key]) === operation.target.id,
    )
    if (
      matches.length !== 1 ||
      hashConfigValue(matches[0]) !== operation.expectedHash
    ) {
      return operation
    }
    captured++
    return { ...operation, previousValue: clone(matches[0]!) }
  })
  return {
    patch: captured ? { ...patch, operations } : patch,
    captured,
  }
}

function stringifyTouched(
  sourceYaml: string,
  data: ConfigObject,
  touched: Set<string>,
): string {
  const doc = parseDocument(sourceYaml, {
    prettyErrors: true,
    uniqueKeys: true,
  })
  if (!isMap(doc.contents)) return sourceYaml
  for (const key of touched) {
    if (data[key] === undefined) doc.delete(key)
    else doc.set(key, doc.createNode(data[key]))
  }
  return String(doc)
}

export function applyPatch(
  current: ConfigDocument | string,
  patch: ConfigPatchV1,
): ApplyPatchResult {
  if (patch.version !== 1) {
    throw new Error(
      `Unsupported configuration patch version: ${String(patch.version)}`,
    )
  }
  const source = typeof current === 'string' ? openDocument(current) : current
  const data = clone(source.data)
  const conflicts: ConfigPatchConflict[] = []
  const touched = new Set<string>()
  let applied = 0

  for (const operation of patch.operations) {
    const top = operation.target.path[0]
    if (top) touched.add(top)
    let opConflict: ConfigPatchConflict | undefined
    if (operation.op === 'upsert' || operation.op === 'delete') {
      opConflict = applyNamedOperation(data, operation)
    } else if (operation.op === 'order') {
      opConflict = applyOrderOperation(data, operation)
    } else if (isSequenceOperation(operation)) {
      opConflict = applySequenceOperation(data, operation)
    } else {
      const parent = ensureParent(data, operation.target.path)
      const field = operation.target.path.at(-1)
      if (!parent || !field) {
        opConflict = conflict(operation, 'invalid-target')
      } else {
        const currentValue = getAtPath(data, operation.target.path)
        if (hashConfigValue(currentValue) !== operation.expectedHash) {
          opConflict = conflict(operation, 'changed', currentValue)
        } else if (operation.op === 'remove') {
          delete parent[field]
        } else {
          parent[field] = clone(operation.value)
        }
      }
    }
    if (opConflict) conflicts.push(opConflict)
    else applied++
  }

  const yaml = stringifyTouched(source.yaml, data, touched)
  return { document: openDocument(yaml), conflicts, applied }
}

function resourceNames(data: ConfigObject): Set<string> {
  const names = new Set([
    'DIRECT',
    'REJECT',
    'REJECT-DROP',
    'REJECT-TINYGIF',
    'PASS',
    'COMPATIBLE',
    'GLOBAL',
  ])
  for (const section of ['proxies', 'proxy-groups'] as const) {
    const entries = data[section]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (isObject(entry) && typeof entry.name === 'string')
        names.add(entry.name)
    }
  }
  return names
}

function mapNames(data: ConfigObject, section: string): Set<string> {
  const value = data[section]
  return isObject(value) ? new Set(Object.keys(value)) : new Set()
}

/**
 * Split a Mihomo rule at top-level commas only. Logical rules contain nested
 * comma-separated expressions, and quoted payloads may contain commas too, so
 * a bare String.split(',') corrupts both their policy lookup and round-trips.
 */
export function splitRuleFields(rule: string): string[] {
  const fields: string[] = []
  let field = ''
  let depth = 0
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const character of rule) {
    if (escaped) {
      field += character
      escaped = false
      continue
    }
    if (character === '\\') {
      field += character
      escaped = true
      continue
    }
    if (quote) {
      field += character
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      field += character
      continue
    }
    if (character === '(' || character === '[' || character === '{') {
      depth++
      field += character
      continue
    }
    if (character === ')' || character === ']' || character === '}') {
      depth = Math.max(0, depth - 1)
      field += character
      continue
    }
    if (character === ',' && depth === 0) {
      fields.push(field.trim())
      field = ''
      continue
    }
    field += character
  }
  fields.push(field.trim())
  return fields
}

function rulePolicy(rule: string): string | undefined {
  const fields = splitRuleFields(rule)
  const type = fields[0]?.toUpperCase()
  if (type === 'MATCH') return fields[1]
  // SUB-RULE's final field is a sub-rule collection name, not a proxy policy.
  if (type === 'SUB-RULE') return undefined
  return fields[2]
}

function collectRuleReferences(
  rules: ConfigValue | undefined,
  path: Array<string | number>,
): ConfigResourceReference[] {
  if (!Array.isArray(rules)) return []
  return rules.flatMap((rule, index) => {
    if (typeof rule !== 'string') return []
    const policy = rulePolicy(rule)
    return policy
      ? [{ path: [...path, index], kind: 'rule-policy' as const, name: policy }]
      : []
  })
}

function collectKeyReferences(
  value: ConfigValue | undefined,
  path: Array<string | number>,
  key: string,
  kind: ConfigResourceReferenceKind,
): ConfigResourceReference[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectKeyReferences(item, [...path, index], key, kind),
    )
  }
  if (!isObject(value)) return []

  const references: ConfigResourceReference[] = []
  for (const [field, child] of Object.entries(value)) {
    const childPath = [...path, field]
    if (field === key && typeof child === 'string') {
      references.push({ path: childPath, kind, name: child })
    }
    references.push(...collectKeyReferences(child, childPath, key, kind))
  }
  return references
}

/** Return every named proxy/proxy-group reference in a config document. */
export function listResourceReferences(
  data: ConfigObject,
): ConfigResourceReference[] {
  const references: ConfigResourceReference[] = []
  const groups = data['proxy-groups']
  if (Array.isArray(groups)) {
    groups.forEach((group, groupIndex) => {
      if (!isObject(group) || !Array.isArray(group.proxies)) return
      group.proxies.forEach((name, memberIndex) => {
        if (typeof name !== 'string') return
        references.push({
          path: ['proxy-groups', groupIndex, 'proxies', memberIndex],
          kind: 'proxy-group-member',
          name,
        })
      })
    })
  }

  references.push(...collectRuleReferences(data.rules, ['rules']))
  const subRules = data['sub-rules']
  if (isObject(subRules)) {
    for (const [name, rules] of Object.entries(subRules)) {
      references.push(...collectRuleReferences(rules, ['sub-rules', name]))
    }
  }

  // dialer-proxy has the same named-resource meaning wherever Mihomo accepts
  // it (nodes, providers, overrides and NTP), so scan it across the document.
  references.push(
    ...collectKeyReferences(data, [], 'dialer-proxy', 'dialer-proxy'),
  )
  for (const section of ['proxy-providers', 'rule-providers'] as const) {
    references.push(
      ...collectKeyReferences(
        data[section],
        [section],
        'proxy',
        'provider-proxy',
      ),
    )
  }
  references.push(
    ...collectKeyReferences(
      data.listeners,
      ['listeners'],
      'proxy',
      'listener-proxy',
    ),
    ...collectKeyReferences(data.tunnels, ['tunnels'], 'proxy', 'tunnel-proxy'),
  )
  return references
}

export function findResourceReferences(
  data: ConfigObject,
  name: string,
): ConfigResourceReference[] {
  return listResourceReferences(data).filter(
    (reference) => reference.name === name,
  )
}

type ProxyChainGraph = Map<string, Set<string>>

function proxyChainGraph(data: ConfigObject): ProxyChainGraph {
  const graph: ProxyChainGraph = new Map()
  for (const section of ['proxies', 'proxy-groups'] as const) {
    const entries = data[section]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!isObject(entry) || typeof entry.name !== 'string' || !entry.name) {
        continue
      }
      const targets = graph.get(entry.name) ?? new Set<string>()
      graph.set(entry.name, targets)
      if (typeof entry['dialer-proxy'] === 'string') {
        targets.add(entry['dialer-proxy'])
      }
      if (section === 'proxy-groups' && Array.isArray(entry.proxies)) {
        for (const member of entry.proxies) {
          if (typeof member === 'string') targets.add(member)
        }
      }
    }
  }
  return graph
}

function findProxyChainCycle(graph: ProxyChainGraph, start: string): string[] {
  const stack: string[] = []
  const states = new Map<string, 'visiting' | 'done'>()
  const visit = (name: string): string[] | undefined => {
    if (states.get(name) === 'visiting') {
      const index = stack.indexOf(name)
      return [...stack.slice(index), name]
    }
    if (states.get(name) === 'done') return undefined
    const targets = graph.get(name)
    if (!targets) {
      states.set(name, 'done')
      return undefined
    }
    states.set(name, 'visiting')
    stack.push(name)
    for (const target of targets) {
      const cycle = visit(target)
      if (cycle) return cycle
    }
    stack.pop()
    states.set(name, 'done')
    return undefined
  }
  return visit(start) ?? []
}

/** Return the first cycle reachable from a named proxy chain, if any. */
export function findDialerProxyCycle(
  data: ConfigObject,
  start: string,
): string[] {
  return findProxyChainCycle(proxyChainGraph(data), start)
}

export function validateDocument(data: ConfigObject): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = []
  const names = resourceNames(data)
  const proxyProviders = mapNames(data, 'proxy-providers')
  const ruleProviders = mapNames(data, 'rule-providers')
  const chainGraph = proxyChainGraph(data)

  for (const [section, identity] of Object.entries(NAMED_ARRAYS)) {
    const entries = data[section]
    if (!Array.isArray(entries)) continue
    const seen = new Set<string>()
    entries.forEach((entry, index) => {
      if (
        !isObject(entry) ||
        typeof entry[identity] !== 'string' ||
        !entry[identity]
      ) {
        diagnostics.push({
          path: [section, index, identity],
          code: 'missing-name',
          message: `${section} entry requires ${identity}`,
          severity: 'error',
        })
        return
      }
      const id = String(entry[identity])
      if (seen.has(id)) {
        diagnostics.push({
          path: [section, index, identity],
          code: 'duplicate-name',
          message: `Duplicate ${section} identity: ${id}`,
          severity: 'error',
        })
      }
      seen.add(id)
      if (
        ['proxies', 'proxy-groups', 'listeners'].includes(section) &&
        typeof entry.type !== 'string'
      ) {
        diagnostics.push({
          path: [section, index, 'type'],
          code: 'missing-type',
          message: `${section} entry requires type`,
          severity: 'error',
        })
      }
      if (section === 'proxy-groups') {
        const providers = entry.use
        if (Array.isArray(providers)) {
          providers.forEach((reference, refIndex) => {
            if (
              typeof reference === 'string' &&
              !proxyProviders.has(reference)
            ) {
              diagnostics.push({
                path: [section, index, 'use', refIndex],
                code: 'missing-reference',
                message: `Unknown proxy provider: ${reference}`,
                severity: 'error',
              })
            }
          })
        }
      }
    })
  }

  for (const section of ['proxies', 'proxy-groups'] as const) {
    const entries = data[section]
    if (!Array.isArray(entries)) continue
    entries.forEach((entry, index) => {
      if (
        !isObject(entry) ||
        typeof entry.name !== 'string' ||
        typeof entry['dialer-proxy'] !== 'string'
      ) {
        return
      }
      const cycle = findProxyChainCycle(chainGraph, entry.name)
      if (!cycle.length) return
      diagnostics.push({
        path: [section, index, 'dialer-proxy'],
        code: 'proxy-cycle',
        message: `Proxy chain contains a cycle: ${cycle.join(' -> ')}`,
        severity: 'error',
      })
    })
  }

  for (const reference of listResourceReferences(data)) {
    if (names.has(reference.name)) continue
    diagnostics.push({
      path: reference.path,
      code: 'missing-reference',
      message: `Unknown proxy or group: ${reference.name}`,
      // Composite rules are parsed at top-level only. Keep their policy
      // diagnostics advisory and let Mihomo's validator remain authoritative.
      severity: reference.kind === 'rule-policy' ? 'warning' : 'error',
    })
  }

  const ruleCollections: Array<{
    path: Array<string | number>
    rules: ConfigValue | undefined
  }> = [{ path: ['rules'], rules: data.rules }]
  const subRules = data['sub-rules']
  if (isObject(subRules)) {
    for (const [name, rules] of Object.entries(subRules)) {
      ruleCollections.push({ path: ['sub-rules', name], rules })
    }
  }
  for (const collection of ruleCollections) {
    if (!Array.isArray(collection.rules)) continue
    collection.rules.forEach((rule, index) => {
      if (typeof rule !== 'string' || !rule.includes(',')) {
        diagnostics.push({
          path: [...collection.path, index],
          code: 'invalid-rule',
          message: 'Rule must be a comma-separated string',
          severity: 'error',
        })
        return
      }
      const parts = splitRuleFields(rule)
      if (parts[0] === 'RULE-SET' && parts[1] && !ruleProviders.has(parts[1])) {
        diagnostics.push({
          path: [...collection.path, index],
          code: 'missing-reference',
          message: `Unknown rule provider: ${parts[1]}`,
          severity: 'error',
        })
      }
      if (
        parts[0]?.toUpperCase() === 'SUB-RULE' &&
        parts[2] &&
        (!isObject(subRules) || !(parts[2] in subRules))
      ) {
        diagnostics.push({
          path: [...collection.path, index],
          code: 'missing-reference',
          message: `Unknown sub-rule: ${parts[2]}`,
          severity: 'error',
        })
      }
    })
  }
  return diagnostics
}

export const schemaSections = [
  'general',
  'experimental',
  'profile',
  'iptables',
  'tls',
  'proxies',
  'proxy-providers',
  'proxy-groups',
  'listeners',
  'rule-providers',
  'sub-rules',
  'rules',
  'hosts',
  'ntp',
  'dns',
  'tun',
  'tuic-server',
  'authentication',
  'tunnels',
  'sniffer',
  'clash-for-android',
] as const
