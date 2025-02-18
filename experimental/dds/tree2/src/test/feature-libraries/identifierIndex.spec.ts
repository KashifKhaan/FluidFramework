/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import {
	MockFluidDataStoreRuntime,
	MockEmptyDeltaConnection,
	MockStorage,
	validateAssertionError,
} from "@fluidframework/test-runtime-utils";
import {
	ISharedTreeView,
	identifierKeySymbol,
	identifierKey,
	SharedTreeFactory,
} from "../../shared-tree";
import { compareSets } from "../../util";
import { TestTreeProviderLite, initializeTestTree } from "../utils";
import {
	FieldKinds,
	Identifier,
	identifierFieldSchema,
	IdentifierIndex,
	identifierSchema,
	SchemaBuilder,
	identifierFieldSchemaLibrary,
} from "../../feature-libraries";

const builder = new SchemaBuilder("identifier index tests", identifierFieldSchemaLibrary);
const nodeSchema = builder.objectRecursive("node", {
	local: { child: SchemaBuilder.fieldRecursive(FieldKinds.optional, () => nodeSchema) },
	global: [identifierFieldSchema] as const,
});
const nodeSchemaData = builder.intoDocumentSchema(SchemaBuilder.fieldOptional(nodeSchema));

describe("Node Identifier Index", () => {
	let nextId: Identifier = 42;
	beforeEach(() => {
		nextId = 42;
	});
	// All tests should use this function to make their IDs - this makes it easier to change the
	// type of `Identifier` when the IdCompressor is hooked up later, or as the design evolves
	function makeId(): Identifier {
		return nextId++;
	}

	function assertIds(tree: ISharedTreeView, ids: Identifier[]): void {
		assert.equal(tree.identifiedNodes.size, ids.length);
		for (const id of ids) {
			assert(tree.identifiedNodes.has(id));
			const node = tree.identifiedNodes.get(id);
			assert(node !== undefined);
			assert.equal(node[identifierKeySymbol], id);
		}
		assert(compareSets({ a: new Set(tree.identifiedNodes.keys()), b: new Set(ids) }));
	}

	it("can look up a node that was inserted", () => {
		const provider = new TestTreeProviderLite();
		const [tree] = provider.trees;
		const id = makeId();
		initializeTestTree(
			tree,
			{
				type: nodeSchema.name,
				globalFields: {
					[identifierKey]: [{ type: identifierSchema.name, value: id }],
				},
			},
			nodeSchemaData,
		);
		assertIds(tree, [id]);
	});

	it("can look up a deep node that was inserted", () => {
		const provider = new TestTreeProviderLite();
		const [tree] = provider.trees;
		const id = makeId();
		initializeTestTree(
			tree,
			{
				type: nodeSchema.name,
				fields: {
					child: [
						{
							type: nodeSchema.name,
							fields: {
								child: [
									{
										type: nodeSchema.name,
										globalFields: {
											[identifierKey]: [
												{ type: identifierSchema.name, value: id },
											],
										},
									},
								],
							},
						},
					],
				},
			},
			nodeSchemaData,
		);
		assertIds(tree, [id]);
	});

	it("can look up multiple nodes that were inserted at once", () => {
		const provider = new TestTreeProviderLite();
		const [tree] = provider.trees;
		const ids = [makeId(), makeId(), makeId()];
		initializeTestTree(
			tree,
			{
				type: nodeSchema.name,
				globalFields: {
					[identifierKey]: [{ type: identifierSchema.name, value: ids[0] }],
				},
				fields: {
					child: [
						{
							type: nodeSchema.name,
							globalFields: {
								[identifierKey]: [{ type: identifierSchema.name, value: ids[1] }],
							},
							fields: {
								child: [
									{
										type: nodeSchema.name,
										globalFields: {
											[identifierKey]: [
												{ type: identifierSchema.name, value: ids[2] },
											],
										},
									},
								],
							},
						},
					],
				},
			},
			nodeSchemaData,
		);
		assertIds(tree, ids);
	});

	it("can look up multiple nodes that were inserted over time", () => {
		const provider = new TestTreeProviderLite();
		const [tree] = provider.trees;
		const idA = makeId();
		initializeTestTree(
			tree,
			{
				type: nodeSchema.name,
				globalFields: {
					[identifierKey]: [{ type: identifierSchema.name, value: idA }],
				},
			},
			nodeSchemaData,
		);

		const node = tree.identifiedNodes.get(idA);
		assert(node !== undefined);
		const idB = makeId();
		node.child = { [identifierKeySymbol]: idB };
		assertIds(tree, [idA, idB]);
	});

	it("forgets about nodes that are deleted", () => {
		const provider = new TestTreeProviderLite();
		const [tree] = provider.trees;
		initializeTestTree(
			tree,
			{
				type: nodeSchema.name,
				globalFields: {
					[identifierKey]: [{ type: identifierSchema.name, value: makeId() }],
				},
			},
			nodeSchemaData,
		);

		tree.root = undefined;
		assertIds(tree, []);
	});

	it("fails if multiple nodes have the same ID", () => {
		const provider = new TestTreeProviderLite();
		const [tree] = provider.trees;
		const id = makeId();
		assert.throws(
			() =>
				initializeTestTree(
					tree,
					{
						type: nodeSchema.name,
						globalFields: {
							[identifierKey]: [{ type: identifierSchema.name, value: id }],
						},
						fields: {
							child: [
								{
									type: nodeSchema.name,
									globalFields: {
										[identifierKey]: [
											{ type: identifierSchema.name, value: id },
										],
									},
								},
							],
						},
					},
					nodeSchemaData,
				),
			(e) => validateAssertionError(e, "Encountered duplicate node identifier"),
		);
	});

	it("can look up a node that was loaded from summary", async () => {
		const provider = new TestTreeProviderLite();
		const [tree] = provider.trees;
		const id = makeId();
		initializeTestTree(
			tree,
			{
				type: nodeSchema.name,
				globalFields: {
					[identifierKey]: [{ type: identifierSchema.name, value: id }],
				},
			},
			nodeSchemaData,
		);
		provider.processMessages();
		const summary = await tree.summarize();

		const factory = new SharedTreeFactory();
		const tree2 = await factory.load(
			new MockFluidDataStoreRuntime(),
			factory.type,
			{
				deltaConnection: new MockEmptyDeltaConnection(),
				objectStorage: MockStorage.createFromSummary(summary.summary),
			},
			factory.attributes,
		);

		assertIds(tree2, [id]);
	});

	// TODO: this test makes a tree which is out of schema. This should error.
	it("skips nodes which have identifiers, but are not in schema", () => {
		// This is missing the global identifier field on the node
		const builder2 = new SchemaBuilder("identifier index test", identifierFieldSchemaLibrary);
		const nodeSchemaNoIdentifier = builder2.objectRecursive("node", {
			local: {
				child: SchemaBuilder.fieldRecursive(
					FieldKinds.optional,
					() => nodeSchemaNoIdentifier,
				),
			},
		});
		const nodeSchemaDataNoIdentifier = builder2.intoDocumentSchema(
			SchemaBuilder.fieldOptional(nodeSchemaNoIdentifier),
		);

		const provider = new TestTreeProviderLite();
		const [tree] = provider.trees;
		initializeTestTree(
			tree,
			{
				type: nodeSchema.name,
				globalFields: {
					[identifierKey]: [{ type: identifierSchema.name, value: makeId() }],
				},
			},
			nodeSchemaDataNoIdentifier,
		);
		assertIds(tree, []);
	});

	// TODO: this test makes a tree which is out of schema. This should error.
	it("skips nodes which have identifiers of the wrong type", () => {
		const provider = new TestTreeProviderLite();
		const [tree] = provider.trees;
		initializeTestTree(
			tree,
			{
				type: nodeSchema.name,
				globalFields: {
					[identifierKey]: [{ type: identifierSchema.name, value: {} }],
				},
			},
			nodeSchemaData,
		);
		assertIds(tree, []);
	});

	// TODO: this test makes a tree which is out of schema. THis should error.
	it("skips nodes which should have identifiers, but do not", () => {
		// This is policy choice rather than correctness. It could also fail.
		const provider = new TestTreeProviderLite();
		const [tree] = provider.trees;
		initializeTestTree(
			tree,
			{
				type: nodeSchema.name,
				globalFields: {
					[identifierKey]: [{ type: identifierSchema.name }],
				},
			},
			nodeSchemaData,
		);
		assertIds(tree, []);
	});

	it("is disabled if identifier field is not in the global schema", () => {
		const builder2 = new SchemaBuilder("identifier index test");
		const nodeSchemaNoIdentifier = builder2.objectRecursive("node", {
			local: {
				child: SchemaBuilder.fieldRecursive(
					FieldKinds.optional,
					() => nodeSchemaNoIdentifier,
				),
			},
		});
		// This is missing the global identifier field
		const nodeSchemaDataNoIdentifier = builder2.intoDocumentSchema(
			SchemaBuilder.fieldOptional(nodeSchemaNoIdentifier),
		);
		assert(!nodeSchemaDataNoIdentifier.globalFieldSchema.has(identifierFieldSchema.key));

		const provider = new TestTreeProviderLite();
		const [tree] = provider.trees;
		initializeTestTree(
			tree,
			{
				type: nodeSchema.name,
				globalFields: {
					[identifierKey]: [{ type: identifierSchema.name, value: makeId() }],
				},
			},
			nodeSchemaDataNoIdentifier,
		);
		assertIds(tree, []);
		const index = tree.identifiedNodes as IdentifierIndex<typeof identifierKey>;
		assert(!index.identifiersAreInSchema(tree.context.schema));
	});

	it("respects extra global fields", () => {
		// This is missing the global identifier field on the node, but has "extra global fields" enabled
		const builder2 = new SchemaBuilder("identifier index test", identifierFieldSchemaLibrary);
		const nodeSchemaNoIdentifier = builder2.objectRecursive("node", {
			local: {
				child: SchemaBuilder.fieldRecursive(
					FieldKinds.optional,
					() => nodeSchemaNoIdentifier,
				),
			},
			extraGlobalFields: true,
		});
		const nodeSchemaDataNoIdentifier = builder2.intoDocumentSchema(
			SchemaBuilder.fieldOptional(nodeSchemaNoIdentifier),
		);

		const provider = new TestTreeProviderLite();
		const [tree] = provider.trees;
		const id = makeId();
		initializeTestTree(
			tree,
			{
				type: nodeSchema.name,
				globalFields: {
					[identifierKey]: [{ type: identifierSchema.name, value: id }],
				},
			},
			nodeSchemaDataNoIdentifier,
		);
		assertIds(tree, [id]);
	});

	it("is synchronized after each batch update", () => {
		const provider = new TestTreeProviderLite();
		const [tree] = provider.trees;

		const id = makeId();
		let expectedIds: Identifier[] = [id];
		let batches = 0;
		tree.events.on("afterBatch", () => {
			assertIds(tree, expectedIds);
			batches += 1;
		});

		initializeTestTree(
			tree,
			{
				type: nodeSchema.name,
				globalFields: {
					[identifierKey]: [{ type: identifierSchema.name, value: id }],
				},
			},
			nodeSchemaData,
		);

		expectedIds = [];
		tree.root = undefined;
		assert.equal(batches, 2);
	});

	// TODO: Schema changes are not yet fully hooked up to eventing. A schema change should probably trigger
	it.skip("reacts to schema changes", () => {
		// This is missing the global identifier field on the node
		const builder2 = new SchemaBuilder("identifier index test", identifierFieldSchemaLibrary);
		const nodeSchemaNoIdentifier = builder2.objectRecursive("node", {
			local: {
				child: SchemaBuilder.fieldRecursive(
					FieldKinds.optional,
					() => nodeSchemaNoIdentifier,
				),
			},
		});
		const nodeSchemaDataNoIdentifier = builder2.intoDocumentSchema(
			SchemaBuilder.fieldOptional(nodeSchemaNoIdentifier),
		);

		const provider = new TestTreeProviderLite();
		const [tree] = provider.trees;
		const id = makeId();
		initializeTestTree(
			tree,
			{
				type: nodeSchema.name,
				globalFields: {
					[identifierKey]: [{ type: identifierSchema.name, value: id }],
				},
			},
			nodeSchemaData,
		);
		assertIds(tree, [id]);
		tree.storedSchema.update(nodeSchemaDataNoIdentifier);
		assertIds(tree, []);
		tree.storedSchema.update(nodeSchemaData);
		assertIds(tree, [id]);
	});

	function describeForkingTests(prefork: boolean): void {
		function getTree(): ISharedTreeView {
			const provider = new TestTreeProviderLite();
			const [tree] = provider.trees;
			return prefork ? tree.fork() : tree;
		}
		describe(`forking from ${prefork ? "a fork" : "the root"}`, () => {
			it("does not mutate the base when mutating a fork", () => {
				const tree = getTree();
				const id = makeId();
				initializeTestTree(
					tree,
					{
						type: nodeSchema.name,
						globalFields: {
							[identifierKey]: [{ type: identifierSchema.name, value: id }],
						},
					},
					nodeSchemaData,
				);

				const fork = tree.fork();
				fork.root = undefined;
				assertIds(tree, [id]);
				assertIds(fork, []);
				tree.merge(fork);
				assertIds(tree, []);
			});

			it("does not mutate the fork when mutating a base", () => {
				const tree = getTree();
				const id = makeId();
				initializeTestTree(
					tree,
					{
						type: nodeSchema.name,
						globalFields: {
							[identifierKey]: [{ type: identifierSchema.name, value: id }],
						},
					},
					nodeSchemaData,
				);

				const fork = tree.fork();
				tree.root = undefined;
				assertIds(tree, []);
				assertIds(fork, [id]);
				tree.merge(fork);
				assertIds(tree, []);
			});
		});
	}

	describeForkingTests(false);
	describeForkingTests(true);
});
