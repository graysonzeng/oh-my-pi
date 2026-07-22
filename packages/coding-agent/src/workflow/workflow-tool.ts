import { WorkflowEngine } from "./engine";

export const workflowTool = {
	name: "workflow",
	description: "Multi-model coding workflow engine: planning, review, implementation, verification, repair.",
	parameters: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["start", "run_stage", "complete_attempt", "get_state", "repair"] },
			workflowId: { type: "string" },
			stage: { type: "string" },
			input: { type: "object" },
		},
		required: ["action"],
	},
	async execute(args: any) {
		const engine = new WorkflowEngine();
		switch (args.action) {
			case "start":
				return await engine.startWorkflow(args.input.request, args.input.policy);
			// other actions delegated
			default:
				throw new Error("Unknown action");
		}
	},
};
