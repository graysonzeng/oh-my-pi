export type ToolPolicy = {
	readonlyPlanning: boolean;
	scopedImplementation: boolean;
	readonlyReview: boolean;
	scopedRepair: boolean;
	forbiddenPaths: string[];
	allowedCommands: string[];
};

export class ToolPolicyFactory {
	getPolicyForRole(role: string): ToolPolicy {
		if (role === "planner" || role === "plan_reviewer") {
			return {
				readonlyPlanning: true,
				scopedImplementation: false,
				readonlyReview: true,
				scopedRepair: false,
				forbiddenPaths: [".git", "node_modules", "dist", "build"],
				allowedCommands: ["grep", "glob", "ls", "find", "npm run", "echo"],
			};
		}
		if (role === "implementer") {
			return {
				readonlyPlanning: false,
				scopedImplementation: true,
				readonlyReview: false,
				scopedRepair: false,
				forbiddenPaths: ["package.json", "bun.lock", "Cargo.lock", "lockfiles", "scripts/"],
				allowedCommands: ["npm run test", "bun test", "tsc --noEmit", "biome check"],
			};
		}
		return {
			readonlyPlanning: true,
			scopedImplementation: false,
			readonlyReview: true,
			scopedRepair: false,
			forbiddenPaths: [],
			allowedCommands: [],
		};
	}
}
