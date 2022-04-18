import {assertNotNull} from "@subsquid/util"
import {EvmContractAddress, EvmLogHandler, EvmTopicSet} from "./interfaces/evm"
import {BlockHandler, EventHandler, ExtrinsicHandler} from "./interfaces/handlerContext"
import {Hooks} from "./interfaces/hooks"
import {QualifiedName} from "./interfaces/substrate"
import {Heap} from "./util/heap"
import {Range, rangeDifference, rangeIntersection} from "./util/range"

/**
 * Collects handlers for the various trigger types (pre/post block, event, extrinsic, EVM log).
 * Keeps a list of handlers of the type corresponding to the trigger.
 */
export interface DataHandlers {
    pre: BlockHandler[]
    post: BlockHandler[]
    events: Record<QualifiedName, EventHandler[]>
    /**
     * Mapping of type `trigger event` -> `extrinsic` -> `extrinsic handler list`
     */
    extrinsics: Record<QualifiedName, Record<QualifiedName, ExtrinsicHandler[]>>
    evmLogs: Record<EvmContractAddress, {filter?: EvmTopicSet[], handler: EvmLogHandler}[]>
}

/**
 * Defines a batch of blocks to be processed by specifying the block `range` ({@link Range}) and the `handlers` 
 * ({@link DataHandlers}) that are relevant to that range.
 * 
 * Each {@link DataHandlers} in a {@link Batch} is valid and can be applied to the Batch's {@link Range}.
 */
export interface Batch {
    range: Range
    handlers: DataHandlers
}

/**
 * Forms an array of {@link Batch} for the given {@link Range} by splitting the latter into smaller ranges and 
 * assigning {@link DataHandlers} found in {@link Hooks} to them, based on the range definitions of the Hooks 
 * themseves.
 * 
 * The Ranges covered by each Batch are non-overlapping and for each Batch, the {@link DataHandlers} are 
 * guaranteed to be applicable to its Range.
 * 
 * @param hooks a {@link Hooks} object, containing hooks for the various trigger types 
 * (Block, Event, Extrinsic, EvmLog)
 * @param blockRange a {@link Range} of blocks for which to create batches
 * @returns an array of {@link Batch}
 */
export function createBatches(hooks: Hooks, blockRange?: Range): Batch[] {
    let batches: Batch[] = []

    function getRange(hook: { range?: Range }): Range | undefined {
        let range: Range | undefined = hook.range || {from: 0}
        if (blockRange) {
            range = rangeIntersection(range, blockRange)
        }
        return range
    }

    hooks.pre.forEach(hook => {
        let range = getRange(hook)
        if (!range) return
        batches.push({
            range,
            handlers: {
                pre: [hook.handler],
                post: [],
                events: {},
                extrinsics: {},
                evmLogs: {}
            }
        })
    })

    hooks.post.forEach(hook => {
        let range = getRange(hook)
        if (!range) return
        batches.push({
            range,
            handlers: {
                pre: [],
                post: [hook.handler],
                events: {},
                extrinsics: {},
                evmLogs: {}
            }
        })
    })

    hooks.event.forEach(hook => {
        let range = getRange(hook)
        if (!range) return
        batches.push({
            range,
            handlers: {
                pre: [],
                post: [],
                events: {
                    [hook.event]: [hook.handler]
                },
                extrinsics: {},
                evmLogs: {}
            }
        })
    })

    hooks.extrinsic.forEach(hook => {
        let range = getRange(hook)
        if (!range) return
        batches.push({
            range,
            handlers: {
                pre: [],
                post: [],
                events: {},
                extrinsics: {
                    [hook.event]: {[hook.extrinsic]: [hook.handler]}
                },
                evmLogs: {}
            }
        })
    })

    hooks.evmLog.forEach(hook => {
        let range = getRange(hook)
        if (!range) return
        batches.push({
            range,
            handlers: {
                pre: [],
                post: [],
                events: {},
                extrinsics: {},
                evmLogs: {
                    [hook.contractAddress]: [{
                        filter: hook.filter,
                        handler: hook.handler
                    }]
                }
            }
        })
    })

    batches = mergeBatches(batches)

    return batches
}

/**
 * Given a list of {@link Batch} as input, it creates a new {@link Batch} list, in which there are no {@link Range} 
 * intersections and merging {@link DataHandlers} that apply to same batch
 * 
 * @param batches an array of {@link Batch}
 * @returns an array of merged {@link Batch}
 */
export function mergeBatches(batches: Batch[]): Batch[] {
    if (batches.length <= 1) return batches

    let union: Batch[] = []
    let heap = new Heap<Batch>((a, b) => a.range.from - b.range.from)

    heap.init(batches.slice())

    let top = assertNotNull(heap.pop())
    let batch: Batch | undefined
    while (batch = heap.peek()) {
        let i = rangeIntersection(top.range, batch.range)
        if (i == null) {
            union.push(top)
            top = assertNotNull(heap.pop())
        } else {
            heap.pop()
            rangeDifference(top.range, i).forEach(range => {
                heap.push({range, handlers: top.handlers})
            })
            rangeDifference(batch.range, i).forEach(range => {
                heap.push({range, handlers: batch!.handlers})
            })
            heap.push({
                range: i,
                handlers: mergeDataHandlers(top.handlers, batch.handlers)
            })
            top = assertNotNull(heap.pop())
        }
    }
    union.push(top)
    return union
}

/**
 * @internal
 */
function mergeDataHandlers(a: DataHandlers, b: DataHandlers): DataHandlers {
    return {
        pre: a.pre.concat(b.pre),
        post: a.post.concat(b.post),
        events: mergeMaps(a.events, b.events, (ha, hb) => ha.concat(hb)),
        extrinsics: mergeMaps(a.extrinsics, b.extrinsics, (ea, eb) => {
            return mergeMaps(ea, eb, (ha, hb) => ha.concat(hb))
        }),
        evmLogs: mergeMaps(a.evmLogs, b.evmLogs, (ha, hb) => ha.concat(hb)),
    }
}

/**
 * @internal
 */
function mergeMaps<T>(a: Record<string, T>, b: Record<string, T>, mergeItems: (a: T, b: T) => T): Record<string, T> {
    let result: Record<string, T> = {}
    for (let key in a) {
        if (b[key] == null) {
            result[key] = a[key]
        } else {
            result[key] = mergeItems(a[key], b[key])
        }
    }
    for (let key in b) {
        if (result[key] == null) {
            result[key] = b[key]
        }
    }
    return result
}

/**
 * Given a list of {@link Range}, it counts the total number of blocks spanned by the ranges, up to the chain height.
 * 
 * @param batches an array of objects containing {@link Range}
 * @param chainHeight the blockchain height (number of blocks up until the chain's head)
 * @returns the number of total blocks counted
 */
export function getBlocksCount(batches: { range: Range }[], chainHeight: number): number {
    let count = 0
    for (let i = 0; i < batches.length; i++) {
        let range = batches[i].range
        if (chainHeight < range.from) return count
        let to = Math.min(chainHeight, range.to ?? Infinity)
        count += to - range.from + 1
    }
    return count
}
