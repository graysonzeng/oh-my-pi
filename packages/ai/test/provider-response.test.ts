import { describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, ProviderResponseMetadata } from "@oh-my-pi/pi-ai/types";
import { normalizeProviderResponse, notifyProviderResponse } from "@oh-my-pi/pi-ai/utils/provider-response";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

describe("provider response metadata", () => {
	it("normalizes response status, headers, and request id", () => {
		const response = new Response(null, {
			status: 202,
			headers: {
				"X-Request-ID": "req_123",
				"X-RateLimit-Remaining": "42",
			},
		});

		expect(normalizeProviderResponse(response, "req_123")).toEqual({
			status: 202,
			headers: {
				"x-request-id": "req_123",
				"x-ratelimit-remaining": "42",
			},
			requestId: "req_123",
		});
	});

	it("invokes the response callback with normalized metadata", async () => {
		const seen: Array<{ response: ProviderResponseMetadata; model: Model | undefined }> = [];
		const model = { provider: "openai", api: "openai-responses", id: "gpt-test" } as Model;

		await notifyProviderResponse(
			{
				onResponse: (response, responseModel) => {
					seen.push({ response, model: responseModel });
				},
			},
			new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }),
			model,
			null,
			{ attempt: 1 },
		);

		expect(seen).toEqual([
			{
				response: {
					status: 204,
					headers: { "cache-control": "no-store" },
					requestId: null,
					metadata: { attempt: 1 },
				},
				model,
			},
		]);
	});
});

function createSseResponse(events: unknown[], headers: Record<string, string> = {}): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream", ...headers },
	});
}

describe("streamSimple onResponse propagation", () => {
	it("invokes onResponse for the default openai-completions path through streamSimple", async () => {
		const model: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
		};

		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
				createSseResponse(
					[
						{
							id: "chatcmpl-onresponse",
							object: "chat.completion.chunk",
							created: 0,
							model: "served-chat-model",
							provider: "upstream-provider",
							choices: [{ index: 0, delta: { content: "ok" } }],
						},
						{
							id: "chatcmpl-onresponse",
							object: "chat.completion.chunk",
							created: 0,
							model: "served-chat-model",
							provider: "upstream-provider",
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						},
						"[DONE]",
					],
					{ "x-request-id": "req_stream_simple" },
				),
			{ preconnect: fetch.preconnect },
		);

		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
		const seen: ProviderResponseMetadata[] = [];
		const result = await streamSimple(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			onResponse: response => {
				seen.push(response);
			},
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.status).toBe(200);
		expect(seen[0]?.headers["x-request-id"]).toBe("req_stream_simple");
		expect(seen[0]?.metadata).toEqual({ model: "served-chat-model", upstreamProvider: "upstream-provider" });
	});

	it("propagates the Anthropic message_start model as provider response metadata", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">;
		const frames = [
			{ event: "ping", data: { type: "ping" } },
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: {
						id: "msg_onresponse",
						type: "message",
						role: "assistant",
						model: "served-anthropic-model",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 1, output_tokens: 0 },
					},
				},
			},
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{
				event: "message_delta",
				data: {
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 1 },
				},
			},
			{ event: "message_stop", data: { type: "message_stop" } },
		];
		const fetchMock: FetchImpl = Object.assign(
			async () =>
				new Response(
					frames.map(frame => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join(""),
					{
						status: 200,
						headers: { "content-type": "text/event-stream", "request-id": "req_anthropic_body" },
					},
				),
			{ preconnect: fetch.preconnect },
		);
		const seen: ProviderResponseMetadata[] = [];
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				fetch: fetchMock,
				onResponse: response => {
					seen.push(response);
				},
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.headers["request-id"]).toBe("req_anthropic_body");
		expect(seen[0]?.metadata).toEqual({ model: "served-anthropic-model" });
	});

	it("propagates the OpenAI response envelope model as provider response metadata", async () => {
		const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
		const responseId = "resp_onresponse";
		const servedModel = "served-responses-model";
		const fetchMock: FetchImpl = Object.assign(
			async () =>
				createSseResponse(
					[
						{ type: "response.created", response: { id: responseId, status: "in_progress" } },
						{
							type: "response.output_item.added",
							item: {
								type: "message",
								id: "msg_onresponse",
								role: "assistant",
								status: "in_progress",
								content: [],
							},
						},
						{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
						{ type: "response.output_text.delta", delta: "ok" },
						{
							type: "response.output_item.done",
							item: {
								type: "message",
								id: "msg_onresponse",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "ok" }],
							},
						},
						{
							type: "response.completed",
							response: {
								id: responseId,
								status: "completed",
								model: servedModel,
								checkpoint: "checkpoint-terminal",
								usage: {
									input_tokens: 1,
									output_tokens: 1,
									total_tokens: 2,
									input_tokens_details: { cached_tokens: 0 },
								},
							},
						},
					],
					{ "x-request-id": "req_responses_body" },
				),
			{ preconnect: fetch.preconnect },
		);
		const seen: ProviderResponseMetadata[] = [];
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				fetch: fetchMock,
				onResponse: response => {
					seen.push(response);
				},
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.headers["x-request-id"]).toBe("req_responses_body");
		expect(seen[0]?.metadata).toEqual({ model: servedModel, checkpoint: "checkpoint-terminal" });
	});
	it("rejects conflicting Responses identity envelopes and notifies once", async () => {
		const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
		const fetchMock: FetchImpl = Object.assign(
			async () =>
				createSseResponse(
					[
						{ type: "response.created", response: { id: "resp_conflict", model: "served-model-a" } },
						{
							type: "response.completed",
							response: {
								id: "resp_conflict",
								status: "completed",
								model: "served-model-b",
								usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
							},
						},
					],
					{ "x-request-id": "req_responses_conflict" },
				),
			{ preconnect: fetch.preconnect },
		);
		const seen: ProviderResponseMetadata[] = [];
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				fetch: fetchMock,
				onResponse: response => {
					seen.push(response);
				},
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Conflicting OpenAI Responses model identity coordinates");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.headers["x-request-id"]).toBe("req_responses_conflict");
		expect(seen[0]?.metadata).toBeUndefined();
	});

	it("does not couple a slow response callback to the first-event watchdog", async () => {
		const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
		const servedModel = "served-watchdog-model";
		const fetchMock: FetchImpl = Object.assign(
			async () =>
				createSseResponse([
					{ type: "response.created", response: { id: "resp_watchdog", model: servedModel } },
					{
						type: "response.output_item.added",
						item: { type: "message", id: "msg_watchdog", role: "assistant", status: "in_progress", content: [] },
					},
					{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", delta: "ok" },
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_watchdog",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "ok" }],
						},
					},
					{
						type: "response.completed",
						response: {
							id: "resp_watchdog",
							status: "completed",
							model: servedModel,
							usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
						},
					},
				]),
			{ preconnect: fetch.preconnect },
		);
		const seen: ProviderResponseMetadata[] = [];
		const callbackEntered = Promise.withResolvers<void>();
		const releaseCallback = Promise.withResolvers<void>();
		vi.useFakeTimers();
		try {
			const resultPromise = streamSimple(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
				{
					apiKey: "test-key",
					fetch: fetchMock,
					streamFirstEventTimeoutMs: 10,
					streamIdleTimeoutMs: 1000,
					onResponse: async response => {
						callbackEntered.resolve();
						await releaseCallback.promise;
						seen.push(response);
					},
				},
			).result();
			await callbackEntered.promise;
			vi.advanceTimersByTime(25);
			releaseCallback.resolve();
			const result = await resultPromise;

			expect(result.stopReason).toBe("stop");
			expect(seen).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
