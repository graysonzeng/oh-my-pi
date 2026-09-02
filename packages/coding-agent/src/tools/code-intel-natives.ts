/**
 * Optional natives surface for code-intel. A binary older than this
 * checkout is missing the symbols; queries then skip graph/chunk layers
 * instead of throwing.
 */
import * as natives from "@oh-my-pi/pi-natives";

export interface CodeIntelTag {
	path: string;
	name: string;
	kind: "def" | "ref";
	grammar: string;
	startLine: number;
	endLine: number;
}

export interface CodeIntelRankedNode {
	path: string;
	symbol: string;
	score: number;
	startLine: number;
	endLine: number;
	contentHash?: string;
}

export interface CodeIntelChunk {
	startLine: number;
	endLine: number;
	symbol: string;
	kind: string;
	text: string;
}

export interface CodeIntelCall {
	path: string;
	callee: string;
	startLine: number;
	endLine: number;
}

export interface CodeIntelBuildResult {
	filesScanned: number;
	tagCount: number;
	chunkCount: number;
	parseErrors: string[];
}

export interface CodeIntelBuildOptions {
	root: string;
	destDir: string;
	hidden?: boolean;
	gitignore?: boolean;
	maxFiles?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface CodeIntelRankOptions {
	generationDir: string;
	seedPaths?: string[];
	seedSymbols?: string[];
	topFiles?: number;
	topSymbols?: number;
}

export interface CodeIntelExtractOptions {
	root: string;
	hidden?: boolean;
	gitignore?: boolean;
	maxFiles?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface CodeIntelExtractResult {
	tags: CodeIntelTag[];
	calls: CodeIntelCall[];
	filesScanned: number;
	parseErrors: string[];
}

type NativesSurface = typeof natives & {
	codeIntelBuildGeneration?: (options: CodeIntelBuildOptions) => Promise<CodeIntelBuildResult>;
	codeIntelRankGeneration?: (options: CodeIntelRankOptions) => CodeIntelRankedNode[];
	codeIntelExtractTags?: (options: CodeIntelExtractOptions) => Promise<CodeIntelExtractResult>;
	codeIntelChunkFile?: (options: { path: string; content: string }) => CodeIntelChunk[];
	codeIntelExtractCalls?: (options: { path: string; content: string }) => CodeIntelCall[];
};

const surface = natives as NativesSurface;

export const NATIVE_CODE_INTEL_MISSING = "native code_intel symbol missing; restart omp after upgrade";

export function hasCodeIntelNatives(): boolean {
	return (
		typeof surface.codeIntelBuildGeneration === "function" && typeof surface.codeIntelRankGeneration === "function"
	);
}

export function codeIntelBuildGeneration(options: CodeIntelBuildOptions): Promise<CodeIntelBuildResult> {
	if (!surface.codeIntelBuildGeneration) {
		return Promise.reject(new Error(NATIVE_CODE_INTEL_MISSING));
	}
	return surface.codeIntelBuildGeneration(options);
}

export function codeIntelRankGeneration(options: CodeIntelRankOptions): CodeIntelRankedNode[] {
	if (!surface.codeIntelRankGeneration) return [];
	return surface.codeIntelRankGeneration(options);
}

export function codeIntelExtractTags(options: CodeIntelExtractOptions): Promise<CodeIntelExtractResult> {
	if (!surface.codeIntelExtractTags) {
		return Promise.resolve({ tags: [], calls: [], filesScanned: 0, parseErrors: [] });
	}
	return surface.codeIntelExtractTags(options);
}

export function codeIntelExtractCalls(options: { path: string; content: string }): CodeIntelCall[] {
	if (!surface.codeIntelExtractCalls) return [];
	return surface.codeIntelExtractCalls(options);
}

export function codeIntelChunkFile(options: { path: string; content: string }): CodeIntelChunk[] {
	if (!surface.codeIntelChunkFile) return [];
	return surface.codeIntelChunkFile(options);
}
