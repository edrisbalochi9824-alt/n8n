import { mock } from 'jest-mock-extended';
import type {
	IDataObject,
	IRunExecutionData,
	IWorkflowExecuteAdditionalData,
	Response,
	WorkflowExecuteMode,
} from 'n8n-workflow';
import { ApplicationError } from 'n8n-workflow';

import { NodeTypes } from '@test/helpers';

import { DirectedGraph } from '../partial-execution-utils';
import { createNodeData, toITaskData } from '../partial-execution-utils/__tests__/helpers';
import { WorkflowExecute } from '../workflow-execute';
import {
	types,
	nodeTypes,
	passThroughNode,
	nodeTypeArguments,
	modifyNode,
} from './mock-node-types';

describe('processRunExecutionData', () => {
	const runHook = jest.fn().mockResolvedValue(undefined);
	const additionalData = mock<IWorkflowExecuteAdditionalData>({
		hooks: { runHook },
		restartExecutionId: undefined,
	});
	const executionMode: WorkflowExecuteMode = 'trigger';

	beforeEach(() => {
		jest.resetAllMocks();
	});

	test('throws if execution-data is missing', () => {
		// ARRANGE
		const node = createNodeData({ name: 'passThrough', type: types.passThrough });
		const workflow = new DirectedGraph()
			.addNodes(node)
			.toWorkflow({ name: '', active: false, nodeTypes, settings: { executionOrder: 'v1' } });

		const executionData: IRunExecutionData = {
			startData: { startNodes: [{ name: node.name, sourceData: null }] },
			resultData: { runData: {} },
		};

		const workflowExecute = new WorkflowExecute(additionalData, executionMode, executionData);

		// ACT & ASSERT
		// The function returns a Promise, but throws synchronously, so we can't await it.
		// eslint-disable-next-line @typescript-eslint/promise-function-async
		expect(() => workflowExecute.processRunExecutionData(workflow)).toThrowError(
			new ApplicationError('Failed to run workflow due to missing execution data'),
		);
	});

	test('returns input data verbatim', async () => {
		// ARRANGE
		const node = createNodeData({ name: 'node', type: types.passThrough });
		const workflow = new DirectedGraph()
			.addNodes(node)
			.toWorkflow({ name: '', active: false, nodeTypes, settings: { executionOrder: 'v1' } });

		const taskDataConnection = { main: [[{ json: { foo: 1 } }]] };
		const executionData: IRunExecutionData = {
			startData: { startNodes: [{ name: node.name, sourceData: null }] },
			resultData: { runData: {} },
			executionData: {
				contextData: {},
				nodeExecutionStack: [{ data: taskDataConnection, node, source: null }],
				metadata: {},
				waitingExecution: {},
				waitingExecutionSource: {},
			},
		};

		const workflowExecute = new WorkflowExecute(additionalData, executionMode, executionData);

		// ACT
		const result = await workflowExecute.processRunExecutionData(workflow);

		// ASSERT
		expect(result.data.resultData.runData).toMatchObject({ node: [{ data: taskDataConnection }] });
	});

	test('calls the right hooks in the right order', async () => {
		// ARRANGE
		const node1 = createNodeData({ name: 'node1', type: types.passThrough });
		const node2 = createNodeData({ name: 'node2', type: types.passThrough });
		const workflow = new DirectedGraph()
			.addNodes(node1, node2)
			.addConnections({ from: node1, to: node2 })
			.toWorkflow({ name: '', active: false, nodeTypes, settings: { executionOrder: 'v1' } });

		const taskDataConnection = { main: [[{ json: { foo: 1 } }]] };
		const executionData: IRunExecutionData = {
			startData: { startNodes: [{ name: node1.name, sourceData: null }] },
			resultData: { runData: {} },
			executionData: {
				contextData: {},
				nodeExecutionStack: [{ data: taskDataConnection, node: node1, source: null }],
				metadata: {},
				waitingExecution: {},
				waitingExecutionSource: {},
			},
		};

		const workflowExecute = new WorkflowExecute(additionalData, executionMode, executionData);

		// ACT
		await workflowExecute.processRunExecutionData(workflow);

		// ASSERT
		expect(runHook).toHaveBeenCalledTimes(6);
		expect(runHook).toHaveBeenNthCalledWith(1, 'workflowExecuteBefore', expect.any(Array));
		expect(runHook).toHaveBeenNthCalledWith(2, 'nodeExecuteBefore', expect.any(Array));
		expect(runHook).toHaveBeenNthCalledWith(3, 'nodeExecuteAfter', expect.any(Array));
		expect(runHook).toHaveBeenNthCalledWith(4, 'nodeExecuteBefore', expect.any(Array));
		expect(runHook).toHaveBeenNthCalledWith(5, 'nodeExecuteAfter', expect.any(Array));
		expect(runHook).toHaveBeenNthCalledWith(6, 'workflowExecuteAfter', expect.any(Array));
	});

	describe('runExecutionData.waitTill', () => {
		test('handles waiting state properly when waitTill is set', async () => {
			// ARRANGE
			const node = createNodeData({ name: 'waitingNode', type: types.passThrough });
			const workflow = new DirectedGraph()
				.addNodes(node)
				.toWorkflow({ name: '', active: false, nodeTypes, settings: { executionOrder: 'v1' } });

			const data: IDataObject = { foo: 1 };
			const executionData: IRunExecutionData = {
				startData: { startNodes: [{ name: node.name, sourceData: null }] },
				resultData: {
					runData: { waitingNode: [toITaskData([{ data }], { executionStatus: 'waiting' })] },
					lastNodeExecuted: 'waitingNode',
				},
				executionData: {
					contextData: {},
					nodeExecutionStack: [{ data: { main: [[{ json: data }]] }, node, source: null }],
					metadata: {},
					waitingExecution: {},
					waitingExecutionSource: {},
				},
				waitTill: new Date('2024-01-01'),
			};

			const workflowExecute = new WorkflowExecute(additionalData, executionMode, executionData);

			// ACT
			const result = await workflowExecute.processRunExecutionData(workflow);

			// ASSERT
			expect(result.waitTill).toBeUndefined();
			// The waiting state handler should have removed the last entry from
			// runData, but execution adds a new one, so we should have 1 entry.
			expect(result.data.resultData.runData.waitingNode).toHaveLength(1);
			// the status was `waiting` before
			expect(result.data.resultData.runData.waitingNode[0].executionStatus).toEqual('success');
		});
	});

	describe('workflow issues', () => {
		test('throws if workflow contains nodes with missing required properties', () => {
			// ARRANGE
			const node = createNodeData({ name: 'node', type: types.testNodeWithRequiredProperty });
			const workflow = new DirectedGraph()
				.addNodes(node)
				.toWorkflow({ name: '', active: false, nodeTypes, settings: { executionOrder: 'v1' } });

			const taskDataConnection = { main: [[{ json: { foo: 1 } }]] };
			const executionData: IRunExecutionData = {
				startData: { startNodes: [{ name: node.name, sourceData: null }] },
				resultData: { runData: {} },
				executionData: {
					contextData: {},
					nodeExecutionStack: [{ data: taskDataConnection, node, source: null }],
					metadata: {},
					waitingExecution: {},
					waitingExecutionSource: {},
				},
			};

			const workflowExecute = new WorkflowExecute(additionalData, executionMode, executionData);

			// ACT & ASSERT
			// The function returns a Promise, but throws synchronously, so we can't await it.
			// eslint-disable-next-line @typescript-eslint/promise-function-async
			expect(() => workflowExecute.processRunExecutionData(workflow)).toThrowError(
				new ApplicationError(
					'The workflow has issues and cannot be executed for that reason. Please fix them first.',
				),
			);
		});

		test('does not complain about nodes with issue past the destination node', async () => {
			// ARRANGE
			const node1 = createNodeData({ name: 'node1', type: types.passThrough });
			const node2 = createNodeData({ name: 'node2', type: types.testNodeWithRequiredProperty });
			const workflow = new DirectedGraph()
				.addNodes(node1, node2)
				.addConnection({ from: node1, to: node2 })
				.toWorkflow({ name: '', active: false, nodeTypes, settings: { executionOrder: 'v1' } });

			const taskDataConnection = { main: [[{ json: { foo: 1 } }]] };
			const executionData: IRunExecutionData = {
				startData: {
					startNodes: [{ name: node1.name, sourceData: null }],
					destinationNode: node1.name,
				},
				resultData: { runData: {} },
				executionData: {
					contextData: {},
					nodeExecutionStack: [{ data: taskDataConnection, node: node1, source: null }],
					metadata: {},
					waitingExecution: {},
					waitingExecutionSource: {},
				},
			};

			const workflowExecute = new WorkflowExecute(additionalData, executionMode, executionData);

			// ACT & ASSERT
			// The function returns a Promise, but throws synchronously, so we can't await it.
			// eslint-disable-next-line @typescript-eslint/promise-function-async
			expect(() => workflowExecute.processRunExecutionData(workflow)).not.toThrowError();
		});
	});

	describe('waiting tools', () => {
		test('handles Request objects with actions correctly', async () => {
			// ARRANGE
			let response: Response | undefined;

			const tool1Node = createNodeData({ name: 'tool1', type: types.passThrough });
			const tool2Node = createNodeData({ name: 'tool2', type: types.passThrough });
			const tool1Input = { query: 'test input' };
			const tool2Input = { data: 'another input' };
			const nodeTypeWithRequests = modifyNode(passThroughNode)
				.return({
					actions: [
						{
							actionType: 'ExecutionNodeAction',
							nodeName: tool1Node.name,
							input: tool1Input,
							type: 'ai_tool',
							id: 'action_1',
							metadata: {},
						},
						{
							actionType: 'ExecutionNodeAction',
							nodeName: tool2Node.name,
							input: tool2Input,
							type: 'ai_tool',
							id: 'action_2',
							metadata: {},
						},
					],
					metadata: { requestId: 'test_request' },
				})
				.return((response_) => {
					response = response_;
					return [[{ json: { finalResult: 'Agent completed with tool results' } }]];
				})
				.done();
			const nodeWithRequests = createNodeData({
				name: 'nodeWithRequests',
				type: 'nodeWithRequests',
			});

			const nodeTypes = NodeTypes({
				...nodeTypeArguments,
				nodeWithRequests: { type: nodeTypeWithRequests, sourcePath: '' },
			});

			const workflow = new DirectedGraph()
				.addNodes(nodeWithRequests, tool1Node, tool2Node)
				.toWorkflow({ name: '', active: false, nodeTypes, settings: { executionOrder: 'v1' } });

			const taskDataConnection = { main: [[{ json: { prompt: 'test prompt' } }]] };
			const executionData: IRunExecutionData = {
				startData: { startNodes: [{ name: nodeWithRequests.name, sourceData: null }] },
				resultData: { runData: {} },
				executionData: {
					contextData: {},
					nodeExecutionStack: [
						{
							data: taskDataConnection,
							node: nodeWithRequests,
							source: { main: [{ previousNode: 'Start' }] },
						},
					],
					metadata: {},
					waitingExecution: {},
					waitingExecutionSource: {},
				},
			};

			const workflowExecute = new WorkflowExecute(additionalData, executionMode, executionData);

			// ACT
			const result = await workflowExecute.processRunExecutionData(workflow);

			// ASSERT
			// nodeWithRequests has been called with the correct responses
			expect(response?.actionResponses).toHaveLength(2);
			for (const r of response?.actionResponses ?? []) {
				if (r.action.id === 'action_1') {
					const data = r.data.data?.['ai_tool'];
					expect(data).toHaveLength(1); // one run
					expect(data![0]).toHaveLength(1); // one item
					expect(data![0]![0]).toMatchObject({ json: tool1Input });
				}

				if (r.action.id === 'action_2') {
					const data = r.data.data?.['ai_tool'];
					expect(data).toHaveLength(1); // one run
					expect(data![0]).toHaveLength(1); // one item
					expect(data![0]![0]).toMatchObject({ json: tool2Input });
				}
			}

			const runData = result.data.resultData.runData;

			// The agent should have been executed and returned a Request with actions
			expect(runData[nodeWithRequests.name]).toHaveLength(1);
			expect(runData[nodeWithRequests.name][0].metadata?.subNodeExecutionData).toBeDefined();

			// Tool nodes should have been added to runData with inputOverride
			expect(runData[tool1Node.name]).toHaveLength(1);
			expect(runData[tool1Node.name][0].inputOverride).toEqual({
				ai_tool: [[{ json: { query: 'test input', toolCallId: 'action_1' } }]],
			});

			expect(runData[tool2Node.name]).toHaveLength(1);
			expect(runData[tool2Node.name][0].inputOverride).toEqual({
				ai_tool: [[{ json: { data: 'another input', toolCallId: 'action_2' } }]],
			});

			// Tools should have executed successfully
			expect(runData[tool1Node.name][0].data).toBeDefined();
			expect(runData[tool1Node.name][0].executionStatus).toBe('success');
			expect(runData[tool2Node.name][0].data).toBeDefined();
			expect(runData[tool2Node.name][0].executionStatus).toBe('success');

			// Agent should have completed successfully with final result
			expect(runData[nodeWithRequests.name][0].data).toBeDefined();
			expect(runData[nodeWithRequests.name][0].executionStatus).toBe('success');
			const nodeWithRequestsOutput = runData[nodeWithRequests.name][0].data?.main?.[0]?.[0]?.json;
			expect(runData[nodeWithRequests.name][0].data?.main?.[0]?.[0]?.json?.finalResult).toBe(
				'Agent completed with tool results',
			);
			expect(nodeWithRequestsOutput).toMatchObject({
				finalResult: 'Agent completed with tool results',
			});
		});

		test('skips waiting tools processing when parent node cannot be found', async () => {
			// ARRANGE
			// This test simulates the scenario where executionData.source.main[0].previousNode
			// is null/undefined (line 2037-2044 in workflow-execute.ts)
			let response: Response | undefined;

			const tool1Node = createNodeData({ name: 'tool1', type: types.passThrough });
			const tool1Input = { query: 'test input' };
			const nodeTypeWithRequests = modifyNode(passThroughNode)
				.return({
					actions: [
						{
							actionType: 'ExecutionNodeAction',
							nodeName: tool1Node.name,
							input: tool1Input,
							type: 'ai_tool',
							id: 'action_1',
							metadata: {},
						},
					],
					metadata: { requestId: 'test_request' },
				})
				.return((response_) => {
					response = response_;
					return [[{ json: { finalResult: 'Agent completed with tool results' } }]];
				})
				.done();
			const nodeWithRequests = createNodeData({
				name: 'nodeWithRequests',
				type: 'nodeWithRequests',
			});

			const nodeTypes = NodeTypes({
				...nodeTypeArguments,
				nodeWithRequests: { type: nodeTypeWithRequests, sourcePath: '' },
			});

			const workflow = new DirectedGraph()
				.addNodes(nodeWithRequests, tool1Node)
				.toWorkflow({ name: '', active: false, nodeTypes, settings: { executionOrder: 'v1' } });

			const taskDataConnection = { main: [[{ json: { prompt: 'test prompt' } }]] };
			const executionData: IRunExecutionData = {
				startData: { startNodes: [{ name: nodeWithRequests.name, sourceData: null }] },
				resultData: { runData: {} },
				executionData: {
					contextData: {},
					nodeExecutionStack: [
						{
							data: taskDataConnection,
							node: nodeWithRequests,
							// Setting source to null triggers the "Cannot find parent node" condition
							source: null,
						},
					],
					metadata: {},
					waitingExecution: {},
					waitingExecutionSource: {},
				},
			};

			const workflowExecute = new WorkflowExecute(additionalData, executionMode, executionData);

			// ACT
			const result = await workflowExecute.processRunExecutionData(workflow);

			// ASSERT
			const runData = result.data.resultData.runData;

			// When parent node cannot be found (line 2038-2044), the execution loop continues
			// which means the waiting tools processing is skipped entirely:

			// 1. The agent node never gets re-executed with the Response callback
			expect(runData[nodeWithRequests.name]).toBeUndefined();

			// 2. Tool nodes get added to runData with inputOverride but are never actually executed
			expect(runData[tool1Node.name]).toHaveLength(1);
			expect(runData[tool1Node.name][0].inputOverride).toEqual({
				ai_tool: [[{ json: { query: 'test input', toolCallId: 'action_1' } }]],
			});
			// The tool node should not have execution data since it was never run
			expect(runData[tool1Node.name][0].data).toBeUndefined();
			expect(runData[tool1Node.name][0].executionStatus).toBeUndefined();

			// 3. The response callback is never called since the agent's second execution is skipped
			expect(response).toBeUndefined();
		});
	});
});
