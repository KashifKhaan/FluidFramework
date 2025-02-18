/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { SummaryType } from "@fluidframework/protocol-definitions";
import { gcDeletedBlobKey, gcTombstoneBlobKey } from "@fluidframework/runtime-definitions";
import {
	currentGCVersion,
	gcStateBlobKey,
	GCSummaryStateTracker,
	GCVersion,
	IGarbageCollectionState,
	IGCStats,
} from "../../gc";
import { RefreshSummaryResult } from "../../summary";
import { parseNothing } from "./garbageCollection.spec";

type GCSummaryStateTrackerWithPrivates = Omit<GCSummaryStateTracker, "latestSummaryGCVersion"> & {
	latestSummaryGCVersion: GCVersion;
};

describe("GCSummaryStateTracker tests", () => {
	describe("latestSummaryGCVersion", () => {
		it("Persisted < Current: Do Need Reset", () => {
			const tracker: GCSummaryStateTrackerWithPrivates = new GCSummaryStateTracker(
				{
					shouldRunGC: true,
					tombstoneMode: false,
					gcVersionInBaseSnapshot: 0,
					gcVersionInEffect: 1,
				},
				true /* wasGCRunInBaseSnapshot */,
			) as any;
			assert.equal(tracker.doesGCStateNeedReset, false, "Precondition 1");
			assert.equal(tracker.currentGCVersion, 1, "Precondition 2");
			assert.equal(
				tracker.doesSummaryStateNeedReset,
				true,
				"Should need reset: Persisted GC Version was old",
			);
		});

		it("Persisted === Current: Don't Need Reset", () => {
			const tracker: GCSummaryStateTrackerWithPrivates = new GCSummaryStateTracker(
				{
					shouldRunGC: true,
					tombstoneMode: false,
					gcVersionInBaseSnapshot: 1,
					gcVersionInEffect: 1,
				},
				true /* wasGCRunInBaseSnapshot */,
			) as any;
			assert.equal(tracker.doesGCStateNeedReset, false, "Precondition 1");
			assert.equal(tracker.currentGCVersion, 1, "Precondition 2");
			assert.equal(
				tracker.doesSummaryStateNeedReset,
				false,
				"Shouldn't need reset: GC Versions match",
			);
		});

		it("Persisted > Current: Do Need Reset", () => {
			const tracker: GCSummaryStateTrackerWithPrivates = new GCSummaryStateTracker(
				{
					shouldRunGC: true,
					tombstoneMode: false,
					gcVersionInBaseSnapshot: 2,
					gcVersionInEffect: 1,
				},
				true /* wasGCRunInBaseSnapshot */,
			) as any;
			assert.equal(tracker.doesGCStateNeedReset, false, "Precondition 1");
			assert.equal(tracker.currentGCVersion, 1, "Precondition 2");

			// This covers the case where we rolled back an upgrade. Containers that successfully "upgraded" (reset) shouldn't need to do it again.
			assert.equal(
				tracker.doesSummaryStateNeedReset,
				true,
				"Should need reset: Persisted GC Version is not old",
			);
		});
	});

	/**
	 * These tests validate that the GC data is written in summary incrementally. Basically, only parts of the GC
	 * data that has changed since the last successful summary is re-written, rest is written as SummaryHandle.
	 */
	describe("Incremental summary of GC data", () => {
		const nodes = ["node1", "node2", "node3"];
		const initialGCState: IGarbageCollectionState = {
			gcNodes: {
				"/": { outboundRoutes: [] },
				[nodes[0]]: { outboundRoutes: [] },
				[nodes[1]]: { outboundRoutes: [] },
			},
		};
		const initialTombstones: string[] = [nodes[0], nodes[1]];
		const initialDeletedNodes: Set<string> = new Set([nodes[1]]);
		let summaryStateTracker: GCSummaryStateTracker;

		beforeEach(async () => {
			// Creates a summary state tracker and initialize it.
			summaryStateTracker = new GCSummaryStateTracker(
				{
					shouldRunGC: true,
					tombstoneMode: true,
					gcVersionInBaseSnapshot: currentGCVersion,
					gcVersionInEffect: currentGCVersion,
				},
				false /* wasGCRunInBaseSnapshot */,
			);

			summaryStateTracker.initializeBaseState({
				gcState: initialGCState,
				tombstones: initialTombstones,
				deletedNodes: Array.from(initialDeletedNodes),
			});
		});

		it("does incremental summary when nothing changes", async () => {
			// Summarize with the same GC state, tombstone state and deleted nodes as in the initial state.
			// The GC data should be summarized as a summary handle.
			const summary = summaryStateTracker.summarize(
				false /* fullTree */,
				true /* trackState */,
				initialGCState,
				initialDeletedNodes,
				initialTombstones,
			);
			assert(summary?.summary.type === SummaryType.Handle, "GC summary should be a handle");
		});

		it("does incremental summary when only GC state changes", async () => {
			// Summarize with the same tombstone state and deleted nodes but different GC state as in the initial.
			// state. The GC state should be summarized as a summary handle.
			const newGCState: IGarbageCollectionState = {
				gcNodes: {
					...initialGCState.gcNodes,
					[nodes[2]]: { outboundRoutes: [] },
				},
			};
			const summary = summaryStateTracker.summarize(
				false /* fullTree */,
				true /* trackState */,
				newGCState,
				initialDeletedNodes,
				initialTombstones,
			);
			assert(summary?.summary.type === SummaryType.Tree, "GC summary should be a tree");
			assert(
				summary.summary.tree[gcStateBlobKey].type === SummaryType.Blob,
				"GC state should be written as a blob",
			);
			assert(
				summary.summary.tree[gcTombstoneBlobKey].type === SummaryType.Handle,
				"Tombstone state should be written as handle",
			);
			assert(
				summary.summary.tree[gcDeletedBlobKey].type === SummaryType.Handle,
				"Deleted nodes should be written as handle",
			);
		});

		it("does incremental summary when only tombstone state changes", async () => {
			// Summarize with the same GC state and deleted nodes but different tombstone state as in the initial.
			// state. The tombstone state should be summarized as a summary handle.
			const newTombstones: string[] = Array.from([...initialTombstones, nodes[2]]);
			const summary = summaryStateTracker.summarize(
				false /* fullTree */,
				true /* trackState */,
				initialGCState,
				initialDeletedNodes,
				newTombstones,
			);
			assert(summary?.summary.type === SummaryType.Tree, "GC summary should be a tree");
			assert(
				summary.summary.tree[gcStateBlobKey].type === SummaryType.Handle,
				"GC state should be written as handle",
			);
			assert(
				summary.summary.tree[gcTombstoneBlobKey].type === SummaryType.Blob,
				"Tombstone state should be written as a blob",
			);
			assert(
				summary.summary.tree[gcDeletedBlobKey].type === SummaryType.Handle,
				"Deleted nodes should be written as handle",
			);
		});

		it("does incremental summary when only deleted nodes change", async () => {
			// Summarize with the same GC state and tombstone state but different deleted nodes as in the initial.
			// state. The deleted nodes should be summarized as a summary handle.
			const newDeletedNodes: Set<string> = new Set(...initialDeletedNodes, nodes[2]);
			const summary = summaryStateTracker.summarize(
				false /* fullTree */,
				true /* trackState */,
				initialGCState,
				newDeletedNodes,
				initialTombstones,
			);
			assert(summary?.summary.type === SummaryType.Tree, "GC summary should be a tree");
			assert(
				summary.summary.tree[gcStateBlobKey].type === SummaryType.Handle,
				"GC state should be written as handle",
			);
			assert(
				summary.summary.tree[gcTombstoneBlobKey].type === SummaryType.Handle,
				"Tombstone state should be written as handle",
			);
			assert(
				summary.summary.tree[gcDeletedBlobKey].type === SummaryType.Blob,
				"Deleted nodes should be written as a blob",
			);
		});
	});

	it("updates state updated data store count correctly", async () => {
		const updatedDataStoreCount = 10;
		const gcStats: IGCStats = {
			nodeCount: 0,
			unrefNodeCount: 0,
			updatedNodeCount: 0,
			dataStoreCount: 0,
			unrefDataStoreCount: 0,
			updatedDataStoreCount,
			attachmentBlobCount: 0,
			unrefAttachmentBlobCount: 0,
			updatedAttachmentBlobCount: 0,
		};

		const summaryStateTracker = new GCSummaryStateTracker(
			{
				shouldRunGC: true,
				tombstoneMode: true,
				gcVersionInBaseSnapshot: currentGCVersion,
				gcVersionInEffect: currentGCVersion,
			},
			false /* wasGCRunInBaseSnapshot */,
		);

		let expectedUpdatedDataStoreCount = updatedDataStoreCount;
		// Update the state from GC stats and validate it's the same as updatedDataStoreCount.
		summaryStateTracker.updateStateFromGCRunStats(gcStats);
		assert.strictEqual(
			summaryStateTracker.updatedDSCountSinceLastSummary,
			expectedUpdatedDataStoreCount,
			"Updated DS count is not correct",
		);

		// Call summarize but do not refresh latest summary. This mimics scenarios where summary generation fails
		// sometime after summarize. This means updatedDSCountSinceLastSummary should be updated incrementally
		// without resetting it.
		summaryStateTracker.summarize(
			false /* fullTree */,
			true /* trackState */,
			{ gcNodes: {} },
			new Set(),
			[],
		);

		// Update the stat from GC state again mimicking a GC run after a failed summary.
		expectedUpdatedDataStoreCount += updatedDataStoreCount;
		summaryStateTracker.updateStateFromGCRunStats(gcStats);
		assert.strictEqual(
			summaryStateTracker.updatedDSCountSinceLastSummary,
			expectedUpdatedDataStoreCount,
			"Updated DS count should have been incrementally updated",
		);

		// Call summarize and refresh latest summary. This mimics a successful summary after a failed one. After
		// this, updatedDSCountSinceLastSummary should be reset to 0.
		summaryStateTracker.summarize(
			false /* fullTree */,
			true /* trackState */,
			{ gcNodes: {} },
			new Set(),
			[],
		);
		const refreshSummaryResult: RefreshSummaryResult = {
			latestSummaryUpdated: true,
			wasSummaryTracked: true,
			summaryRefSeq: 0,
		};
		await summaryStateTracker.refreshLatestSummary(
			undefined /* proposalHandle */,
			refreshSummaryResult,
			parseNothing,
		);
		assert.strictEqual(
			summaryStateTracker.updatedDSCountSinceLastSummary,
			0,
			"Updated DS count should be reset after refresh latest summary",
		);
	});
});
